import { EventStore, mapEventsToStore } from "applesauce-core";
import { persistEventsToCache } from "applesauce-core/helpers";
import type { Filter } from "applesauce-core/helpers";
import {
  createAddressLoader,
  createEventLoaderForStore,
  createReactionsLoader,
  createZapsLoader,
  DnsIdentityLoader,
} from "applesauce-loaders/loaders";
import { RelayLiveness, RelayPool, onlyEvents } from "applesauce-relay";
import type { RelayGroup } from "applesauce-relay";
import { NostrConnectSigner } from "applesauce-signers";
import type { NostrEvent } from "nostr-tools";
import { verifyEvent } from "nostr-tools";
import {
  BehaviorSubject,
  Observable,
  Subject,
  Subscription,
  combineLatest,
  merge,
  distinctUntilChanged,
  firstValueFrom,
  from,
  of,
  timer,
  EMPTY,
} from "rxjs";
import {
  catchError,
  filter,
  map,
  mergeMap,
  switchMap,
  take,
  timeout,
} from "rxjs/operators";
import { MailboxesModel } from "applesauce-core/models";
import {
  cacheRequest,
  loadDeletionEvents,
  saveDeletionEvent,
  saveEvents,
} from "./cache";
import { PersistentDeleteManager } from "./persistentDeleteManager";
import { nip05IdbCache, loadAllNip05FromIdb } from "./nip05IdbCache";
import { setHintEventStore } from "@/factories/hints";
import {
  fallbackRelays,
  lookupRelays,
  gitIndexRelays,
  relayCurationMode,
} from "./settings";
import {
  ISSUE_KIND,
  REPO_KIND,
  PR_ROOT_KINDS,
  LEGACY_REPLY_KINDS,
  COVER_NOTE_KIND,
  parseRepoCoordinate,
  isRepositoryRootItem,
  resolveChain,
  getRepoIsPrivate,
  roleHistoryCacheKey,
  type RepositoryRoleHistory,
} from "@/lib/nip34";
import { CI_EVENT_KINDS, CI_RUN_KIND } from "@/lib/ci";
import { SOFTWARE_APPLICATION_KIND } from "@/casts/Software";
import {
  createPaginatedTagValueLoader,
  type PaginatedTagValueResponse,
} from "@/lib/tagValuePaginatedLoader";
import {
  resilientAdditiveSubscription,
  type AdditiveFilterChunk,
} from "@/lib/resilientSubscription";
import {
  bestEffortRelayGroupId,
  fixedRelayGroupUrls,
  outboxStore,
  type RelayGroupResolver,
  unwrapRelayGroupId,
} from "./outbox";
import { normalizeUrl } from "@/lib/url";
import { isPersonalSingletonKind } from "@/lib/personalSingletons";
import { relayGroupUrls$ } from "@/models/RepositoryRelayGroup";
import {
  buildStackCandidateFilter,
  getEffectivePRMergeBases,
} from "@/lib/inferredPRParents";
import { loadEventReferenceClosure } from "@/lib/eventReferenceClosure";
import { createDedupedVerifyEvent } from "@/lib/dedupeVerifyEvent";
import {
  getPrivateRepositoryRelays,
  getPrivateRelayTrustSession,
  isPrivateRepositoryCoordinate,
  isTrustedPrivateRepositoryRelay,
  markPrivateRelayEvent,
} from "@/services/privateRepositoryScope";

/**
 * Global EventStore instance for all Nostr events.
 * This is the central state container for the application.
 */
const deleteManager = new PersistentDeleteManager({
  load: loadDeletionEvents,
  save: saveDeletionEvent,
  verify: verifyEvent,
  onError: (operation, error) => {
    console.warn(`[cache] Failed to ${operation} deletion tombstones:`, error);
  },
});

export const eventStore = new EventStore({
  keepDeleted: false, // Don't keep deleted events
  keepExpired: false, // Don't keep expired events
  keepOldVersions: false, // Only keep latest version of replaceable events
  deleteManager,
});

// Verify events when they are added to the store. Each event pays for a full
// verification (hash + schnorr) at most once: identical copies of an
// already-stored event skip straight to the store's id-based dedupe. See
// createDedupedVerifyEvent for the safety argument.
//
// BIES Code keeps this on. Upstream 26e7ed57 switched to fakeVerifyEvent for
// cold-load speed, which lets any relay the client queries inject forged
// events (repository state, CI coordinator keys, relay lists) that the app
// then trusts or signs on top of. See docs/signature-verification.md.
eventStore.verifyEvent = createDedupedVerifyEvent(eventStore, verifyEvent);

// Persist events to the local nostrdb
persistEventsToCache(eventStore, saveEvents);

/**
 * Resolves after durable deletion state has been restored. main.tsx waits for
 * this before rendering so a stale cached original cannot precede its
 * tombstone into the EventStore.
 */
export const deletionCacheReady = deleteManager.hydrate();
/** Verified signed deletion evidence retained outside the deleting EventStore. */
export const deletionEvents$ = deleteManager.evidence$;

// Register this store as the source for factory relay-hint resolution. Done
// here (rather than `hints.ts` importing this module) so the factory layer has
// no static dependency on the service graph — see src/factories/hints.ts.
setHintEventStore(eventStore);

/**
 * Global RelayPool instance for all relay connections.
 * Use this to query events and publish to relays.
 */
export const pool = new RelayPool();

/**
 * Global relay liveness tracker.
 *
 * Tracks online / offline / dead state for every relay the pool sees. Used
 * for status indicators, persistence, and (in future) filtering relay
 * suggestion lists. **Not** consulted for reconnect cadence — that is owned
 * solely by the reconnectTimer override below, so this layer is purely
 * informational and does not influence retry behavior in resilientSubscription.
 */
export const liveness = new RelayLiveness();
liveness.connectToPool(pool);

// Replace each relay's reconnectTimer with a 3-phase backoff curve. This is
// the **single source of truth** for socket-level reconnect cadence — no
// other layer (resilientSubscription, RelayLiveness, etc.) governs WS retry
// timing.
//
// applesauce-relay@6.0.0 uses 1.5^attempts × 1000ms capped at 5min, which
// produces a tight burst (1.5s, 2.25s, 3.4s, 5s, 7.6s, 11s, …) that hammers
// 404 / unreachable URLs with many connection attempts before slowing down.
//
// Three-phase replacement:
//   - attempts 1-3:  1s,  2s,  4s          (network blip / relay restart)
//   - attempts 4-6:  30s, 60s, 2min        (server likely under load)
//   - attempts 7-9:  5min, 10min, 20min    (probably down)
//   - attempts 10+:  30min cap             (low-cost periodic probe)
//
// No termination — applesauce's share+keepAlive on watchTower naturally
// pauses the reconnect loop when no callers are subscribed (after a 30s
// keep-alive window with refCount=0 the WS closes cleanly and no further
// startReconnectTimer fires). attempts$ persists on the Relay instance, so
// when a caller comes back later the curve resumes from where it left off.
// While a caller is subscribed, capping at 30min gives auto-revival probes
// for relays that have come back without manual intervention.
//
// Requires patches/applesauce-relay@6.2.1.patch: count failures when arming
// recovery, including WebSocket errors without a close event. Otherwise
// attempts can stay at zero and every retry uses the first 1s delay.
const RECONNECT_PHASES_MS: number[] = [
  // Phase 1 — burst (attempts 1-3)
  1_000,
  2_000,
  4_000,
  // Phase 2 — under-load pause (attempts 4-6)
  30_000,
  60_000,
  120_000,
  // Phase 3 — probably down (attempts 7-9)
  5 * 60_000,
  10 * 60_000,
  20 * 60_000,
];
const RECONNECT_CAP_MS = 30 * 60_000;

