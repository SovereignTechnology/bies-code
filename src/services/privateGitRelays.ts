import type { IAccount } from "applesauce-accounts";
import { getSeenRelays } from "applesauce-core/helpers";
import type { NostrEvent } from "nostr-tools";
import { BehaviorSubject, Subscription, merge } from "rxjs";
import { filter } from "rxjs/operators";

import {
  decodePrivateGitRelayListEvent,
  PRIVATE_GIT_RELAY_LIST_KIND,
  PrivateGitRelayListDecodeError,
  verifyPrivateGitRelayListEventSignature,
} from "@/lib/private-git-relays";
import { clearGitHttpAuthorizationProviders } from "@/lib/git-http-auth";
import { clearPrivateGraspVerificationCache } from "@/lib/private-grasp";
import { getRepoIsPrivate } from "@/lib/nip34";
import { normalizeUrl } from "@/lib/url";
import { eventStore, pool } from "@/services/nostr";
import { lookupRelays } from "@/services/settings";
import { userIdentityCoverage } from "@/services/userIdentityCoverage";
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
  outboxRelays: string[];
  stopped: boolean;
  refreshRevision: number;
  observedEventId?: string;
  failedEventId?: string;
  decodeInFlight?: {
    eventId: string;
    promise: Promise<string[]>;
  };
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

function isCurrentSession(session: PrivateGitRelaySession): boolean {
  return !session.stopped && activeSession === session;
}

function clearPrivateRelayCaches(pubkey: string): void {
  clearPrivateRegistry(pubkey);
  clearPrivateGitObjectCache(pubkey);
  clearGitHttpAuthorizationProviders(pubkey);
  clearPrivateGraspVerificationCache(pubkey);
}

function installRelayUrls(
  session: PrivateGitRelaySession,
  relayUrls: readonly string[],
): void {
  if (!isCurrentSession(session)) return;
  const removedRelays = installPrivateServiceRelays(
    session.account.id,
    session.account.pubkey,
    session.generation,
    relayUrls,
  );
  for (const relay of removedRelays) pool.remove(relay);
  if (removedRelays.length > 0) {
    clearPrivateRelayCaches(session.account.pubkey);
  }
}

function decodeCurrentEvent(
  session: PrivateGitRelaySession,
  event: NostrEvent,
): Promise<string[]> {
  if (session.decodeInFlight?.eventId === event.id) {
    return session.decodeInFlight.promise;
  }

  const promise = decodePrivateGitRelayListEvent(
    event,
    session.account.pubkey,
    session.account.signer,
  );
  session.decodeInFlight = { eventId: event.id, promise };
  const clear = () => {
    if (session.decodeInFlight?.promise === promise) {
      session.decodeInFlight = undefined;
    }
  };
  void promise.then(clear, clear);
  return promise;
}

function missingListEvidenceRelays(session: PrivateGitRelaySession): {
  relays: string[];
  source: "outbox" | "lookup";
} {
  if (session.outboxRelays.length > 0) {
    return { relays: session.outboxRelays, source: "outbox" };
  }
  return {
    relays: [...new Set(lookupRelays.getValue().map(normalizeUrl))],
    source: "lookup",
  };
}

/**
 * Decode the current kind:10318 winner already supplied by the shared identity
 * subscription. This service owns only decryption and private-repository scope;
 * it never opens a second relay request for the personal singleton.
 */
