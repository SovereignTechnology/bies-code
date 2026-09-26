import type { Model } from "applesauce-core/event-store";
import { Observable, Subscription } from "rxjs";

import {
  announcementSnapshot,
  type AnnouncementSnapshotState,
} from "@/lib/announcementSnapshot";
import type { ResolvedRepo } from "@/lib/nip34";
import { RepositoryModel } from "@/models/RepositoryModel";
import { pool } from "@/services/nostr";
import { fallbackRelays, gitIndexRelays } from "@/services/settings";

export interface SettledRepositorySnapshot {
  repository?: ResolvedRepo;
  settled: boolean;
  /**
   * Snapshot relays whose announcement or deletion query failed. The snapshot
   * still settles boundedly — degraded coverage is visible, not blocking.
   */
  failedRelayCount: number;
}

/**
 * Resolve one coordinate behind a monotonic initial snapshot: one
 * identifier-only announcement wave `{kinds: [30617], "#d": [dTag]}` over the
 * relays known at start (git index ∪ fallback ∪ repo-declared), followed by
 * one bounded deletion follow-up computed from the closure resolvable at the
 * wave's completion. Relay failures count toward completion, so `settled`
 * latches true exactly once and never re-arms.
 *
 * Everything discovered afterwards — new authors, announcements, relays — is
 * progressive enrichment: `repository` keeps updating from the reciprocal
 * resolution model, but eligibility (the `settled` flag consumed by
 * `RepositorySelectionModel`) is never re-gated. Mailbox (kind 10002)
 * resolution is enrichment handled elsewhere and no longer participates in
 * settlement. Authority is never derived from the identifier-only fetch; it
 * comes exclusively from reciprocal resolution rooted at the selected
 * maintainer (AGENTS.md §Repository authorization model carve-out).
 *
 * `settled` with `failedRelayCount > 0` means bounded-but-degraded coverage.
 * Mutation safety keeps its own stricter complete-relay snapshot.
 */
export function SettledRepositoryModel(
  selectedMaintainer: string,
  dTag: string,
): Model<SettledRepositorySnapshot> {
  return (store) =>
    new Observable<SettledRepositorySnapshot>((observer) => {
      const subs = new Subscription();
      let repository: ResolvedRepo | undefined;
      let snapshot: AnnouncementSnapshotState = {
        firstFreshEose: false,
        settlement: { settled: false, relayCount: 0, failedRelayCount: 0 },
      };
      const emit = () =>
        observer.next({
          repository,
          settled: snapshot.settlement.settled,
          failedRelayCount: snapshot.settlement.failedRelayCount,
        });

      // Progressive resolution — RepositoryModel emits synchronously with the
      // current store state, so `repository` (and its declared relays, read
      // below) is populated before the snapshot's relay set is fixed.
      subs.add(
        (
          store.model(
            RepositoryModel,
            selectedMaintainer,
            dTag,
          ) as unknown as Observable<ResolvedRepo | undefined>
        ).subscribe((nextRepository) => {
          repository = nextRepository;
          emit();
        }),
      );

      subs.add(
        announcementSnapshot({
          pool,
          store,
          pubkey: selectedMaintainer,
          dTag,
          primaryRelays: [
            ...gitIndexRelays.getValue(),
            ...fallbackRelays.getValue(),
            ...(repository?.relays ?? []),
          ],
        }).subscribe((nextSnapshot) => {
          snapshot = nextSnapshot;
          emit();
        }),
      );

      return () => subs.unsubscribe();
    });
}