function reconnectDelayMs(attempts: number): number {
  // attempts is 1-based for the first failure; use index attempts-1.
  const i = Math.max(0, attempts - 1);
  return i < RECONNECT_PHASES_MS.length
    ? RECONNECT_PHASES_MS[i]
    : RECONNECT_CAP_MS;
}

pool.add$.subscribe((relay) => {
  relay.reconnectTimer = (_error, attempts) =>
    timer(reconnectDelayMs(attempts));

  // Mark private-relay provenance before EventStore consumers observe the
  // event. Cache persistence consults this synchronous quarantine. A private
  // service may also mirror public repository announcements, so kind:30617
  // needs an explicit ngit/Buzz private marker; coordinate-specific legacy
  // discovery marks its stronger evidence before EventStore insertion.
  relay.message$.subscribe((message: unknown) => {
    if (
      !isTrustedPrivateRepositoryRelay(relay.url) ||
      !Array.isArray(message) ||
      message[0] !== "EVENT"
    ) {
      return;
    }
    const event = message[2];
    if (event && typeof event === "object") {
      const nostrEvent = event as NostrEvent;
      if (
        verifyEvent(nostrEvent) &&
        (nostrEvent.kind !== REPO_KIND || getRepoIsPrivate(nostrEvent))
      ) {
        markPrivateRelayEvent(nostrEvent);
      }
    }
  });
});

/**
 * Setup NostrConnectSigner to use the global relay pool.
 * This allows NostrConnectSigner instances to communicate with relays
 * for NIP-46 remote signing.
 */
NostrConnectSigner.pool = pool;

// Inject the pool into the outbox store so it can publish to relays.
// This is done here (after pool is created) to avoid a circular dependency.
outboxStore.pool = pool;

/**
 * NIP-42 auto-auth policy — wired once at the pool level.
 *
 * When a relay sends an AUTH challenge we check (synchronously from the
 * EventStore cache) whether the relay URL appears in the active account's
 * NIP-65 inbox or outbox list.  If it does, we authenticate immediately.
 * Unknown relays are silently skipped — authenticating to arbitrary relays
 * would leak the user's identity to any relay that asks.
 *
 * The active account is read lazily at challenge time so this works correctly
 * after account switches without needing to re-wire.  accounts.ts imports
 * nostr.ts (not the other way around) so we import accounts lazily here to
 * avoid a circular dependency.
 */
pool.add$.subscribe((relay) => {
  relay.challenge$
    .pipe(
      // Only act when a real challenge string arrives
      filter(Boolean),
      // Don't re-auth if the challenge string hasn't changed
      distinctUntilChanged(),
    )
    .subscribe(async () => {
      // Lazy import to avoid circular dependency (accounts → nostr → accounts)
      const { accounts } = await import("./accounts");
      const account = accounts.active$.getValue();
      if (!account) return;

      const privateTrust = getPrivateRelayTrustSession(relay.url);
      if (
        privateTrust &&
        privateTrust.accountId === account.id &&
        privateTrust.pubkey === account.pubkey
      ) {
        try {
          await relay.authenticate(account.signer);
          const currentAccount = accounts.active$.getValue();
          const currentTrust = getPrivateRelayTrustSession(relay.url);
          if (
            currentAccount?.id !== account.id ||
            currentAccount.pubkey !== account.pubkey ||
            currentTrust?.generation !== privateTrust.generation ||
            currentTrust.accountId !== privateTrust.accountId
          ) {
            pool.remove(relay.url);
          }
        } catch (err) {
          console.warn(
            `[auth] Private relay auth failed for ${relay.url}:`,
            err,
          );
        }
        return;
      }

      // Synchronous cache check — kind:10002 is kept live by
      // userIdentitySubscription so this will almost always be populated.
      // We use getByFilters() directly rather than eventStore.model() because
      // model() returns an Observable backed by a ReplaySubject(1), which has
      // no synchronous .getValue() accessor.  getByFilters() hits the in-memory
      // database directly and is the correct synchronous read path here.
      const [mailboxEvent] = eventStore.getByFilters([
        { kinds: [10002], authors: [account.pubkey], limit: 1 },
      ]);
      const inboxes: string[] = mailboxEvent
        ? mailboxEvent.tags
            .filter((t) => t[0] === "r" && t[2] === "read")
            .map((t) => t[1])
        : [];
      const outboxes: string[] = mailboxEvent
        ? mailboxEvent.tags
            .filter((t) => t[0] === "r" && (!t[2] || t[2] === "write"))
            .map((t) => t[1])
        : [];
      const trusted = new Set([...inboxes, ...outboxes]);

      if (!trusted.has(relay.url)) return;

      try {
        await relay.authenticate(account.signer);
      } catch (err) {
        // Non-fatal — relay may reject auth or signer may be unavailable
        console.warn(`[auth] NIP-42 auth failed for ${relay.url}:`, err);
      }
    });
});

/** Max relays to use per group when resolving */
const MAX_RESOLVED_RELAYS = 5;

/**
 * Resolve a pubkey's NIP-65 mailboxes from the EventStore, fetching via
 * addressLoader if not already cached. Returns undefined if not found within
 * the timeout.
 */
async function resolveMailboxes(pubkey: string) {
  // Kick off a fetch in case the kind:10002 isn't in the store yet.
  // addressLoader writes into the EventStore as a side-effect.
  const fetchSub = addressLoader({ kind: 10002, pubkey }).subscribe();
  try {
    return await firstValueFrom(
      eventStore.model(MailboxesModel, pubkey).pipe(
        // Skip the immediate undefined emitted when the event isn't in the
        // store yet — wait for the addressLoader fetch to deliver it.
        filter(
          (m): m is { inboxes: string[]; outboxes: string[] } =>
            m !== undefined,
        ),
        timeout({ first: 3000, with: () => of(undefined) }),
      ),
    );
  } finally {
    fetchSub.unsubscribe();
  }
}

/**
 * Relay group resolver for the outbox store.
 *
 * Resolves a group ID to the current set of relay URLs:
 *
 *   Dynamic (pubkey-based):
 *   - "outbox:<pubkey>"      → that pubkey's NIP-65 write (outbox) relays
 *   - "inbox:<pubkey>"       → that pubkey's NIP-65 read (inbox) relays
 *   - "30617:<pubkey>:<d>"   → repo's declared relays from the EventStore
 *
 *   Static (settings-based):
 *   - "fallback-relays"      → user-configured fallback relays (fallbackRelays setting)
 *   - "index-relays"         → lookup/user-index relays (lookupRelays setting)
 *   - "git-index"            → git index relay (wss://index.ngit.dev)
 *   - "bootstrap-relays"     → hardcoded new-account bootstrap relays
 *   - "best-effort:<group>"  → attempted without blocking broad delivery
 *   - "fixed-relays:<...>"   → immutable relay URLs encoded by the writer
 *
 * When the kind:10002 is not yet in the EventStore, addressLoader is used to
 * fetch it. The outbox store calls this again via reResolveRelayGroups()
 * whenever a new kind:10002 arrives, so events are sent to newly-discovered
 * relays automatically.
 */
