import { mapEventsToStore } from "applesauce-core";
import type { Filter } from "applesauce-core/helpers";
import { onlyEvents } from "applesauce-relay";
import { EMPTY, of, type Observable } from "rxjs";
import { catchError, filter, map } from "rxjs/operators";

import { use$ } from "@/hooks/use$";
import { useEventStore } from "@/hooks/useEventStore";
import { resilientSubscription } from "@/lib/resilientSubscription";
import { REPO_KIND, type ResolvedRepo } from "@/lib/nip34";
import { RepositoryListModel } from "@/models/RepositoryListModel";
import { pool } from "@/services/nostr";
import {
  prepareDiscoveredRepositoryEvent,
  privateGitRelayList$,
} from "@/services/privateGitRelays";
import {
  isPrivateRepositoryCoordinate,
  privateRepositoryScopeRevision$,
} from "@/services/privateRepositoryScope";

/**
 * Fetch and resolve every private repository available through the active
 * account's encrypted service list, regardless of repository author.
 */
export function useAccessiblePrivateRepositories(pubkey: string) {
  const store = useEventStore();
  const privateRelayState = use$(privateGitRelayList$);
  const privateScopeRevision = use$(privateRepositoryScopeRevision$);
  const isCurrentAccount = privateRelayState.pubkey === pubkey;
  const privateRelays = isCurrentAccount ? privateRelayState.relayUrls : [];
  const privateRelayKey = privateRelays.join(",");

  // Layer 1: private services expose their authenticated announcement set.
  // Admission verifies and quarantines each private announcement before it is
  // inserted into the shared EventStore.
  use$(() => {
    if (privateRelays.length === 0) return undefined;
    return resilientSubscription(
      pool,
      privateRelays,
      [{ kinds: [REPO_KIND] } as Filter],
      { paginate: true },
    ).pipe(
      onlyEvents(),
      filter((event) => prepareDiscoveredRepositoryEvent(event, privateRelays)),
      mapEventsToStore(store),
      catchError(() => EMPTY),
    );
  }, [pubkey, privateRelayState.generation, privateRelayKey, store]);

  // Layer 2: reuse the resolved component list, then retain only components
  // with a coordinate admitted through the current private-service session.
  const repos = use$(() => {
    if (!isCurrentAccount) {
      return undefined;
    }
    if (privateRelays.length === 0 && privateRelayState.status !== "ready") {
      return undefined;
    }
    if (privateRelays.length === 0) return of([] as ResolvedRepo[]);

    return (
      store.model(
        RepositoryListModel,
        undefined,
        false,
      ) as unknown as Observable<ResolvedRepo[]>
    ).pipe(
      map((repositories) =>
        repositories.filter((repository) =>
          repository.confirmedMemberCoordinates.some(
            isPrivateRepositoryCoordinate,
          ),
        ),
      ),
    );
  }, [
    pubkey,
    privateRelayState.generation,
    privateRelayState.status,
    privateRelayKey,
    privateScopeRevision,
    store,
  ]);

  return { repos, state: privateRelayState };
}