async function refreshSession(
  session: PrivateGitRelaySession,
  forceRetry = false,
): Promise<void> {
  if (!isCurrentSession(session)) return;
  const event = eventStore.getReplaceable(
    PRIVATE_GIT_RELAY_LIST_KIND,
    session.account.pubkey,
  );
  if (event?.id !== session.observedEventId) {
    session.observedEventId = event?.id;
    session.failedEventId = undefined;
  }

  if (!event) {
    const coverage = userIdentityCoverage.get(session.account.pubkey);
    const evidence = missingListEvidenceRelays(session);
    if (!coverage) {
      privateGitRelayList$.next({
        generation: session.generation,
        pubkey: session.account.pubkey,
        status: "loading",
        relayUrls: [],
      });
      return;
    }

    const hasUnsettledRelay = evidence.relays.some((relay) => {
      const phase = coverage.get(relay)?.phase;
      return (
        phase === undefined || phase === "initial" || phase === "catching-up"
      );
    });
    if (evidence.relays.length > 0 && hasUnsettledRelay) {
      privateGitRelayList$.next({
        generation: session.generation,
        pubkey: session.account.pubkey,
        status: "loading",
        relayUrls: [],
      });
      return;
    }

    if (evidence.relays.some((relay) => coverage.isCovered(relay))) {
      const projected = privateGitRelayList$.getValue();
      if (
        projected.generation === session.generation &&
        projected.pubkey === session.account.pubkey &&
        projected.status === "ready" &&
        projected.relayUrls.length === 0 &&
        projected.sourceEvent === undefined
      ) {
        return;
      }
      installRelayUrls(session, []);
      privateGitRelayList$.next({
        generation: session.generation,
        pubkey: session.account.pubkey,
        status: "ready",
        relayUrls: [],
      });
      return;
    }

    const sourceLabel = evidence.source === "outbox" ? "outbox" : "lookup";
    privateGitRelayList$.next({
      generation: session.generation,
      pubkey: session.account.pubkey,
      status: "unavailable",
      relayUrls: [],
      error:
        evidence.relays.length === 0
          ? "No outbox or lookup relays are configured to check for your private Git relay list"
          : `None of your ${sourceLabel} relays completed the private Git relay list check`,
    });
    return;
  }

  const projected = privateGitRelayList$.getValue();
  if (
    !forceRetry &&
    projected.generation === session.generation &&
    projected.pubkey === session.account.pubkey &&
    projected.status === "ready" &&
    projected.sourceEvent?.id === event.id
  ) {
    return;
  }

  if (!forceRetry && session.failedEventId === event.id) {
    return;
  }

  const revision = ++session.refreshRevision;

  try {
    const relayUrls = await decodeCurrentEvent(session, event);
    if (!isCurrentSession(session) || revision !== session.refreshRevision) {
      return;
    }
    session.failedEventId = undefined;
    installRelayUrls(session, relayUrls);
    privateGitRelayList$.next({
      generation: session.generation,
      pubkey: session.account.pubkey,
      status: "ready",
      relayUrls,
      sourceEvent: event,
    });
  } catch (error) {
    if (!isCurrentSession(session) || revision !== session.refreshRevision) {
      return;
    }
    const failure =
      error instanceof PrivateGitRelayListDecodeError
        ? error.failure
        : "signer";
    const previous = privateGitRelayList$.getValue();
    const retained =
      previous.generation === session.generation &&
      previous.pubkey === session.account.pubkey
        ? previous
        : undefined;
    const signatureInvalid = !verifyPrivateGitRelayListEventSignature(event);

    session.failedEventId = event.id;
    if (signatureInvalid) {
      // An unverified store winner is not authoritative enough to revoke the
      // last successfully decoded trust set.
    } else if (failure === "invalid") {
      installRelayUrls(session, []);
    } else {
      // A signer rejection or timeout is a user-decision boundary, not a
      // transient relay failure. Coverage and store emissions must not replay
      // a passive decrypt; Retry now is the explicit recovery path.
    }
    privateGitRelayList$.next({
      generation: session.generation,
      pubkey: session.account.pubkey,
      status: "unavailable",
      relayUrls:
        failure === "signer" || signatureInvalid
          ? (retained?.relayUrls ?? [])
          : [],
      sourceEvent:
        failure === "signer" || signatureInvalid
          ? retained?.sourceEvent
          : event,
      error:
        error instanceof Error
          ? error.message
          : "The private Git relay list could not be decrypted",
    });
  }
}

/** Start private-repository projection for the active account. */
export function startPrivateGitRelaySession(
  account: IAccount,
  outboxRelays: readonly string[],
): () => void {
  activeSubscription?.unsubscribe();
  if (activeSession) {
    activeSession.stopped = true;
    clearPrivateRelayCaches(activeSession.account.pubkey);
  }
  const previous = clearPrivateRepositoryScope();
  for (const eventId of previous.eventIds) eventStore.remove(eventId);
  for (const relay of previous.relayUrls) pool.remove(relay);

  const session: PrivateGitRelaySession = {
    generation: ++generation,
    account,
    outboxRelays: [...new Set(outboxRelays.map(normalizeUrl))],
    stopped: false,
    refreshRevision: 0,
  };
  activeSession = session;
  beginPrivateRelayTrustSession(account.id, account.pubkey, session.generation);
  privateGitRelayList$.next({
    generation: session.generation,
    pubkey: account.pubkey,
    status: "loading",
    relayUrls: [],
  });

  const subscription = new Subscription();
  subscription.add(
    merge(
      eventStore.filters(
        {
          kinds: [PRIVATE_GIT_RELAY_LIST_KIND],
          authors: [account.pubkey],
        },
        true,
      ),
      eventStore.remove$.pipe(
        filter(
          (event) =>
            event.kind === PRIVATE_GIT_RELAY_LIST_KIND &&
            event.pubkey === account.pubkey,
        ),
      ),
    ).subscribe(() => void refreshSession(session)),
  );
  subscription.add(
    userIdentityCoverage.changes$.subscribe(() => void refreshSession(session)),
  );
  activeSubscription = subscription;
  void refreshSession(session);

  return () => {
    if (activeSession !== session) {
      session.stopped = true;
      return;
    }
    session.stopped = true;
    activeSession = undefined;
    activeSubscription?.unsubscribe();
    activeSubscription = undefined;
    const cleared = clearPrivateRepositoryScope();
    for (const eventId of cleared.eventIds) eventStore.remove(eventId);
    for (const relay of cleared.relayUrls) pool.remove(relay);
    clearPrivateRelayCaches(session.account.pubkey);
    privateGitRelayList$.next({
      generation: ++generation,
      status: "logged-out",
      relayUrls: [],
    });
  };
}

/** Retry decryption of the current warm EventStore winner. */
export function retryPrivateGitRelayList(generationToRetry: number): void {
  const session = activeSession;
  if (!session || session.generation !== generationToRetry || session.stopped) {
    return;
  }
  session.failedEventId = undefined;
  const previous = privateGitRelayList$.getValue();
  privateGitRelayList$.next({
    generation: session.generation,
    pubkey: session.account.pubkey,
    status: "loading",
    relayUrls:
      previous.generation === session.generation ? previous.relayUrls : [],
    sourceEvent:
      previous.generation === session.generation
        ? previous.sourceEvent
        : undefined,
  });
  void refreshSession(session, true);
}