const relayGroupResolver: RelayGroupResolver = async (groupId) => {
  const targetGroupId = unwrapRelayGroupId(groupId).groupId;
  const fixedRelays = fixedRelayGroupUrls(targetGroupId);
  if (fixedRelays !== undefined) return fixedRelays;

  // "outbox:<pubkey>" → NIP-65 write relays
  if (targetGroupId.startsWith("outbox:")) {
    const pubkey = targetGroupId.slice(7);
    if (!/^[0-9a-f]{64}$/.test(pubkey)) return [];
    try {
      const mailboxes = await resolveMailboxes(pubkey);
      return mailboxes?.outboxes.slice(0, MAX_RESOLVED_RELAYS) ?? [];
    } catch {
      return [];
    }
  }

  // "inbox:<pubkey>" → NIP-65 read relays
  if (targetGroupId.startsWith("inbox:")) {
    const pubkey = targetGroupId.slice(6);
    if (!/^[0-9a-f]{64}$/.test(pubkey)) return [];
    try {
      const mailboxes = await resolveMailboxes(pubkey);
      return mailboxes?.inboxes.slice(0, MAX_RESOLVED_RELAYS) ?? [];
    } catch {
      return [];
    }
  }

  // Repo coord: "30617:<pubkey>:<d>"
  //
  // Resolve the reciprocal component before accepting shared relay metadata.
  // Directionally discovered invitation announcements never widen a publish
  // target. Any announcements arriving later are picked up when the outbox
  // re-resolves relay groups.
  if (targetGroupId.startsWith("30617:")) {
    if (isPrivateRepositoryCoordinate(targetGroupId)) {
      return getPrivateRepositoryRelays(targetGroupId) ?? [];
    }
    const parts = targetGroupId.split(":");
    const pubkey = parts[1];
    const d = parts.slice(2).join(":");
    if (!pubkey || !d) return [];

    const events = eventStore.getByFilters({
      kinds: [30617],
      "#d": [d],
    } as Filter);
    return resolveChain(events, pubkey, d)?.relays ?? [];
  }

  // Static settings-based groups
  if (targetGroupId === "fallback-relays") return fallbackRelays.getValue();
  if (targetGroupId === "index-relays") return lookupRelays.getValue();
  if (targetGroupId === "git-index") return gitIndexRelays.getValue();
  if (targetGroupId === "bootstrap-relays") {
    const { ACCOUNT_BOOTSTRAP_RELAYS } = await import("@/actions/account");
    return ACCOUNT_BOOTSTRAP_RELAYS;
  }

  return [];
};

outboxStore.relayGroupResolver = relayGroupResolver;

/**
 * Watch for changes to the current user's NIP-65 relay list and re-resolve
 * relay groups for any pending outbox items. This ensures that if the user
 * updates their relay list, pending events are sent to any newly-added relays.
 *
 * We track the serialized outbox URL list so we only trigger on actual changes,
 * not on every MailboxesModel emission.
 */
function watchUserMailboxesForOutboxReResolve(pubkey: string): () => void {
  const sub = eventStore
    .model(MailboxesModel, pubkey)
    .pipe(
      map((m) => JSON.stringify([...(m?.outboxes ?? [])].sort())),
      distinctUntilChanged(),
    )
    .subscribe(() => {
      // Pass the pubkey so only items with outbox:<pubkey> / inbox:<pubkey>
      // / 30617:<pubkey>:* groups are re-resolved.
      outboxStore.reResolveRelayGroups(pubkey).catch((err) => {
        console.warn("[outbox] reResolveRelayGroups failed:", err);
      });
    });
  return () => sub.unsubscribe();
}

// Exported so accounts.ts (or App.tsx) can call it when the active account changes.
export { watchUserMailboxesForOutboxReResolve };

/**
 * Watch for any kind:10002 (NIP-65 relay list) arriving in the EventStore and
 * trigger outbox re-resolution for the event's author.
 *
 * This covers the notification inbox case: when we publish a comment and add
 * "inbox:<authorPubkey>" as a relay group with no URLs yet, the outbox store
 * will re-resolve it as soon as the author's kind:10002 arrives — whether
 * that's from the addressLoader fetch triggered by the resolver, or from any
 * other subscription that happens to load it.
 */
function watchAnyMailboxForOutboxReResolve(): () => void {
  const sub = eventStore.filters({ kinds: [10002] }, true).subscribe({
    next: (event) => {
      outboxStore.reResolveRelayGroups(event.pubkey).catch((err) => {
        console.warn("[outbox] reResolveRelayGroups failed:", err);
      });
    },
  });
  return () => sub.unsubscribe();
}

// Start watching immediately — this covers notification inbox re-resolution
// for any pubkey whose kind:10002 arrives after a comment is published.
watchAnyMailboxForOutboxReResolve();

/**
 * Event kinds accepted by the git index relay (wss://index.ngit.dev).
 * Any event published to "git-index" must be one of these kinds.
 */
const GIT_INDEX_KINDS = new Set([
  30617, // NIP-34 repository announcements
  10317, // User GRASP server lists
]);

/** User-index kinds whose acceptance was already required before Phase 2. */
const REQUIRED_USER_INDEX_KINDS = new Set([0, 3, 10002, 10017, 10018, 10317]);

/**
 * Publish an event to the configured relays.
 *
 * This is the low-level publish used by the ActionRunner for built-in
 * applesauce actions (UpdateProfile, AddOutboxRelay, etc.). It publishes to
 * the union of the provided relays and the global fallbackRelays, and
 * records the attempt in the outbox store for retry and UI display.
 *
 * For NIP-34 events (issues, status changes, renames) use the dedicated
 * Action functions in src/actions/nip34.ts which resolve the correct relay
 * groups (user outbox + repo relays + notification inboxes) automatically.
 *
 * Every personal singleton is also published to configured user-index relays.
 * Existing index kinds retain required delivery; newly routed application
 * lists are best-effort because generic index acceptance is not established.
 * Kind:30617 (repo announcements) and kind:10317 (GRASP lists) are
 * automatically also published to "git-index" — the git index relay only
 * accepts these two kinds, so only they should ever be sent there.
 *
 * @param event          - The signed Nostr event to publish
 * @param extraGroupIds  - Additional group IDs to publish to alongside the
 *                         user's outbox (e.g. "index-relays").
 * @param options        - Set optimistic to false when local insertion must
 *                         wait for independent relay verification.
 */
