import type { IAccount } from "applesauce-accounts";
import type { Filter } from "applesauce-core/helpers";
import { onlyEvents } from "applesauce-relay";
import type { NostrEvent } from "nostr-tools";
import { verifyEvent } from "nostr-tools";
import { BehaviorSubject, Subscription, debounceTime } from "rxjs";

import {
  createPrivateGitRelayListEvent,
  GLOBAL_VANISH_KIND,
  normalizePrivateGitRelayUrls,
  PRIVATE_GIT_RELAY_LIST_KIND,
  privateGitRelayListTimestampFloor,
  selectPrivateGitRelayList,
  type DecodedPrivateGitRelayList,
} from "@/lib/private-git-relays";
import { resilientSubscription } from "@/lib/resilientSubscription";
import { requestRelaySnapshot } from "@/lib/relaySnapshot";
import { clearGitHttpAuthorizationProviders } from "@/lib/git-http-auth";
import { clearPrivateGraspVerificationCache } from "@/lib/private-grasp";
import { normalizeUrl } from "@/lib/url";
import { eventStore, pool } from "@/services/nostr";
import {
  clearPrivateRepositoryScope,
  installPrivateServiceRelays,
} from "@/services/privateRepositoryScope";
import {
  clearPrivateGitObjectCache,
  clearPrivateRegistry,
} from "@/lib/git-grasp-pool";

const SNAPSHOT_TIMEOUT_MS = 8_000;
const MAX_MERGE_ATTEMPTS = 3;

export type PrivateGitRelayListStatus =
  | "logged-out"
  | "loading"
  | "ready"
  | "unavailable";

export interface PrivateGitRelayListState {
  generation: number;
  pubkey?: string;
  status: PrivateGitRelayListStatus;
  relayUrls: string[];
  sourceEvent?: NostrEvent;
  error?: string;
}

interface PrivateGitRelaySession {
  generation: number;
  account: IAccount;
  identityRelays: string[];
  writeRelays: string[];
  stopped: boolean;
}

interface PrivateGitRelaySnapshot {
  candidates: NostrEvent[];
  deletions: NostrEvent[];
  vanishes: NostrEvent[];
  selected?: DecodedPrivateGitRelayList;
}

export const privateGitRelayList$ =
  new BehaviorSubject<PrivateGitRelayListState>({
    generation: 0,
    status: "logged-out",
    relayUrls: [],
  });

let generation = 0;
let activeSession: PrivateGitRelaySession | undefined;
let activeSubscription: Subscription | undefined;
const accountWrites = new Map<string, Promise<void>>();

function uniqueRelays(relays: readonly string[]): string[] {
  return [...new Set(relays.map(normalizeUrl))].sort();
}

function assertCurrentSession(session: PrivateGitRelaySession): void {
  if (
    session.stopped ||
    activeSession !== session ||
    privateGitRelayList$.getValue().generation !== session.generation
  ) {
    throw new Error(
      "The active account changed during the private-list update",
    );
  }
}

async function requestRelayEvents(
  relay: string,
  filters: Filter[],
): Promise<NostrEvent[]> {
  const snapshot = await requestRelaySnapshot(
    pool,
    relay,
    filters,
    SNAPSHOT_TIMEOUT_MS,
  );
  if (!snapshot.complete) {
    throw new Error(
      `Private-list relay ${relay} did not complete its response safely`,
    );
  }
  return snapshot.events;
}

function deduplicateVerified(events: Iterable<NostrEvent>): NostrEvent[] {
  const byId = new Map<string, NostrEvent>();
  for (const event of events) {
    if (verifyEvent(event)) byId.set(event.id, event);
  }
  return [...byId.values()];
}

