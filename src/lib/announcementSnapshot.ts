import type { Filter } from "applesauce-core/helpers";
import type { RelayPool } from "applesauce-relay";
import type { NostrEvent } from "nostr-tools";
import { Observable, Subscription } from "rxjs";
import { take } from "rxjs/operators";

import { REPO_KIND, type ResolvedRepo } from "@/lib/nip34";
import type { RelayQuerySettlement } from "@/lib/relayQuerySettlement";
import { resilientRequest } from "@/lib/resilientSubscription";
import { normalizeUrl } from "@/lib/url";
import { RepositoryModel } from "@/models/RepositoryModel";

const DELETION_KIND = 5;

/**
 * Minimal store surface the snapshot needs — deliberately structural so both
 * the concrete EventStore (hooks) and the store wrapper handed to Model
 * factories satisfy it.
 */
export interface AnnouncementSnapshotStore {
  add(event: NostrEvent): unknown;
  model(
    factory: typeof RepositoryModel,
    selectedMaintainer: string,
    dTag: string,
  ): unknown;
}

/**
 * Tiered readiness of the monotonic announcement snapshot.
 *
 * The snapshot is keyed once at subscription time on (pubkey, dTag, relays)
 * and never re-arms: authors, announcement IDs, and relays discovered later
 * are progressive enrichment handled outside this observable.
 */
export interface AnnouncementSnapshotState {
  /**
   * True once any snapshot relay has delivered an actual EOSE for the
   * identifier-only announcement wave this session. Cached store data alone
   * never sets this — a stale cached graph from a previous visit must not
   * authorize a redirect that then bounces.
   */
  firstFreshEose: boolean;
  /**
   * Full-snapshot settlement: the identifier-only announcement wave plus the
   * one-shot deletion follow-up over every snapshot relay. Relay failures
   * count toward completion (`failedRelayCount`), so settlement is finite and
   * degraded coverage is visible rather than blocking. Monotonic — `settled`
   * never returns to false.
   */
  settlement: RelayQuerySettlement;
}

export interface AnnouncementSnapshotOptions {
  pool: RelayPool;
  store: AnnouncementSnapshotStore;
  /** Selected maintainer pubkey — the trust root for reciprocal resolution. */
  pubkey: string;
  dTag: string;
  /** Immediate tier — queried as soon as the snapshot starts. */
  primaryRelays: string[];
  /**
   * Deferred tier — queried only when the primary wave settles without the
   * selected coordinate's announcement (mirrors the useEventSearch fallback
   * tiering). Once activated, these relays join the snapshot's relay count
   * and settlement.
   */
  deferredRelays?: string[];
}

/**
 * Monotonic initial routing snapshot for one repository coordinate.
 *
 * Stage 1 sends the identifier-only announcement REQ
 * `{kinds: [30617], "#d": [dTag]}` over the primary relays. The filter carries
 * no `authors`, so newly discovered maintainers never change it — author
 * growth is free and the snapshot never restarts. Authority is NOT derived
 * from this fetch: it is established exclusively by reciprocal resolution
 * (`resolveChain` via `RepositoryModel`) rooted at `pubkey` (see AGENTS.md
 * §Repository authorization model, announcement-discovery carve-out).
 *
 * Stage 2 fires one deletion follow-up REQ whose `#a`/`#e` values are computed
 * once from the closure resolvable at stage 1's completion, over the same
 * relays. Deletions arriving later on enrichment relays still flow into the
 * store; only the settlement marker is bounded here.
 *
 * All events reach the store before the corresponding settle marker fires.
 */
