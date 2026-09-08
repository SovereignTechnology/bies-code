import { useState, useEffect } from "react";
import { use$ } from "./use$";
import { useEventStore } from "./useEventStore";
import { REPO_STATE_KIND } from "@/lib/nip34";
import {
  RepositoryState,
  isValidRepositoryState,
} from "@/casts/RepositoryState";
import type { CastRefEventStore } from "applesauce-common/casts/cast";
import type { Filter } from "applesauce-core/helpers";
import { getSeenRelays } from "applesauce-core/helpers";
import type { Observable } from "rxjs";
import { map } from "rxjs/operators";
import type { RelayGroup } from "applesauce-relay";
import type { NostrEvent } from "nostr-tools";
import { relayGroupUrls$ } from "@/models/RepositoryRelayGroup";
import type { RelaySubscriptionCoverage } from "@/lib/relaySubscriptionCoverage";

/**
 * Pick the winning state event from a list of candidates.
 *
 * NIP-34 says the latest `created_at` wins; event ID is the tiebreaker
 * (lexicographically lower ID wins) so the result is deterministic.
 */
function pickWinningStateEvent(
  events: { id: string; created_at: number; pubkey: string }[],
): { id: string; created_at: number; pubkey: string } | undefined {
  if (events.length === 0) return undefined;
  return events.reduce((best, ev) => {
    if (ev.created_at > best.created_at) return ev;
    if (ev.created_at === best.created_at && ev.id < best.id) return ev;
    return best;
  });
}

/**
 * Reactively select the winning kind:30618 repository state event loaded by
 * the page-owned repository replaceable subscription, while also tracking the
 * per-relay state registry.
 *
 * The "winner" is the state event with the latest `created_at` among all
 * maintainers, with the event ID as a tiebreaker (lexicographically lower
 * ID wins). This matches the NIP-34 spec.
 *
 * Each relay in the group is queried individually so that every relay's
 * version of the addressable event is observed. The loader stamps each event
 * with its source relay via `addSeenRelay` before writing it to the
 * EventStore, so getSeenRelays(event) is available on any stored event.
 *
 * Returns a tuple of:
 *   - The winning `RepositoryState` cast, `null` when none exists, or
 *     `undefined` while the initial Nostr query is still in flight.
 *   - `repoRelayEose`: `true` once every current repository relay has either
 *     covered the shared filter revision or reached a terminal/settlement
 *     phase. It returns to false for a reconnect, catch-up, new relay, or
 *     changed authority revision.
 *   - `relayStateMap`: `Map<relayUrl, NostrEvent>` — the best state event
 *     seen from each relay, derived reactively from the EventStore via
 *     getSeenRelays(). Callers can use this to determine whether a Grasp
 *     server is behind the canonical state and what commit it last announced.
 *   - `stateEvents`: typed casts for every valid state event considered for
 *     this repository, or `undefined` until the store first emits. Acceptance
 *     flows use these to compare the invitee's refs with the canonical state.
 *
 * @param dTag           - The repository d-tag identifier
 * @param confirmedMaintainers - Current reciprocal maintainer authority set
 * @param repoRelayGroup - The relay group to query (from useResolvedRepository)
 * @param coverage       - The page-owned announcement/state lifecycle evidence
 */