export async function requestPrivateGitRelaySnapshot(
  session: PrivateGitRelaySession,
): Promise<PrivateGitRelaySnapshot> {
  assertCurrentSession(session);
  if (session.identityRelays.length === 0) {
    throw new Error(
      "No identity relays are available for private-list discovery",
    );
  }

  const initial = (
    await Promise.all(
      session.identityRelays.map((relay) =>
        requestRelayEvents(relay, [
          {
            kinds: [PRIVATE_GIT_RELAY_LIST_KIND],
            authors: [session.account.pubkey],
            limit: 10,
          } as Filter,
          {
            kinds: [GLOBAL_VANISH_KIND],
            authors: [session.account.pubkey],
            limit: 10,
          } as Filter,
        ]),
      ),
    )
  ).flat();
  assertCurrentSession(session);

  const candidates = deduplicateVerified(
    initial.filter((event) => event.kind === PRIVATE_GIT_RELAY_LIST_KIND),
  );
  const vanishes = deduplicateVerified(
    initial.filter((event) => event.kind === GLOBAL_VANISH_KIND),
  );
  const candidateIds = candidates.map((event) => event.id);
  const deletions =
    candidateIds.length === 0
      ? []
      : deduplicateVerified(
          (
            await Promise.all(
              session.identityRelays.map((relay) =>
                requestRelayEvents(relay, [
                  {
                    kinds: [5],
                    authors: [session.account.pubkey],
                    "#e": candidateIds,
                  } as Filter,
                ]),
              ),
            )
          ).flat(),
        );
  assertCurrentSession(session);

  const selected = await selectPrivateGitRelayList(
    candidates,
    session.account.pubkey,
    session.account.signer,
    { deletions, vanishes },
  );
  assertCurrentSession(session);
  return { candidates, deletions, vanishes, selected };
}

function installSnapshot(
  session: PrivateGitRelaySession,
  snapshot: PrivateGitRelaySnapshot,
): void {
  assertCurrentSession(session);
  const removedRelays = installPrivateServiceRelays(
    session.account.id,
    session.account.pubkey,
    session.generation,
    snapshot.selected?.relayUrls ?? [],
  );
  for (const relay of removedRelays) pool.remove(relay);
  if (removedRelays.length > 0) {
    clearPrivateRegistry(session.account.pubkey);
    clearPrivateGitObjectCache(session.account.pubkey);
    clearGitHttpAuthorizationProviders(session.account.pubkey);
    clearPrivateGraspVerificationCache(session.account.pubkey);
  }
  privateGitRelayList$.next({
    generation: session.generation,
    pubkey: session.account.pubkey,
    status: "ready",
    relayUrls: snapshot.selected?.relayUrls ?? [],
    sourceEvent: snapshot.selected?.event,
  });
}

async function refreshSession(session: PrivateGitRelaySession): Promise<void> {
  try {
    const snapshot = await requestPrivateGitRelaySnapshot(session);
    installSnapshot(session, snapshot);
  } catch (error) {
    if (session.stopped || activeSession !== session) return;
    privateGitRelayList$.next({
      generation: session.generation,
      pubkey: session.account.pubkey,
      status: "unavailable",
      relayUrls: [],
      error:
        error instanceof Error
          ? error.message
          : "The private Git relay list could not be read safely",
    });
  }
}

/** Start an account-scoped private-list session and return its cleanup. */
export function startPrivateGitRelaySession(
  account: IAccount,
  identityRelays: readonly string[],
  writeRelays: readonly string[],
): () => void {
  activeSubscription?.unsubscribe();
  if (activeSession) activeSession.stopped = true;
  const previous = clearPrivateRepositoryScope();
  for (const eventId of previous.eventIds) eventStore.remove(eventId);
  for (const relay of previous.relayUrls) pool.remove(relay);
  if (activeSession) {
    clearPrivateRegistry(activeSession.account.pubkey);
    clearPrivateGitObjectCache(activeSession.account.pubkey);
    clearGitHttpAuthorizationProviders(activeSession.account.pubkey);
    clearPrivateGraspVerificationCache(activeSession.account.pubkey);
  }

  const session: PrivateGitRelaySession = {
    generation: ++generation,
    account,
    identityRelays: uniqueRelays(identityRelays),
    writeRelays: uniqueRelays(writeRelays),
    stopped: false,
  };
  activeSession = session;
  privateGitRelayList$.next({
    generation: session.generation,
    pubkey: account.pubkey,
    status: "loading",
    relayUrls: [],
  });

  void refreshSession(session);

  activeSubscription = resilientSubscription(
    pool,
    session.identityRelays,
    [
      {
        kinds: [PRIVATE_GIT_RELAY_LIST_KIND, 5, GLOBAL_VANISH_KIND],
        authors: [account.pubkey],
      } as Filter,
    ],
    {
      reconnect: true,
      gapFill: true,
      settle: false,
      paginate: false,
      retryCount: Infinity,
    },
  )
    .pipe(onlyEvents(), debounceTime(200))
    .subscribe(() => {
      void refreshSession(session);
    });

  return () => {
    if (activeSession === session) {
      activeSession = undefined;
      activeSubscription?.unsubscribe();
      activeSubscription = undefined;
      const cleared = clearPrivateRepositoryScope();
      for (const eventId of cleared.eventIds) eventStore.remove(eventId);
      for (const relay of cleared.relayUrls) pool.remove(relay);
      clearPrivateRegistry(session.account.pubkey);
      clearPrivateGitObjectCache(session.account.pubkey);
      clearGitHttpAuthorizationProviders(session.account.pubkey);
      clearPrivateGraspVerificationCache(session.account.pubkey);
      privateGitRelayList$.next({
        generation: ++generation,
        status: "logged-out",
        relayUrls: [],
      });
    }
    session.stopped = true;
  };
}

