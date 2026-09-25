/**
 * useUserProfileSubscription — subscribe to a user's replaceable events while
 * viewing their profile page.
 *
 * When we are on another user's profile page we need their kind:0, kind:3,
 * kind:10002, kind:10017, and kind:10018 events so we can display:
 *   - their profile metadata (kind:0)
 *   - their git-author follow list (kind:10017) for the "Followed Authors" tab
 *   - their git-repo follow list (kind:10018) for the "Followed" tab
 *   - their relay list (kind:10002) so we know which relays to query
 *
 * Strategy:
 *   Single reactive subscription that starts immediately on the git index /
 *   lookup relays and additively expands to the user's personal outbox relays
 *   once their kind:10002 arrives — without ever tearing down the existing
 *   relay connections.
 *
 * This hook is a no-op when:
 *   - pubkey is undefined
 *   - the viewed pubkey matches the active account and CI advertisements are
 *     not requested (the account subscription already loads identity events)
 *
 * The subscription is torn down automatically when the component unmounts
 * (use$ handles the RxJS subscription lifecycle).
 */

import { use$ } from "./use$";
import { useEventStore } from "./useEventStore";
import { useActiveAccount } from "applesauce-react/hooks";
import { pool } from "@/services/nostr";
import { gitIndexRelays, lookupRelays } from "@/services/settings";
import { mapEventsToStore } from "applesauce-core";
import { onlyEvents } from "applesauce-relay";
import { resilientSubscription } from "@/lib/resilientSubscription";
import { combineLatest } from "rxjs";
import { map, distinctUntilChanged, startWith } from "rxjs/operators";
import type { Filter } from "applesauce-core/helpers";
import { normalizeUrl } from "@/lib/url";
import {
  CI_COORDINATOR_ADVERTISEMENT_KIND,
  CI_NIX_PROVIDER_ADVERTISEMENT_KIND,
} from "@/lib/ci";

/** Replaceable event kinds that define a user's identity and follow lists. */
const USER_REPLACEABLE_KINDS = [
  0, // profile metadata
  3, // contact / follow list
  10002, // NIP-65 relay list (mailboxes)
  10017, // NIP-51 Git authors follow list
  10018, // NIP-51 Git repositories follow list
] as const;

/**
 * Subscribe to a user's replaceable events for the duration of the profile
 * page visit. Starts immediately on index + lookup relays and additively
 * expands to the user's outbox relays once their kind:10002 is known.
 *
 * CI advertisements can join the same author-scoped filter for profile links.
 * On our own profile, only these advertisements need a page-owned fetch.
 *
 * @param pubkey - The profile page owner's hex pubkey, or undefined to skip
 */
export function useUserProfileSubscription(
  pubkey: string | undefined,
  {
    includeCIAdvertisements = false,
  }: { includeCIAdvertisements?: boolean } = {},
): void {
  const store = useEventStore();
  const account = useActiveAccount();
  const myPubkey = account?.pubkey;

  // The active account already owns the identity query. Only fetch the
  // optional advertisements when viewing our own profile.
  const isOwnProfile = !!pubkey && pubkey === myPubkey;

  use$(() => {
    if (!pubkey || (isOwnProfile && !includeCIAdvertisements)) return undefined;

    const filter: Filter = {
      kinds: [
        ...(isOwnProfile ? [] : USER_REPLACEABLE_KINDS),
        ...(includeCIAdvertisements
          ? [
              CI_COORDINATOR_ADVERTISEMENT_KIND,
              CI_NIX_PROVIDER_ADVERTISEMENT_KIND,
            ]
          : []),
      ],
      authors: [pubkey],
    };

    // Reactive relay list: starts with index + lookup relays immediately, then
    // additively expands to include the user's outbox relays once their
    // kind:10002 arrives. resilientSubscription diffs on each emission so
    // existing relay connections are never torn down.
    const relays$ = combineLatest([
      gitIndexRelays,
      lookupRelays,
      store.mailboxes(pubkey).pipe(startWith(undefined)),
    ]).pipe(
      map(([index, lookup, mailboxes]) => [
        ...new Set(
          [...index, ...lookup, ...(mailboxes?.outboxes ?? [])].map(
            normalizeUrl,
          ),
        ),
      ]),
      distinctUntilChanged(
        (a, b) => a.length === b.length && a.every((v, i) => v === b[i]),
      ),
    );

    return resilientSubscription(pool, relays$, [filter]).pipe(
      onlyEvents(),
      mapEventsToStore(store),
    );
  }, [pubkey, isOwnProfile, includeCIAdvertisements, store]);
}
