import type { IAccount } from "applesauce-accounts";
import { getSeenRelays, type Filter } from "applesauce-core/helpers";
import { onlyEvents } from "applesauce-relay";
import type { NostrEvent } from "nostr-tools";
import { verifyEvent } from "nostr-tools";
import { BehaviorSubject, Subscription, debounceTime } from "rxjs";

import {
  createPrivateGitRelayListEvent,
  GLOBAL_VANISH_KIND,
  normalizePrivateGitRelayUrls,
  PRIVATE_GIT_RELAY_LIST_KIND,
  PrivateGitRelayListDecodeError,
  privateGitRelayListTimestampFloor,
  selectPrivateGitRelayList,
  type DecodedPrivateGitRelayList,
} from "@/lib/private-git-relays";
import { resilientSubscription } from "@/lib/resilientSubscription";
import { requestRelaySnapshot } from "@/lib/relaySnapshot";
import { clearGitHttpAuthorizationProviders } from "@/lib/git-http-auth";
import { clearPrivateGraspVerificationCache } from "@/lib/private-grasp";
import { getRepoIsPrivate } from "@/lib/nip34";
import { normalizeUrl } from "@/lib/url";
import { eventStore, pool } from "@/services/nostr";
import {
  beginPrivateRelayTrustSession,
  admitPrivateRepositoryAnnouncement,
  clearPrivateRepositoryScope,
  installPrivateServiceRelays,
} from "@/services/privateRepositoryScope";
import {
  clearPrivateGitObjectCache,
  clearPrivateRegistry,
} from "@/lib/git-grasp-pool";

const SNAPSHOT_TIMEOUT_MS = 8_000;
const MAX_MERGE_ATTEMPTS = 3;
const REFRESH_RETRY_DELAYS_MS = [2_000, 5_000, 15_000, 30_000] as const;

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
  decryptBlocked: boolean;
  retryAttempt: number;
  retryTimer?: ReturnType<typeof setTimeout>;
  refreshInFlight?: Promise<void>;
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

/**
 * Quarantine a repository event when its relay provenance includes one of the
 * active account's private services. Public announcements mirrored there and
 * invalid private announcements return false so callers reject them before
 * EventStore insertion.
 */
export function prepareDiscoveredRepositoryEvent(
  event: NostrEvent,
  privateRelayUrls: readonly string[],
): boolean {
  const seenRelays = new Set(
    [...(getSeenRelays(event) ?? [])].map(normalizeUrl),
  );
  const sourceRelays = privateRelayUrls.filter((relay) =>
    seenRelays.has(normalizeUrl(relay)),
  );
  if (sourceRelays.length === 0) return true;
  if (!getRepoIsPrivate(event)) return false;
  return admitPrivateRepositoryAnnouncement(event, sourceRelays);
}

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
  relays: readonly string[],
  filters: Filter[],
  requireAllRelays: boolean,
): Promise<NostrEvent[]> {
  const snapshots = await Promise.all(
    relays.map(async (relay) => ({
      relay,
      snapshot: await requestRelaySnapshot(
        pool,
        relay,
        filters,
        SNAPSHOT_TIMEOUT_MS,
      ),
    })),
  );
  const completed = snapshots.filter(({ snapshot }) => snapshot.complete);
  const incomplete = snapshots
    .filter(({ snapshot }) => !snapshot.complete)
    .map(({ relay }) => relay);
  if (completed.length === 0) {
    throw new Error(
      `No private-list relay completed its response safely. Unavailable: ${incomplete.join(", ")}`,
    );
  }
  if (requireAllRelays && incomplete.length > 0) {
    throw new Error(
      `Private-list relays did not complete their responses safely: ${incomplete.join(", ")}`,
    );
  }
  return completed.flatMap(({ snapshot }) => snapshot.events);
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
  options: { requireAllRelays?: boolean } = {},
): Promise<PrivateGitRelaySnapshot> {
  assertCurrentSession(session);
  if (session.identityRelays.length === 0) {
    throw new Error(
      "No identity relays are available for private-list discovery",
    );
  }

  const initial = await requestRelayEvents(
    session.identityRelays,
    [
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
    ],
    options.requireAllRelays ?? false,
  );
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
          await requestRelayEvents(
            session.identityRelays,
            [
              {
                kinds: [5],
                authors: [session.account.pubkey],
                "#e": candidateIds,
              } as Filter,
            ],
            options.requireAllRelays ?? false,
          ),
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

function clearRefreshRetry(session: PrivateGitRelaySession): void {
  if (session.retryTimer !== undefined) clearTimeout(session.retryTimer);
  session.retryTimer = undefined;
}

function scheduleRefreshRetry(session: PrivateGitRelaySession): void {
  if (session.stopped || activeSession !== session || session.retryTimer)
    return;
  const delay =
    REFRESH_RETRY_DELAYS_MS[
      Math.min(session.retryAttempt, REFRESH_RETRY_DELAYS_MS.length - 1)
    ];
  session.retryAttempt += 1;
  session.retryTimer = setTimeout(() => {
    session.retryTimer = undefined;
    void refreshSession(session);
  }, delay);
}

async function refreshSession(
  session: PrivateGitRelaySession,
  allowSignerRetry = false,
): Promise<void> {
  if (session.decryptBlocked && !allowSignerRetry) return;
  if (session.refreshInFlight) return session.refreshInFlight;
  if (allowSignerRetry) session.decryptBlocked = false;
  const refresh = (async () => {
    try {
      const snapshot = await requestPrivateGitRelaySnapshot(session);
      installSnapshot(session, snapshot);
      session.decryptBlocked = false;
      session.retryAttempt = 0;
      clearRefreshRetry(session);
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
      if (
        error instanceof PrivateGitRelayListDecodeError &&
        error.failure === "signer"
      ) {
        // A signer rejection or timeout is a user-decision boundary, not a
        // transient relay failure. Replaying the same passive decrypt on the
        // timer or when a relay re-sends the event spams external signers.
        // Leave the existing Retry now control as the explicit recovery path.
        session.decryptBlocked = true;
        clearRefreshRetry(session);
      } else {
        scheduleRefreshRetry(session);
      }
    }
  })().finally(() => {
    if (session.refreshInFlight === refresh)
      session.refreshInFlight = undefined;
  });
  session.refreshInFlight = refresh;
  return refresh;
}

/** Start an account-scoped private-list session and return its cleanup. */
export function startPrivateGitRelaySession(
  account: IAccount,
  identityRelays: readonly string[],
  writeRelays: readonly string[],
): () => void {
  activeSubscription?.unsubscribe();
  if (activeSession) {
    clearRefreshRetry(activeSession);
    activeSession.stopped = true;
  }
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
    decryptBlocked: false,
    retryAttempt: 0,
  };
  activeSession = session;
  beginPrivateRelayTrustSession(account.id, account.pubkey, session.generation);
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
    clearRefreshRetry(session);
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
    const before = await requestPrivateGitRelaySnapshot(session, {
      requireAllRelays: true,
    });
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

    const after = await requestPrivateGitRelaySnapshot(session, {
      requireAllRelays: true,
    });
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

/** Retry an unavailable encrypted-list read for the active account session. */
export function retryPrivateGitRelayList(generationToRetry: number): void {
  const session = activeSession;
  if (!session || session.generation !== generationToRetry || session.stopped) {
    return;
  }
  clearRefreshRetry(session);
  session.decryptBlocked = false;
  session.retryAttempt = 0;
  privateGitRelayList$.next({
    generation: session.generation,
    pubkey: session.account.pubkey,
    status: "loading",
    relayUrls: [],
  });
  void refreshSession(session, true);
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