function mergeEditorDelta(
  base: readonly string[],
  next: readonly string[],
  current: readonly string[],
): string[] {
  const normalizedBase = normalizePrivateGitRelayUrls(base);
  const normalizedNext = normalizePrivateGitRelayUrls(next);
  const normalizedCurrent = normalizePrivateGitRelayUrls(current);

  if (normalizedNext.length === 0) {
    const concurrent = normalizedCurrent.filter(
      (relay) => !normalizedBase.includes(relay),
    );
    if (concurrent.length > 0) {
      throw new Error(
        "The private service list changed elsewhere. Review the refreshed list before clearing it.",
      );
    }
    return [];
  }

  const additions = normalizedNext.filter(
    (relay) => !normalizedBase.includes(relay),
  );
  const removals = new Set(
    normalizedBase.filter((relay) => !normalizedNext.includes(relay)),
  );
  return normalizePrivateGitRelayUrls([
    ...normalizedCurrent.filter((relay) => !removals.has(relay)),
    ...additions,
  ]);
}

async function publishPrivateGitRelayList(
  session: PrivateGitRelaySession,
  event: NostrEvent,
): Promise<void> {
  if (session.writeRelays.length === 0) {
    throw new Error("Configure at least one NIP-65 write relay before saving");
  }
  assertCurrentSession(session);
  const responses = await pool.publish(session.writeRelays, event);
  assertCurrentSession(session);

  const accepted = new Set(
    responses
      .filter((response) => response.ok)
      .map((response) => normalizeUrl(response.from)),
  );
  const missing = session.writeRelays.filter((relay) => !accepted.has(relay));
  if (missing.length > 0) {
    throw new Error(
      `The encrypted list may have reached some write relays, but these relays did not confirm it: ${missing.join(", ")}`,
    );
  }
}

async function updatePrivateGitRelayListNow(
  session: PrivateGitRelaySession,
  baseRelayUrls: readonly string[],
  nextRelayUrls: readonly string[],
): Promise<void> {
  for (let attempt = 0; attempt < MAX_MERGE_ATTEMPTS; attempt += 1) {
    const before = await requestPrivateGitRelaySnapshot(session);
    const expectedRelayUrls = mergeEditorDelta(
      baseRelayUrls,
      nextRelayUrls,
      before.selected?.relayUrls ?? [],
    );
    const timestampFloor = privateGitRelayListTimestampFloor(
      before.candidates,
      before.vanishes,
      session.account.pubkey,
    );
    const event = await createPrivateGitRelayListEvent(
      session.account.pubkey,
      session.account.signer,
      expectedRelayUrls,
      timestampFloor,
    );
    assertCurrentSession(session);
    await publishPrivateGitRelayList(session, event);

    const after = await requestPrivateGitRelaySnapshot(session);
    if (
      after.selected?.event.id === event.id &&
      after.selected.relayUrls.length === expectedRelayUrls.length &&
      after.selected.relayUrls.every(
        (relay, index) => relay === expectedRelayUrls[index],
      )
    ) {
      installSnapshot(session, after);
      return;
    }
  }

  throw new Error(
    "The private service list kept changing while it was saved. Review the latest list and try again.",
  );
}

/** Apply an editor delta to the freshest list and confirm the replacement. */
export function updatePrivateGitRelayList(
  generationToUpdate: number,
  baseRelayUrls: readonly string[],
  nextRelayUrls: readonly string[],
): Promise<void> {
  const session = activeSession;
  if (!session || session.generation !== generationToUpdate) {
    return Promise.reject(
      new Error("The active account changed before the private list was saved"),
    );
  }

  const previous =
    accountWrites.get(session.account.pubkey) ?? Promise.resolve();
  const current = previous
    .catch(() => undefined)
    .then(() =>
      updatePrivateGitRelayListNow(session, baseRelayUrls, nextRelayUrls),
    );
  accountWrites.set(session.account.pubkey, current);
  return current.finally(() => {
    if (accountWrites.get(session.account.pubkey) === current) {
      accountWrites.delete(session.account.pubkey);
    }
  });
}