export async function publish(
  event: NostrEvent,
  extraGroupIds?: string[],
  options?: { optimistic?: boolean },
): Promise<void> {
  // Safety-sensitive callers can defer local insertion until a relay has
  // acknowledged and returned the exact event.
  if (options?.optimistic !== false) eventStore.add(event);

  const groupIds = [`outbox:${event.pubkey}`, "fallback-relays"];
  if (extraGroupIds) groupIds.push(...extraGroupIds);

  if (
    isPersonalSingletonKind(event.kind) &&
    !groupIds.some(
      (groupId) => unwrapRelayGroupId(groupId).groupId === "index-relays",
    )
  ) {
    groupIds.push(
      REQUIRED_USER_INDEX_KINDS.has(event.kind)
        ? "index-relays"
        : bestEffortRelayGroupId("index-relays"),
    );
  }

  // Automatically include "git-index" for kinds it accepts, deduplicating
  // in case the caller already added it explicitly.
  if (GIT_INDEX_KINDS.has(event.kind) && !groupIds.includes("git-index")) {
    groupIds.push("git-index");
  }

  await outboxStore.publish(event, groupIds);
}

/**
 * Create unified event loader for the EventStore.
 * This automatically loads events that are referenced but not in the store yet.
 *
 * Features:
 * - Automatic batching of event requests
 * - Follows relay hints from events
 * - Checks IndexedDB cache first
 * - Queries lookup relays for missing events
 */
export const eventLoader = createEventLoaderForStore(eventStore, pool, {
  cacheRequest,
  lookupRelays: lookupRelays.getValue(),
  extraRelays: fallbackRelays,
  followRelayHints: true,
  bufferTime: 1000, // Batch requests within 1 second
});

/**
 * Loader for addressable events (NIP-33).
 * Used for loading articles, profiles, and other replaceable events.
 */
export const addressLoader = createAddressLoader(pool, {
  cacheRequest,
  extraRelays: fallbackRelays,
  eventStore,
  lookupRelays: lookupRelays.getValue(),
});

/**
 * Loader for reactions (kind 7).
 * Efficiently loads and caches reactions for events.
 */
export const reactionsLoader = createReactionsLoader(pool, {
  cacheRequest,
  eventStore,
});

/** Create loader for loading zaps for other events */
export const zapsLoader = createZapsLoader(pool, {
  cacheRequest,
  extraRelays: fallbackRelays,
  eventStore,
});

/**
 * Singleton profile loader for kind:0 metadata events.
 *
 * Batches all per-pubkey profile fetch requests across the entire app into a
 * single relay REQ per 200ms window. Components call this instead of opening
 * their own pool.subscription so that e.g. a list of 20 issue authors produces
 * one REQ rather than 20.
 *
 * The eventStore option deduplicates events that come back from relays.
 * Call-site deduplication (skip if already in store) is the responsibility of
 * the caller — see useLoadProfile / useProfilesForPubkeys.
 */
export const profileLoader = createAddressLoader(pool, {
  cacheRequest,
  eventStore,
  lookupRelays: lookupRelays.getValue(),
  bufferTime: 200,
});

/**
 * Loader for NIP-05 DNS identity lookups.
 * Results are persisted to IndexedDB (gitworkshop / nip05-identities) so that
 * verified identities survive page reloads. Expiry is set to 30 days so
 * stale entries are re-verified after a month.
 */
export const dnsIdentityLoader = new DnsIdentityLoader(nip05IdbCache);
dnsIdentityLoader.expiration = 60 * 60 * 24 * 30; // 30 days in seconds

// Warm the in-memory identity map from IDB on startup.
// DnsIdentityLoader.loadIdentity() reads IDB but does NOT write back to the
// in-memory map (this.identities), so getIdentity() would always miss on a
// fresh page load even when IDB has data. Loading all entries upfront ensures
// the synchronous getIdentity() check in useRepoPath / useDnsIdentity hits on
// the first render without a loading flash.
//
// nip05WarmupReady resolves once the IDB warm-up is complete. useDnsIdentity
// awaits this before deciding whether to show a loading state, so navigating
// to a NIP-05 repo URL from the landing page never flashes a loading screen
// when the identity is already cached in IDB.
export const nip05WarmupReady: Promise<void> = loadAllNip05FromIdb().then(
  (entries) => {
    for (const [address, identity] of Object.entries(entries)) {
      dnsIdentityLoader.identities.set(address, identity);
    }
  },
);

// ---------------------------------------------------------------------------
// NIP-34 singleton loaders for Issues, Patches, and PRs
//
// Each loader is a SINGLE instance per tag name, so all per-item calls
// within the buffer window are collapsed into one relay subscription.
//
// List level — essentials + comments
//   Essentials (#e tag, bufferTime: 100ms): status (1630-1633), labels (1985),
//   and deletions (5) for every item on the page.
//   Comments (#E tag, bufferTime: 500ms): NIP-22 comments (1111), PR
//   updates (1619), and CI activity (9841/9842/39842). The longer buffer ensures
//   essentials land first.
//
// Thread level — all child events, no kind restriction (detail pages only)
//   Three loaders for the three tag names used to reference thread members:
//   #e (lowercase), #E (uppercase/NIP-22 root), #q (quote).
//   No kind restriction — fetches reactions, zaps, deletions, and any other
//   events that tag a thread member. Will overlap with essentials/comments
//   data already fetched, but the EventStore deduplicates on receipt.
// ---------------------------------------------------------------------------

const NIP34_ESSENTIALS_BUFFER = 100;
const NIP34_COMMENTS_BUFFER = 500;
const NIP34_THREAD_BUFFER = 500;
/** Longer buffer for deletion-of-essentials loader — less time-critical. */
const NIP34_ESSENTIAL_DELETIONS_BUFFER = 2000;
/** Buffer for the CI results-by-commit loader — a page of commits batches
 *  into one REQ per relay within this window. */
const CI_COMMIT_RESULTS_BUFFER = 500;

/**
 * Essentials loader (#e tag).
 * Fetches status (1630-1633), NIP-32 labels (1985), deletion requests (5),
 * cover notes (1624), and legacy NIP-34 replies (kind 1 and 1622) for
 * issues/patches/PRs.
 *
 * Cover notes use lowercase #e (NIP-10 style) to reference the root item,
 * not NIP-22 uppercase #E, so they belong here alongside other essentials.
 *
 * Uses createPaginatedTagValueLoader which combines the historical fetch,
 * per-relay backward pagination, and a persistent live subscription in one.
 *
 * Legacy replies use NIP-10 #e tagging (not NIP-22 #E), so they must be
 * fetched via this #e loader rather than the #E comments loader. Including
 * them here is a bit of a hack — semantically they're comments, not
 * essentials, and they arrive earlier (100ms buffer vs 500ms for comments).
 * But legacy replies are an edge case in practice, so this is a reasonable
 * tradeoff vs. creating an additional singleton loader and subscription.
 */
export const nip34EssentialsLoader = createPaginatedTagValueLoader(pool, "e", {
  cacheRequest,
  eventStore,
  kinds: [
    1630,
    1631,
    1632,
    1633,
    1985,
    5,
    COVER_NOTE_KIND,
    ...LEGACY_REPLY_KINDS,
  ],
  bufferTime: NIP34_ESSENTIALS_BUFFER,
});