export function announcementSnapshot({
  pool,
  store,
  pubkey,
  dTag,
  primaryRelays,
  deferredRelays = [],
}: AnnouncementSnapshotOptions): Observable<AnnouncementSnapshotState> {
  return new Observable<AnnouncementSnapshotState>((subscriber) => {
    const primary = dedupeRelayUrls(primaryRelays);
    const deferred = dedupeRelayUrls(deferredRelays).filter(
      (relay) => !primary.includes(relay),
    );

    const subs = new Subscription();
    const failedRelays = new Set<string>();
    let relayCount = primary.length;
    let firstFreshEose = false;
    let settled = false;

    const emit = () =>
      subscriber.next({
        firstFreshEose,
        settlement: {
          settled,
          relayCount,
          failedRelayCount: failedRelays.size,
        },
      });

    const identifierFilter: Filter = {
      kinds: [REPO_KIND],
      "#d": [dTag],
    } as Filter;

    /**
     * Run one bounded wave. Completion follows resilientRequest's aggregate
     * EOSE, which counts failed relays as settled — so the wave always ends.
     * `trackFresh` marks the first actual per-relay EOSE (announcement waves
     * only; the deletion follow-up never drives the fresh tier).
     */
    const wave = (
      relays: string[],
      filters: Filter[],
      trackFresh: boolean,
      done: () => void,
    ): void => {
      if (relays.length === 0) {
        done();
        return;
      }
      let finished = false;
      const finish = () => {
        if (finished) return;
        finished = true;
        done();
      };
      subs.add(
        resilientRequest(pool, relays, filters, {
          onRelayEose: trackFresh
            ? () => {
                if (!firstFreshEose) {
                  firstFreshEose = true;
                  emit();
                }
              }
            : undefined,
          onRelayError: (relay) => {
            failedRelays.add(relay);
            if (!settled) emit();
          },
        }).subscribe({
          next: (message) => {
            if (message === "EOSE") finish();
            else store.add(message);
          },
          error: () => finish(),
          complete: () => finish(),
        }),
      );
    };

    const settle = () => {
      settled = true;
      emit();
      subscriber.complete();
    };

    /**
     * Stage 2: deletion follow-up computed once from the closure resolvable
     * now. The reciprocal graph plus history authors are read through the
     * cached RepositoryModel, which reflects everything stage 1 added to the
     * store. The route pubkey is always included so a deletion of the
     * selected announcement itself is retrievable by `#a` even when the
     * announcement is no longer returned by any relay.
     */
    const startDeletionFollowUp = (relays: string[]) => {
      subs.add(
        (
          store.model(RepositoryModel, pubkey, dTag) as unknown as Observable<
            ResolvedRepo | undefined
          >
        )
          .pipe(take(1))
          .subscribe((repository) => {
            const authors = [
              ...new Set([
                pubkey,
                ...(repository?.discoveryPubkeys ?? []),
                ...(repository?.historyPubkeys ?? []),
              ]),
            ].sort();
            const announcementIds = [
              ...new Set(
                [
                  ...(repository?.discoveredAnnouncements ?? []),
                  ...(repository?.historicalAnnouncements ?? []),
                ].map(({ id }) => id),
              ),
            ].sort();
            const filters: Filter[] = [
              {
                kinds: [DELETION_KIND],
                authors,
                "#a": authors.map((author) => `${REPO_KIND}:${author}:${dTag}`),
              } as Filter,
              ...(announcementIds.length > 0
                ? [
                    {
                      kinds: [DELETION_KIND],
                      authors,
                      "#e": announcementIds,
                    } as Filter,
                  ]
                : []),
            ];
            wave(relays, filters, false, settle);
          }),
      );
    };

    emit();
    wave(primary, [identifierFilter], true, () => {
      // Deferred fallback tier: only when the immediate tier could not
      // produce a resolvable coordinate (repos not indexed by the git index
      // are still findable on fallback relays). The cached RepositoryModel
      // reads the store synchronously, so anything this wave added — or a
      // previously cached announcement — is visible here.
      subs.add(
        (
          store.model(RepositoryModel, pubkey, dTag) as unknown as Observable<
            ResolvedRepo | undefined
          >
        )
          .pipe(take(1))
          .subscribe((repository) => {
            if (!repository && deferred.length > 0) {
              relayCount += deferred.length;
              emit();
              wave(deferred, [identifierFilter], true, () =>
                startDeletionFollowUp([...primary, ...deferred]),
              );
            } else {
              startDeletionFollowUp(primary);
            }
          }),
      );
    });

    return () => subs.unsubscribe();
  });
}

function dedupeRelayUrls(relays: string[]): string[] {
  const unique = new Set<string>();
  for (const relay of relays) {
    if (!relay.startsWith("ws://") && !relay.startsWith("wss://")) continue;
    try {
      unique.add(normalizeUrl(relay));
    } catch {
      // Malformed relay hints cannot participate in a bounded snapshot.
    }
  }
  return [...unique];
}
