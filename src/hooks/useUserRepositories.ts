import { use$ } from "./use$";
import { useEventStore } from "./useEventStore";
import { mapEventsToStore } from "applesauce-core";
import { useActiveAccount } from "applesauce-react/hooks";
import { onlyEvents } from "applesauce-relay";
import { filter } from "rxjs/operators";
import { pool } from "@/services/nostr";
import { resilientSubscription } from "@/lib/resilientSubscription";
import { REPO_KIND, type ResolvedRepo } from "@/lib/nip34";
import { gitIndexRelays } from "@/services/settings";
import { RepositoryListModel } from "@/models/RepositoryListModel";
import type { Filter } from "applesauce-core/helpers";
import type { Observable } from "rxjs";
import {
  prepareDiscoveredRepositoryEvent,
  privateGitRelayList$,
} from "@/services/privateGitRelays";

/**
 * Fetch repository announcements authored by a specific user and return them
 * as resolved repositories with the user as the selected maintainer.
 *
 * We request kind 30617 filtered by `authors: [pubkey]` so we only receive
 * events the user themselves published. The user is therefore always the
 * selectedMaintainer anchor for BFS resolution.
 *
 * Layer 1: relay fetch — loads this user's 30617 events into the EventStore.
 * Layer 2: RepositoryListModel(pubkey) — hydrate each authored coordinate and
 *          return its one confirmed repository component.
 *
 * @param pubkey - The user's hex pubkey, or undefined to skip
 * @returns ResolvedRepo[] when loaded, undefined while loading
 */
export function useUserRepositories(
  pubkey: string | undefined,
): ResolvedRepo[] | undefined {
  const store = useEventStore();
  const account = useActiveAccount();
  const liveGitIndexRelays =
    use$(() => gitIndexRelays, []) ?? gitIndexRelays.getValue();
  const privateRelayState = use$(privateGitRelayList$);
  const privateRelays =
    account && privateRelayState.pubkey === account.pubkey
      ? privateRelayState.relayUrls
      : [];
  const repositoryRelays = [
    ...new Set([...liveGitIndexRelays, ...privateRelays]),
  ];
  const repositoryRelayKey = repositoryRelays.join(",");

  // Layer 1: fetch only this user's repo announcements from public indexes and
  // the active account's private services.
  // Filtering by authors ensures the user is the selected maintainer anchor
  // for every result, which is the correct behaviour for a user profile page.
  use$(() => {
    if (!pubkey) return undefined;
    return resilientSubscription(
      pool,
      repositoryRelays,
      [{ kinds: [REPO_KIND], authors: [pubkey] } as Filter],
      { paginate: true },
    ).pipe(
      onlyEvents(),
      filter((event) => prepareDiscoveredRepositoryEvent(event, privateRelays)),
      mapEventsToStore(store),
    );
  }, [pubkey, store, repositoryRelayKey]);

  // Layer 2: subscribe to the model scoped to this pubkey.
  return use$(() => {
    if (!pubkey) return undefined;
    return store.model(
      RepositoryListModel,
      pubkey,
      false,
    ) as unknown as Observable<ResolvedRepo[]>;
  }, [pubkey, store]);
}