/**
 * Comments loader (#E tag).
 * Fetches NIP-22 comments (kind 1111), PR updates (kind 1619), and ngit-ci
 * activity (kinds 9841/9842/39842 — CI events tag the PR root via
 * NIP-22-style #E, so they ride along with comments and power CI badges).
 * Uses the uppercase `E` root tag, so it needs its own loader instance
 * separate from the `#e` loaders. The longer buffer ensures essentials
 * land first.
 */
export const nip34CommentsLoader = createPaginatedTagValueLoader(pool, "E", {
  cacheRequest,
  eventStore,
  kinds: [1111, 1619, ...CI_EVENT_KINDS],
  bufferTime: NIP34_COMMENTS_BUFFER,
});

/**
 * Deletion-of-essentials loader.
 *
 * Fetches kind:5 deletion requests that reference a specific essential event
 * (label event, status event, etc.) via its `#e` tag. Called once per
 * essential event ID discovered by nip34EssentialsLoader.
 *
 * Uses a longer buffer time than the essentials loader because deletion events
 * are lower-priority — they only affect display after the referenced event is
 * already known.
 *
 * Multiple calls within the buffer window are batched into a single relay REQ
 * automatically (same createPaginatedTagValueLoader mechanism).
 */
export const nip34EssentialDeletionsLoader = createPaginatedTagValueLoader(
  pool,
  "e",
  {
    cacheRequest,
    eventStore,
    kinds: [5],
    bufferTime: NIP34_ESSENTIAL_DELETIONS_BUFFER,
  },
);

/**
 * CI results-by-commit loader (#c tag).
 *
 * Fetches ngit-ci activity for specific commits — powers
 * the commit status ticks in the CodeBar commit summary row, the commit
 * history list, and the commit detail page. Callers fire it once per commit
 * they are about to display; calls within the buffer window are batched into
 * a single REQ per relay, so fetching CI for a page of commits costs one
 * subscription.
 *
 * Kind:39842 progress markers also arrive repo-wide via
 * the #a coordinate filter in nip34RepoLoader's repo meta subscription (their
 * NIP-40 expiration keeps that set small) and are read back from the store
 * by #c when rolling up a commit's status.
 */
export const ciResultsByCommitLoader = createPaginatedTagValueLoader(
  pool,
  "c",
  {
    cacheRequest,
    eventStore,
    kinds: [...CI_EVENT_KINDS],
    bufferTime: CI_COMMIT_RESULTS_BUFFER,
  },
);

/**
 * Thread loader — replies (#e tag). All events referencing a thread member
 * via lowercase `e` tag. No kind restriction. Only fired on detail pages.
 */
const nip34ThreadReplyLoader = createPaginatedTagValueLoader(pool, "e", {
  cacheRequest,
  eventStore,
  bufferTime: NIP34_THREAD_BUFFER,
});

/**
 * Thread loader — root references (#E tag). All events referencing a thread
 * member via uppercase `E` tag (NIP-22 root reference). No kind restriction.
 * Only fired on detail pages.
 */
const nip34ThreadRootLoader = createPaginatedTagValueLoader(pool, "E", {
  cacheRequest,
  eventStore,
  bufferTime: NIP34_THREAD_BUFFER,
});

/**
 * Thread loader — quotes (#q tag). All events quoting a thread member.
 * No kind restriction. Only fired on detail pages.
 */
const nip34ThreadQuoteLoader = createPaginatedTagValueLoader(pool, "q", {
  cacheRequest,
  eventStore,
  bufferTime: NIP34_THREAD_BUFFER,
});

// ---------------------------------------------------------------------------
// NIP-34 observable factories
//
// Pure RxJS observable factories — no React, no hooks. Consumed by React
// hooks via use$(), which handles subscription lifecycle.
//
// Two levels, each non-additive (no overlap):
//
//   nip34ListLoader    — list level: essentials + comments for a single item.
//                        Also used by nip34RepoLoader to fire both loaders
//                        for each newly discovered item.
//
//   nip34ThreadItemLoader — thread level: ALL events referencing the root
//                        or any comment via #e, #E, or #q tags (no kind
//                        restriction). Recursively fetches child events
//                        for each comment. Only fired on detail pages.
//
//   nip34RepoLoader    — repo level: subscribes to all items for a set of
//                        repo coordinates and pipes each newly discovered
//                        item ID into nip34ListLoader.
//
// Each loader is a createPaginatedTagValueLoader instance that handles the
// historical fetch, per-relay backward pagination, and persistent live
// subscription in one. Calls within the same buffer window are batched into
// a single relay subscription per relay automatically.
// ---------------------------------------------------------------------------

/** All root item kinds tracked at the repo level (issues + PR root kinds). */
const REPO_ITEM_KINDS = [ISSUE_KIND, ...PR_ROOT_KINDS] as const;

/** Kind 7 reaction — used for repo stars. */
const REACTION_KIND = 7;

/** Kind 10018 — NIP-51 Git repositories follow list; used for repo follower counts. */
const GIT_REPOS_FOLLOW_KIND = 10018 as const;

/**
 * List-level loader for a single item.
 *
 * Fires both essentials (status, labels, deletions) and comments loaders for
 * the given item ID against the provided relay list. Each loader handles its
 * own historical fetch (backward pagination until exhausted) and persistent
 * live subscription.
 *
 * The relay list is a static snapshot — callers are responsible for
 * reactivity. nip34RepoLoader re-fires this function when the RelayGroup
 * gains new relays. useNip34ItemLoader re-subscribes via use$() when
 * repoRelayKey changes (driven by useRelayGroupUrls).
 *
 * Because nip34EssentialsLoader and nip34CommentsLoader are singleton
 * instances, calls within the same buffer window are batched into a single
 * REQ per relay automatically.
 *
 * @param itemId - The event ID of the issue / patch / PR
 * @param relays - Relay URLs to query (snapshot at call time)
 */
export function nip34ListLoader(
  itemId: string,
  relays: string[],
): Observable<PaginatedTagValueResponse> {
  return new Observable<PaginatedTagValueResponse>((subscriber) => {
    // Track essential event IDs we have already fired the deletion loader for
    // so we don't duplicate subscriptions when the loader delivers the same
    // event more than once.
    const seenEssentialIds = new Set<string>();

    const essentialsSub = nip34EssentialsLoader({
      value: itemId,
      relays,
    }).subscribe({
      next: (msg) => {
        subscriber.next(msg);
        if (msg !== "EOSE") {
          const event = msg as NostrEvent;
          if (!seenEssentialIds.has(event.id)) {
            seenEssentialIds.add(event.id);
            // Fire deletion loader for this essential event's ID.
            // Calls within the buffer window are batched automatically.
            nip34EssentialDeletionsLoader({
              value: event.id,
              relays,
            }).subscribe(subscriber);
          }
        }
      },
    });

    const commentsSub = nip34CommentsLoader({
      value: itemId,
      relays,
    }).subscribe({
      next: (msg) => subscriber.next(msg),
    });

    return () => {
      essentialsSub.unsubscribe();
      commentsSub.unsubscribe();
    };
  });
}

/**
 * Max inbox relay URLs to query per item author when resolveAuthorInbox is
 * enabled. Keeps the relay connection count bounded even for authors with many
 * read relays declared in their kind:10002.
 */
