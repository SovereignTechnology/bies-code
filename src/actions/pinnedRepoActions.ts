/**
 * Custom Applesauce actions for the NIP-51 pinned git repositories list
 * (kind:10617).
 *
 * Pinned repos are a curated, ordered list of the user's own repositories
 * that they want to highlight on their profile. The order of `a` tags in the
 * event is preserved and used for display ordering.
 *
 * The actions consume the exact warm snapshot resolved by personal-singleton
 * preflight and never reopen the EventStore or its fallback loader.
 */

import type { Action } from "applesauce-actions";
import type { NostrEvent } from "nostr-tools";
import {
  PinnedReposFactory,
  PINNED_REPOS_KIND,
} from "@/factories/PinnedReposFactory";

export { PINNED_REPOS_KIND };

/**
 * Add a repository announcement coordinate to the user's pinned repos list
 * (kind:10617). Appended to the end of the list (lowest priority / newest pin).
 *
 * @param coord - "30617:<pubkey>:<dtag>" coordinate string
 */
export function PinGitRepoFromPreflight(
  event: NostrEvent | undefined,
  outboxes: string[],
  coord: string,
): Action {
  return async ({ publish, signer }) => {
    const factory = event
      ? PinnedReposFactory.modify(event)
      : PinnedReposFactory.create();

    const signed = await factory.addAddressItem(coord).sign(signer);
    await publish(signed, outboxes);
  };
}

/**
 * Remove a repository announcement coordinate from the user's pinned repos
 * list (kind:10617).
 *
 * @param coord - "30617:<pubkey>:<dtag>" coordinate string
 */
export function UnpinGitRepoFromPreflight(
  event: NostrEvent | undefined,
  outboxes: string[],
  coord: string,
): Action {
  return async ({ publish, signer }) => {
    const factory = event
      ? PinnedReposFactory.modify(event)
      : PinnedReposFactory.create();

    const signed = await factory.removeAddressItem(coord).sign(signer);
    await publish(signed, outboxes);
  };
}

/**
 * Replace the entire ordered list of pinned repo coordinates.
 * Used when the user drags to reorder pinned repos.
 *
 * @param coords - ordered array of "30617:<pubkey>:<dtag>" coordinate strings
 */
export function ReorderPinnedReposFromPreflight(
  event: NostrEvent | undefined,
  outboxes: string[],
  coords: string[],
): Action {
  return async ({ publish, signer }) => {
    const factory = event
      ? PinnedReposFactory.modify(event)
      : PinnedReposFactory.create();

    const signed = await factory.reorder(coords).sign(signer);
    await publish(signed, outboxes);
  };
}
