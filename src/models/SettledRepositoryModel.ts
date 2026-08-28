import type { Model } from "applesauce-core/event-store";
import type { Filter } from "applesauce-core/helpers";
import type { NostrEvent } from "nostr-tools";
import { combineLatest, forkJoin, of, Observable, Subscription } from "rxjs";
import {
  catchError,
  endWith,
  ignoreElements,
  switchMap,
  tap,
} from "rxjs/operators";

import { REPO_KIND, type ResolvedRepo } from "@/lib/nip34";
import { normalizeUrl } from "@/lib/url";
import { resilientRequest } from "@/lib/resilientSubscription";
import { RepositoryModel } from "@/models/RepositoryModel";
import { pool } from "@/services/nostr";
import {
  fallbackRelays,
  gitIndexRelays,
  lookupRelays,
} from "@/services/settings";

const MAILBOX_KIND = 10002;

export interface SettledRepositorySnapshot {
  repository?: ResolvedRepo;
  settled: boolean;
}

function addRelay(relays: Set<string>, value: string | undefined): void {
  if (!value || (!value.startsWith("ws://") && !value.startsWith("wss://"))) {
    return;
  }
  try {
    relays.add(normalizeUrl(value));
  } catch {
    // Malformed hints cannot participate in a settled relay request.
  }
}

/**
 * Resolve one coordinate only after its current recursive announcement graph
 * has completed an exact refresh. A changed announcement, discovered author,
 * or configured relay invalidates the previous settled snapshot.
 */
export function SettledRepositoryModel(
  selectedMaintainer: string,
  dTag: string,
): Model<SettledRepositorySnapshot> {
  return (store) =>
    new Observable<SettledRepositorySnapshot>((observer) => {
      const subscriptions = new Subscription();
      let refreshSubscription: Subscription | undefined;
      let repository: ResolvedRepo | undefined;
      let settings: [string[], string[], string[]] = [[], [], []];
      let graphKey = "";
      let generation = 0;

      const refresh = () => {
        const authors = [
          ...new Set([
            selectedMaintainer,
            ...(repository?.discoveryPubkeys ?? []),
            ...(repository?.historyPubkeys ?? []),
          ]),
        ].sort();
        const [indexRelays, configuredFallbacks, configuredLookups] = settings;
        const nextKey = JSON.stringify([
          selectedMaintainer,
          dTag,
          authors,
          repository?.discoveredAnnouncements
            .map((event) => `${event.pubkey}:${event.id}`)
            .sort() ?? [],
          repository?.historicalAnnouncements
            .map((event) => `${event.pubkey}:${event.id}`)
            .sort() ?? [],
          [...indexRelays].sort(),
          [...configuredFallbacks].sort(),
          [...configuredLookups].sort(),
          [...(repository?.relays ?? [])].sort(),
        ]);
        if (nextKey === graphKey) return;
        graphKey = nextKey;
        generation += 1;
        const activeGeneration = generation;
        observer.next({ repository, settled: false });
        refreshSubscription?.unsubscribe();

        const mailboxEvents = new Map<string, NostrEvent>();
        const mailboxRelays = new Set<string>();
        for (const relay of [...configuredLookups, ...configuredFallbacks]) {
          addRelay(mailboxRelays, relay);
        }
        const mailboxRefresh =
          mailboxRelays.size === 0
            ? of(null)
            : resilientRequest(
                pool,
                [...mailboxRelays],
                [
                  {
                    kinds: [MAILBOX_KIND],
                    authors,
                  } as Filter,
                ],
              ).pipe(
                tap((response: NostrEvent | "EOSE") => {
                  if (response !== "EOSE") {
                    mailboxEvents.set(response.pubkey, response);
                    store.add(response);
                  }
                }),
                ignoreElements(),
                endWith(null),
                catchError(() => of(null)),
              );

        refreshSubscription = forkJoin([mailboxRefresh])
          .pipe(
            switchMap(() => {
              const announcementRelays = new Set<string>();
              for (const relay of [
                ...indexRelays,
                ...configuredFallbacks,
                ...(repository?.relays ?? []),
              ]) {
                addRelay(announcementRelays, relay);
              }
              for (const author of authors) {
                const mailbox = mailboxEvents.get(author);
                for (const [name, relay] of mailbox?.tags ?? []) {
                  if (name === "r") addRelay(announcementRelays, relay);
                }
              }

              if (announcementRelays.size === 0) return of(null);
              return resilientRequest(
                pool,
                [...announcementRelays],
                [
                  {
                    kinds: [REPO_KIND],
                    authors,
                    "#d": [dTag],
                  } as Filter,
                ],
              ).pipe(
                tap((response: NostrEvent | "EOSE") => {
                  if (response !== "EOSE") store.add(response);
                }),
                ignoreElements(),
                endWith(null),
                catchError(() => of(null)),
              );
            }),
          )
          .subscribe(() => {
            if (activeGeneration === generation) {
              observer.next({ repository, settled: true });
            }
          });
      };

      subscriptions.add(
        combineLatest([gitIndexRelays, fallbackRelays, lookupRelays]).subscribe(
          (nextSettings) => {
            settings = nextSettings;
            graphKey = "";
            refresh();
          },
        ),
      );
      subscriptions.add(
        (
          store.model(
            RepositoryModel,
            selectedMaintainer,
            dTag,
          ) as unknown as Observable<ResolvedRepo | undefined>
        ).subscribe((nextRepository) => {
          repository = nextRepository;
          refresh();
        }),
      );

      return () => {
        refreshSubscription?.unsubscribe();
        subscriptions.unsubscribe();
      };
    });
}
