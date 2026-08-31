/**
 * repoStateLoader
 *
 * Fetches kind:30618 repository state events from a relay group, querying
 * each relay individually so that every relay's version of the addressable
 * event is observed before the EventStore deduplicates them.
 *
 * Why per-relay queries matter:
 *   Grasp servers only serve the state event that matches the git data they
 *   hold. A server that is behind the canonical state will serve an older
 *   version of the event. By querying each relay separately we can collect
 *   all versions and later determine whether a behind-server has a previously
 *   signed state (out of scope for this loader — it just delivers the raw
 *   events).
 *
 * Deduplication and relay provenance:
 *   resilientSubscription does NOT deduplicate events — it emits every event
 *   from every relay. The Relay class stamps each event with addSeenRelay
 *   before it reaches this loader, so older versions from behind-servers
 *   still carry their source relay URL when they hit mapEventsToStore().
 *   The EventStore deduplicates by created_at (keeps newest) but the relay
 *   provenance is already recorded, so getSeenRelays(event) works correctly
 *   on any event retrieved from the store later.
 *
 * Reactive relay list:
 *   resilientAdditiveSubscription's Observable<string[]> overload diffs the
 *   relay set on each emission: a joining relay receives one REQ over the
 *   full current chunk set, removed relays are unsubscribed. Existing relay
 *   streams are never disturbed.
 *
 * Reactive maintainer list:
 *   Each confirmed maintainer becomes one content-keyed additive filter chunk
 *   ({kinds:[30618], authors:[pubkey], "#d":[dTag]}). A newly confirmed
 *   maintainer folds into the live subscription as one delta REQ per relay;
 *   re-presenting an unchanged maintainer set is a strict no-op (canonical
 *   duplicate chunks are ignored). There is no chunk retraction — a removed
 *   maintainer's REQ stays live until the caller unsubscribes; authority is
 *   enforced by the store-reading consumers, never by what was fetched.
 *
 * Reconnect:
 *   resilientAdditiveSubscription keeps each per-relay stream alive with smart
 *   reconnect (since: lastReceivedAt - gapFillBuffer) and foreground resume
 *   gap-fill, so live state updates are received reliably.
 *
 * EventStore + relay provenance:
 *   The Relay class applies `addSeenRelay` internally on every req, so each
 *   event is already stamped with its source relay URL before it reaches this
 *   loader. mapEventsToStore() then writes those stamped events into the store,
 *   meaning getSeenRelays(event) works on any event retrieved from the store.
 *   Callers can build a per-relay state registry purely from store.timeline()
 *   without any side-channel state.
 */

import type { RelayPool } from "applesauce-relay";
import { onlyEvents } from "applesauce-relay";
import type { IEventStore } from "applesauce-core/event-store";
import { mapEventsToStore } from "applesauce-core";
import type { Filter } from "applesauce-core/helpers";
import type { NostrEvent } from "nostr-tools";
import type { Observable } from "rxjs";
import { EMPTY, merge } from "rxjs";
import { catchError, filter, map, mergeMap, share } from "rxjs/operators";
import {
  resilientAdditiveSubscription,
  type AdditiveFilterChunk,
} from "./resilientSubscription";
import { DEFAULT_SETTLE_TIME } from "./settleSignal";

export type RepoStateResponse = NostrEvent | "EOSE";

export interface RepoStateLoaderOptions {
  /**
   * Debounce window in ms before emitting "EOSE" after the last relay
   * finishes (default 200 — matches createPaginatedTagValueLoader).
   */
  settleTime?: number;
}

/**
 * One immutable additive chunk: the kind:30618 state query for one confirmed
 * maintainer. Exact kinds/authors/tag values only, so it is delta-safe.
 */
function maintainerStateChunk(
  dTag: string,
  pubkey: string,
): AdditiveFilterChunk {
  return {
    key: `state:${pubkey}`,
    filters: [{ kinds: [30618], authors: [pubkey], "#d": [dTag] } as Filter],
    deltaSafe: true,
  };
}

/**
 * Fetch all versions of the kind:30618 repository state event from every
 * relay in the provided relay list, writing events into the EventStore as
 * they arrive.
 *
 * Uses resilientAdditiveSubscription with the reactive relay-list overload
 * and one content-keyed chunk per confirmed maintainer so that:
 *   - Each relay gets its own per-relay stream with smart reconnect and
 *     foreground resume gap-fill, keeping the subscription alive for live
 *     state updates.
 *   - New relays added to relays$ are picked up automatically (one REQ over
 *     the current chunk set on the joining relay only); removed relays are
 *     unsubscribed without disturbing existing streams.
 *   - New maintainers emitted on maintainers$ join as one delta REQ per
 *     relay; an unchanged maintainer set is a strict no-op.
 *   - Events are NOT deduplicated by the subscription — every relay's
 *     version flows through to mapEventsToStore(), which stamps relay
 *     provenance before the EventStore deduplicates by created_at.
 *
 * Emits NostrEvent | "EOSE". "EOSE" fires once all relays known at
 * subscription start have settled (debounced by settleTime ms); later
 * maintainer additions never unsettle it, matching the monotonic latch
 * semantics in useRepositoryState.
 *
 * Does not complete — callers should unsubscribe when done (use$ handles this).
 *
 * @param pool      - Global RelayPool
 * @param relays$   - Observable<string[]> of relay URLs; emits additively as
 *                    new relays are discovered (e.g. from relayGroupUrls$())
 * @param dTag         - Repository d-tag identifier
 * @param maintainers$ - Observable of the current reciprocal maintainer
 *                       authority set; emissions grow the query additively
 * @param eventStore   - EventStore to write events into
 * @param opts         - Optional settleTime override
 */
export function loadRepoStateFromRelays(
  pool: RelayPool,
  relays$: Observable<string[]>,
  dTag: string,
  maintainers$: Observable<string[]>,
  eventStore: IEventStore,
  opts: RepoStateLoaderOptions = {},
): Observable<RepoStateResponse> {
  // Every emitted maintainer becomes one keyed chunk; canonical duplicates
  // are dropped by the additive primitive, so re-emitting the same set costs
  // nothing. Chunks arriving synchronously (BehaviorSubject) are folded into
  // the initial per-relay REQs.
  const additions$ = maintainers$.pipe(
    mergeMap((maintainers) => maintainers),
    map((pubkey) => maintainerStateChunk(dTag, pubkey)),
  );

  // Split into two branches sharing the same source so that:
  //   • Events are written into the store (mapEventsToStore) and passed through.
  //   • "EOSE" sentinel reaches the caller — onlyEvents() would strip it, so
  //     it must be passed through a separate branch.
  const raw$ = resilientAdditiveSubscription(
    pool,
    relays$,
    { initial: [], additions$ },
    {
      settleTime: opts.settleTime ?? DEFAULT_SETTLE_TIME,
      // Keep subscriptions alive for live state updates — reconnect and
      // gap-fill are the whole point of using the resilient primitive here.
      // (Pagination is not applicable: kind:30618 is addressable; there is
      // at most one current version per pubkey+d-tag combination per relay.)
      reconnect: true,
      gapFill: true,
    },
  ).pipe(
    catchError(() => EMPTY),
    share(),
  );

  return merge(
    // Write events into the store; pass them downstream as RepoStateResponse.
    raw$.pipe(onlyEvents(), mapEventsToStore(eventStore)),
    // Let the EOSE sentinel through to the caller.
    raw$.pipe(filter((msg): msg is "EOSE" => msg === "EOSE")),
  ) as Observable<RepoStateResponse>;
}