const MAX_AUTHOR_INBOX_RELAYS = 3;

/**
 * Reactive inputs for nip34RepoLoader.
 *
 * Emitted whenever the resolver's confirmed member coordinate set or role
 * history changes. Coordinate growth folds into the live subscription as
 * delta REQs; re-presenting an unchanged set is a strict no-op. Coordinate
 * removal is deliberately ignored — a removed coordinate's REQs stay live
 * until the loader unsubscribes. A repository identity change (different
 * selected pubkey/dTag) must be a new loader subscription, not an emission.
 */
export interface Nip34RepoLoaderInputs {
  /** Confirmed member coordinate strings for the repository. */
  coords: string[];
  /** Role history used to authorise PR updates for merge-base inference. */
  roleHistory?: RepositoryRoleHistory;
}

/** One immutable additive chunk: all root item kinds for one coordinate. */
function repoItemChunk(coord: string): AdditiveFilterChunk {
  return {
    key: `item:${coord}`,
    filters: [{ kinds: [...REPO_ITEM_KINDS], "#a": [coord] } as Filter],
    deltaSafe: true,
  };
}

/** One immutable additive chunk: repo meta kinds for one coordinate. */
function repoMetaChunk(coord: string): AdditiveFilterChunk {
  return {
    key: `meta:${coord}`,
    // Reactions (stars), follow lists, zaps — plus kind:39842 CI workflow
    // progress markers. The markers carry a NIP-40 expiration so the live
    // set for a repo stays small; fetching them repo-wide via #a keeps
    // pending indicators available everywhere (PR lists, PR pages) without
    // per-item subscriptions.
    filters: [
      {
        kinds: [REACTION_KIND, GIT_REPOS_FOLLOW_KIND, 9735, CI_RUN_KIND],
        "#a": [coord],
      } as Filter,
    ],
    deltaSafe: true,
  };
}

/**
 * One immutable additive chunk: software applications by one maintainer
 * pubkey tagging one coordinate. Keyed per (author, coordinate) pair so both
 * dimensions can grow additively without ever reusing a chunk key with
 * different clauses.
 */
function softwareApplicationChunk(
  pubkey: string,
  coord: string,
): AdditiveFilterChunk {
  return {
    key: `app:${pubkey}:${coord}`,
    filters: [
      {
        kinds: [SOFTWARE_APPLICATION_KIND],
        authors: [pubkey],
        "#a": [coord],
      } as Filter,
    ],
    deltaSafe: true,
  };
}

/**
 * Supplemental relay loader for outbox/uncensored mode.
 *
 * Mirrors nip34RepoLoader but targets the extra maintainer mailbox relay group
 * (extraRelaysForMaintainerMailboxCoverage). For each newly discovered root
 * item it calls nip34ListLoader against those extra relay URLs so that status
 * events (1630-1633), labels (1985), and comments (1111) published only to
 * maintainer or author outbox relays are also fetched — not just the root
 * events.
 *
 * Does NOT subscribe to meta events (reactions, follow lists) — those are
 * covered by nip34RepoLoader against the base relay group.
 *
 * Coordinates arrive reactively: a coordinate confirmed after subscribe
 * joins the live item subscription as one delta REQ per relay (the
 * per-coordinate keyed chunks below); an unchanged coordinate list is a
 * strict no-op; removal is ignored until unsubscribe. seenIds and
 * knownRelayUrls persist across growth, so already-seen items never re-fire
 * their loaders.
 *
 * @param coords$    - Reactive array of repo coordinate strings (grow-only)
 * @param relayGroup - The supplemental RelayGroup (extra maintainer mailboxes)
 */
export function nip34SupplementalRelayLoader(
  coords$: Observable<string[]>,
  relayGroup: RelayGroup,
): Observable<NostrEvent> {
  const resolveAuthorInbox = relayCurationMode.getValue() === "outbox";

  return new Observable<NostrEvent>((subscriber) => {
    const seenIds = new Set<string>();
    const knownRelayUrls = new Set<string>();
    const inboxSubs = new Subscription();
    const coordinateSet = new Set<string>();
    const itemAdditions = new Subject<AdditiveFilterChunk>();

    function fireLoaders(id: string, relays: string[]): void {
      nip34ListLoader(id, relays).subscribe({
        next: (msg) => {
          if (msg !== "EOSE") subscriber.next(msg as NostrEvent);
        },
      });
    }

    function fireAuthorInboxLoaders(ev: NostrEvent): void {
      const perItemQueried = new Set(knownRelayUrls);
      addressLoader({ kind: 10002, pubkey: ev.pubkey }).subscribe();
      const s = eventStore
        .model(MailboxesModel, ev.pubkey)
        .pipe(
          filter((m): m is NonNullable<typeof m> => m !== undefined),
          take(1),
        )
        .subscribe((mailboxes) => {
          const newRelays = mailboxes.inboxes
            .slice(0, MAX_AUTHOR_INBOX_RELAYS)
            .map(normalizeUrl)
            .filter((r) => !perItemQueried.has(r));
          if (newRelays.length === 0) return;
          for (const r of newRelays) perItemQueried.add(r);
          nip34ListLoader(ev.id, newRelays).subscribe({
            next: (msg) => {
              if (msg !== "EOSE") subscriber.next(msg as NostrEvent);
            },
          });
        });
      inboxSubs.add(s);
    }

    // When new relays join the group, re-fire existing items' loaders against
    // those new relays only.
    const relaySub = relayGroupUrls$(relayGroup)
      .pipe(
        distinctUntilChanged(
          (a, b) =>
            a.length === b.length && a.every((url) => knownRelayUrls.has(url)),
        ),
      )
      .subscribe((currentUrls) => {
        const newUrls = currentUrls.filter((url) => !knownRelayUrls.has(url));
        for (const url of newUrls) knownRelayUrls.add(url);
        if (newUrls.length === 0) return;
        for (const id of seenIds) {
          fireLoaders(id, newUrls);
        }
      });

    const itemSub = resilientAdditiveSubscription(
      pool,
      relayGroupUrls$(relayGroup),
      { initial: [], additions$: itemAdditions },
      { reconnect: true, gapFill: true, settle: false },
    )
      .pipe(
        onlyEvents(),
        filter((event) => isRepositoryRootItem(event, coordinateSet)),
        mapEventsToStore(eventStore),
      )
      .subscribe({
        next: (event) => {
          const ev = event as NostrEvent;
          if (!seenIds.has(ev.id)) {
            seenIds.add(ev.id);
            fireLoaders(ev.id, [...knownRelayUrls]);
            if (resolveAuthorInbox) fireAuthorInboxLoaders(ev);
          }
        },
        error: (err) => subscriber.error(err),
      });

    // Subscribed after the additive subscription above so a synchronous
    // first emission (BehaviorSubject) reaches a live additions$ consumer.
    // Only genuinely new coordinates emit chunks — an unchanged list is a
    // strict no-op (zero REQs).
    const coordsSub = coords$.subscribe({
      next: (coords) => {
        for (const coord of new Set(coords)) {
          if (coordinateSet.has(coord)) continue;
          coordinateSet.add(coord);
          itemAdditions.next(repoItemChunk(coord));
        }
      },
      error: (err) => subscriber.error(err),
      // Completion means no further growth — the subscription lives on.
    });

    return () => {
      relaySub.unsubscribe();
      itemSub.unsubscribe();
      coordsSub.unsubscribe();
      inboxSubs.unsubscribe();
    };
  });
}