export function useRepositoryState(
  dTag: string | undefined,
  confirmedMaintainers: string[] | undefined,
  repoRelayGroup: RelayGroup | undefined,
  coverage: RelaySubscriptionCoverage | undefined,
): [
  RepositoryState | null | undefined,
  boolean,
  Map<string, NostrEvent>,
  RepositoryState[] | undefined,
] {
  const store = useEventStore();
  const castStore = store as unknown as CastRefEventStore;

  const maintainerKey = confirmedMaintainers?.join(",") ?? "";
  // The shared subscription owns network IO. This hook projects its lifecycle
  // into the legacy all-relays-settled signal used by repository read UIs.
  const [repoRelayEose, setRepoRelayEose] = useState<boolean>(
    () => repoRelayGroup === undefined,
  );

  useEffect(() => {
    if (!dTag || !confirmedMaintainers?.length || !repoRelayGroup) {
      setRepoRelayEose(true);
      return;
    }

    let relayUrls: string[] = [];
    const update = () => {
      if (relayUrls.length === 0) {
        setRepoRelayEose(true);
        return;
      }
      setRepoRelayEose(
        relayUrls.every((relay) => {
          const phase = coverage?.get(relay)?.phase;
          return (
            phase !== undefined &&
            phase !== "initial" &&
            phase !== "catching-up"
          );
        }),
      );
    };
    const relaySub = relayGroupUrls$(repoRelayGroup).subscribe((next) => {
      relayUrls = next;
      update();
    });
    const coverageSub = coverage?.changes$.subscribe(update);
    update();

    return () => {
      relaySub.unsubscribe();
      coverageSub?.unsubscribe();
    };
  }, [dTag, maintainerKey, repoRelayGroup, coverage, confirmedMaintainers]);

  const storeFilter: Filter = {
    kinds: [REPO_STATE_KIND],
    authors: confirmedMaintainers ?? [],
    "#d": dTag ? [dTag] : [],
  } as Filter;

  // Read back from the store and pick the winner.
  // store.timeline() is reactive — it re-emits whenever new events arrive,
  // so the winning state updates automatically as relays respond.
  const repoState = use$(() => {
    if (!dTag || !confirmedMaintainers || confirmedMaintainers.length === 0)
      return undefined;

    return store.timeline([storeFilter]).pipe(
      map((events) => {
        const valid = events.filter(isValidRepositoryState);
        if (valid.length === 0) return null;
        const winner = pickWinningStateEvent(valid);
        if (!winner) return null;
        const winnerEvent = valid.find((e) => e.id === winner.id);
        if (!winnerEvent) return null;
        try {
          return new RepositoryState(winnerEvent, castStore);
        } catch {
          return null;
        }
      }),
    ) as unknown as Observable<RepositoryState | null>;
  }, [dTag, maintainerKey, store]);

  const stateEvents = use$(() => {
    if (!dTag || !confirmedMaintainers || confirmedMaintainers.length === 0)
      return undefined;

    return store.timeline([storeFilter]).pipe(
      map((events) =>
        events.flatMap((event) => {
          if (!isValidRepositoryState(event)) return [];
          try {
            return [new RepositoryState(event, castStore)];
          } catch {
            return [];
          }
        }),
      ),
    ) as unknown as Observable<RepositoryState[]>;
  }, [dTag, maintainerKey, store]);

  // Per-relay state registry: for each relay URL, keep the best state event
  // seen from that relay. Derived reactively from the store — no side-channel
  // state needed because the loader stamps each event with its source relay
  // via `addSeenRelay` before writing it to the store.
  //
  // For each valid state event, getSeenRelays() returns the set of relay URLs
  // it was received from. We invert that: for each relay URL, we keep the
  // event with the highest created_at (lowest event ID as tiebreaker).
  const relayStateMap = use$(() => {
    if (!dTag || !confirmedMaintainers || confirmedMaintainers.length === 0)
      return undefined;

    return store.timeline([storeFilter]).pipe(
      map((events) => {
        const result = new Map<string, NostrEvent>();
        for (const event of events) {
          if (!isValidRepositoryState(event)) continue;
          const seenOn = getSeenRelays(event);
          if (!seenOn) continue;
          for (const relayUrl of seenOn) {
            const existing = result.get(relayUrl);
            if (
              !existing ||
              event.created_at > existing.created_at ||
              (event.created_at === existing.created_at &&
                event.id < existing.id)
            ) {
              result.set(relayUrl, event);
            }
          }
        }
        return result;
      }),
    ) as unknown as Observable<Map<string, NostrEvent>>;
  }, [dTag, maintainerKey, store]);

  return [repoState, repoRelayEose, relayStateMap ?? new Map(), stateEvents];
}