/**
 * Repo-level observable factory.
 *
 * Subscribes to all NIP-34 root items (issues + PR/patch roots) and trusted
 * software applications for the repository's confirmed coordinates via the
 * relay group. For each newly discovered root item ID, calls nip34ListLoader
 * so essentials and comments are fetched. Software applications are written
 * to the EventStore as priority repository data but do not fire item loaders.
 *
 * Inputs are reactive: the confirmed coordinate set and role history arrive
 * via inputs$ and may change while the subscription is live.
 *
 *   - Coordinate growth (a maintainer confirming later) folds into the live
 *     relay subscriptions as content-keyed additive chunks — one delta REQ
 *     per relay carrying only the new coordinate's filters. Existing REQs,
 *     seenIds, and knownRelayUrls are untouched, so already-seen items never
 *     re-fire their essentials/comments loaders.
 *   - Re-presenting an unchanged coordinate set and role history is a strict
 *     no-op: zero REQs, zero loader re-fires.
 *   - Coordinate removal is ignored: the removed coordinate's REQs stay live
 *     until the subscription ends. Authority is enforced by the list models
 *     reading the store, never by what this loader fetched.
 *   - A repository identity change (different selected pubkey/dTag) must be
 *     a new subscription — callers key their use$ on the relay group, which
 *     is model-cached per (pubkey, dTag).
 *
 * Deduplication: a seenIds Set in the closure ensures each item ID is
 * submitted to the loaders exactly once, regardless of how many times the
 * relay re-delivers the root event. The set is fresh per subscription —
 * navigating away and back creates a new observable with a new set,
 * triggering a fresh fetch.
 *
 * Because nip34EssentialsLoader and nip34CommentsLoader are singleton
 * instances backed by batchLoader, all per-item calls within each loader's
 * bufferTime window are collapsed into a single relay subscription — so N
 * items produce one essentials REQ and one comments REQ, not 2N REQs.
 *
 * @param inputs$    - Reactive coordinates + role history (grow-only coords)
 * @param relayGroup - Relay group from useResolvedRepository
 */
export function nip34RepoLoader(
  inputs$: Observable<Nip34RepoLoaderInputs>,
  relayGroup: RelayGroup,
  privateRepository = false,
): Observable<NostrEvent> {
  const resolveAuthorInbox =
    !privateRepository && relayCurationMode.getValue() === "outbox";

  return new Observable<NostrEvent>((subscriber) => {
    const seenIds = new Set<string>();
    const knownRelayUrls = new Set<string>();
    const inboxSubs = new Subscription();

    // Grow-only coordinate state shared by every subscription below.
    // coordinateSet is read by isRepositoryRootItem at delivery time, so
    // items tagged only with a late coordinate pass once it has joined.
    const coordinateSet = new Set<string>();
    const maintainerPubkeys = new Set<string>();
    const emittedAppChunkKeys = new Set<string>();
    const coordsList$ = new BehaviorSubject<string[]>([]);
    const roleHistory$ = new BehaviorSubject<RepositoryRoleHistory | undefined>(
      undefined,
    );
    let lastRoleHistoryKey = roleHistoryCacheKey(undefined);

    const itemAdditions = new Subject<AdditiveFilterChunk>();
    const appAdditions = new Subject<AdditiveFilterChunk>();
    const metaAdditions = new Subject<AdditiveFilterChunk>();

    function fireLoaders(id: string, relays: string[]): void {
      nip34ListLoader(id, relays).subscribe({
        next: (msg) => {
          if (msg !== "EOSE") subscriber.next(msg as NostrEvent);
        },
      });
    }

    function fireAuthorInboxLoaders(ev: NostrEvent): void {
      const perItemQueried = new Set(knownRelayUrls);
      addressLoader({ kind: 10002, pubkey: ev.pubkey }).subscribe();
      const s = eventStore
        .model(MailboxesModel, ev.pubkey)
        .pipe(
          filter((m): m is NonNullable<typeof m> => m !== undefined),
          take(1),
        )
        .subscribe((mailboxes) => {
          const newRelays = mailboxes.inboxes
            .slice(0, MAX_AUTHOR_INBOX_RELAYS)
            .map(normalizeUrl)
            .filter((r) => !perItemQueried.has(r));
          if (newRelays.length === 0) return;
          for (const r of newRelays) perItemQueried.add(r);
          nip34ListLoader(ev.id, newRelays).subscribe({
            next: (msg) => {
              if (msg !== "EOSE") subscriber.next(msg as NostrEvent);
            },
          });
        });
      inboxSubs.add(s);
    }

    // When new relays join the group, re-fire existing items' loaders against
    // those new relays only. createPaginatedTagValueLoader batches all these
    // calls within its buffer window into a single REQ per relay.
    const relaySub = relayGroupUrls$(relayGroup)
      .pipe(
        distinctUntilChanged(
          (a, b) =>
            a.length === b.length && a.every((url) => knownRelayUrls.has(url)),
        ),
      )
      .subscribe((currentUrls) => {
        const newUrls = currentUrls.filter((url) => !knownRelayUrls.has(url));
        for (const url of newUrls) knownRelayUrls.add(url);
        if (newUrls.length === 0) return;
        for (const id of seenIds) {
          fireLoaders(id, newUrls);
        }
      });

    // Fetch software applications in their own REQ, separate from the
    // potentially large issue/PR query. Some relays merge and
    // chronologically order all filters in a single REQ before sending any
    // events, which can leave an older application event behind the
    // repository's item backlog. Chunks are keyed per (author, coordinate)
    // pair so a maintainer confirmed later adds delta REQs only.
    const softwareApplicationSub = privateRepository
      ? new Subscription()
      : resilientAdditiveSubscription(
          pool,
          relayGroupUrls$(relayGroup),
          { initial: [], additions$: appAdditions },
          { reconnect: true, gapFill: true, settle: false },
        )
          .pipe(onlyEvents(), mapEventsToStore(eventStore))
          .subscribe({ error: (err) => subscriber.error(err) });

    const itemSub = resilientAdditiveSubscription(
      pool,
      relayGroupUrls$(relayGroup),
      { initial: [], additions$: itemAdditions },
      { reconnect: true, gapFill: true, settle: false },
    )
      .pipe(
        onlyEvents(),
        filter((event) => isRepositoryRootItem(event, coordinateSet)),
        mapEventsToStore(eventStore),
      )
      .subscribe({
        next: (event) => {
          const ev = event as NostrEvent;
          if (!REPO_ITEM_KINDS.some((kind) => kind === ev.kind)) return;
          if (!seenIds.has(ev.id)) {
            seenIds.add(ev.id);
            // knownRelayUrls is already populated by relaySub above
            // (relayGroupUrls$ is a BehaviorSubject so relaySub fires
            // synchronously before itemSub can emit).
            fireLoaders(ev.id, [...knownRelayUrls]);
            if (resolveAuthorInbox) fireAuthorInboxLoaders(ev);
          }
        },
        error: (err) => subscriber.error(err),
      });

    const repoMetaSub = privateRepository
      ? new Subscription()
      : resilientAdditiveSubscription(
          pool,
          relayGroupUrls$(relayGroup),
          { initial: [], additions$: metaAdditions },
          { reconnect: true, gapFill: true, settle: false },
        )
          .pipe(onlyEvents(), mapEventsToStore(eventStore))
          .subscribe({ error: (err) => subscriber.error(err) });

    // Discover inferred stack parents via repository-scoped #c queries.
    // Historical PR updates loaded by the list loaders participate too.
    // Each (coordinate, merge base) pair is one immutable keyed chunk: a
    // commit or coordinate discovered later (a merge base arriving
    // asynchronously, a maintainer confirming late) opens a single delta
    // REQ per relay instead of restarting the whole subscription.
    const emittedStackChunkKeys = new Set<string>();
    const stackCandidateChunks$ = combineLatest([
      coordsList$,
      roleHistory$,
    ]).pipe(
      switchMap(([coords, roleHistory]) => {
        if (coords.length === 0) return EMPTY;
        return eventStore
          .timeline([{ kinds: [1618, 1619], "#a": coords } as Filter])
          .pipe(
            map((events) => {
              const repositoryEvents = events as NostrEvent[];
              return [
                ...new Set(
                  getEffectivePRMergeBases(
                    repositoryEvents.filter((event) => event.kind === 1618),
                    repositoryEvents.filter((event) => event.kind === 1619),
                    coords,
                    roleHistory,
                  ).values(),
                ),
              ].sort();
            }),
            // Scoped inside switchMap so every coordinate/role-history
            // epoch re-presents its merge bases once; emittedStackChunkKeys
            // keeps that re-presentation a no-op for known pairs.
            distinctUntilChanged(
              (a, b) =>
                a.length === b.length &&
                a.every((value, index) => b[index] === value),
            ),
            map((mergeBases) => ({ coords, mergeBases })),
          );
      }),
      mergeMap(({ coords, mergeBases }) =>
        from(
          mergeBases.flatMap((mergeBase) =>
            coords.flatMap((coord): AdditiveFilterChunk[] => {
              const key = `${coord}|${mergeBase}`;
              if (emittedStackChunkKeys.has(key)) return [];
              const candidateFilter = buildStackCandidateFilter(
                [coord],
                [mergeBase],
              );
              if (!candidateFilter) return [];
              emittedStackChunkKeys.add(key);
              return [{ key, filters: [candidateFilter], deltaSafe: true }];
            }),
          ),
        ),
      ),
    );
    const stackCandidateSub = resilientAdditiveSubscription(
      pool,
      relayGroupUrls$(relayGroup),
      { initial: [], additions$: stackCandidateChunks$ },
      { reconnect: true, gapFill: true, settle: false },
    )
      .pipe(
        onlyEvents(),
        mapEventsToStore(eventStore),
        catchError(() => EMPTY),
      )
      .subscribe();

    // Subscribed after every consumer above so a synchronous first emission
    // (BehaviorSubject) reaches the live additive subscriptions. Growth is
    // content-keyed: only genuinely new coordinates or changed role-history
    // content produce chunk emissions; anything else is a strict no-op.
    const inputsSub = inputs$.subscribe({
      next: ({ coords, roleHistory }) => {
        const newCoords = [...new Set(coords)].filter(
          (coord) => !coordinateSet.has(coord),
        );
        const roleHistoryKey = roleHistoryCacheKey(roleHistory);
        const roleHistoryChanged = roleHistoryKey !== lastRoleHistoryKey;
        if (newCoords.length === 0 && !roleHistoryChanged) return;
        for (const coord of newCoords) {
          coordinateSet.add(coord);
          const parsed = parseRepoCoordinate(coord);
          if (parsed) maintainerPubkeys.add(parsed.pubkey);
        }
        // Software applications span authors × coordinates; emit the pairs
        // not yet covered (new author × all coordinates, all authors × new
        // coordinates), pushed before the item chunks so the small
        // application REQ is not queued behind the item backlog.
        for (const pubkey of maintainerPubkeys) {
          for (const coord of coordinateSet) {
            const chunk = softwareApplicationChunk(pubkey, coord);
            if (emittedAppChunkKeys.has(chunk.key)) continue;
            emittedAppChunkKeys.add(chunk.key);
            appAdditions.next(chunk);
          }
        }
        for (const coord of newCoords) {
          itemAdditions.next(repoItemChunk(coord));
          metaAdditions.next(repoMetaChunk(coord));
        }
        if (newCoords.length > 0) coordsList$.next([...coordinateSet].sort());
        if (roleHistoryChanged) {
          lastRoleHistoryKey = roleHistoryKey;
          roleHistory$.next(roleHistory);
        }
      },
      error: (err) => subscriber.error(err),
      // Completion means no further growth — the subscription lives on.
    });

    return () => {
      relaySub.unsubscribe();
      softwareApplicationSub.unsubscribe();
      itemSub.unsubscribe();
      repoMetaSub.unsubscribe();
      stackCandidateSub.unsubscribe();
      inputsSub.unsubscribe();
      inboxSubs.unsubscribe();
    };
  });
}

/**
 * Fire all three thread loaders for a single event ID against a specific
 * relay list (static snapshot at call time).
 */
function nip34ThreadLoadAll(
  itemId: string,
  relays: string[],
): Observable<PaginatedTagValueResponse> {
  return merge(
    nip34ThreadReplyLoader({ value: itemId, relays }),
    nip34ThreadRootLoader({ value: itemId, relays }),
    nip34ThreadQuoteLoader({ value: itemId, relays }),
  );
}

/**
 * Thread-level loader for a single item (detail pages only).
 *
 * Fetches the complete closure of events that reference the root item or any
 * event discovered beneath it via #e, #E, or #q tags — no kind restriction.
 * This includes comments, reactions, zaps, deletions, quotes, revisions, and
 * events that target any of those descendants.
 *
 * Does NOT re-fire essentials or comments — those are handled separately
 * by nip34ListLoader (already called at the repo/list level). The no-kind
 * thread loaders will return some of the same events (the EventStore
 * deduplicates on receipt).
 *
 * Every discovered event ID is queued exactly once per relay. This makes the
 * traversal insensitive to relay delivery order (for example, a parent
 * comment arriving after its reaction) while the singleton tag loaders still
 * collapse each discovery wave into one subscription per tag and relay.
 *
 * Reactive relay list: accepts Observable<string[]> | string[]. When the
 * observable emits new relay URLs, loaders are re-fired for all already-seen
 * event IDs against only the new relays — existing subscriptions are
 * untouched. New descendants are always fetched against all current relays.
 *
 * @param itemId - The event ID of the issue / patch / PR
 * @param relays - Relay URLs to query (reactive or static)
 */
export function nip34ThreadItemLoader(
  itemId: string,
  relays: Observable<string[]> | string[],
): Observable<PaginatedTagValueResponse> {
  return loadEventReferenceClosure(itemId, relays, nip34ThreadLoadAll);
}
