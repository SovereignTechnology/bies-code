/**
 * Custom Applesauce actions for the NIP-51 Git repositories follow list (kind:10018).
 *
 * These mirror the Git-author list actions (kind:10017) but
 * operate on kind:10018 and use `a` tags (address pointers to kind:30617
 * repository announcements) instead of `p` tags.
 *
 * When following a repository we tag ALL announcement coordinates from the
 * recursive maintainer set so that any client can discover the follow
 * regardless of which maintainer's announcement they encounter first.
 *
 * The actions consume the exact warm snapshot resolved by personal-singleton
 * preflight and never reopen the EventStore or its fallback loader.
 */

import type { Action } from "applesauce-actions";
import type { NostrEvent } from "nostr-tools";
import {
  GitRepoListFactory,
  GIT_REPOS_KIND,
} from "@/factories/GitRepoListFactory";

export { GIT_REPOS_KIND };

/**
 * Add one or more repository announcement coordinates to the user's NIP-51
 * Git repositories follow list (kind:10018).
 *
 * Pass all coordinates from the recursive maintainer set so the follow is
 * discoverable via any maintainer's announcement.
 *
 * @param coords - One or more "30617:<pubkey>:<dtag>" coordinate strings
 */
export function AddGitRepoFromPreflight(
  event: NostrEvent | undefined,
  outboxes: string[],
  ...coords: string[]
): Action {
  return async ({ publish, signer }) => {
    let factory = event
      ? GitRepoListFactory.modify(event)
      : GitRepoListFactory.create();
    for (const coord of coords) factory = factory.addAddressItem(coord);

    const signed = await factory.sign(signer);
    await publish(signed, outboxes);
  };
}

/**
 * Remove one or more repository announcement coordinates from the user's
 * NIP-51 Git repositories follow list (kind:10018).
 *
 * @param coords - One or more "30617:<pubkey>:<dtag>" coordinate strings
 */
export function RemoveGitRepoFromPreflight(
  event: NostrEvent | undefined,
  outboxes: string[],
  ...coords: string[]
): Action {
  return async ({ publish, signer }) => {
    let factory = event
      ? GitRepoListFactory.modify(event)
      : GitRepoListFactory.create();
    for (const coord of coords) factory = factory.removeAddressItem(coord);

    const signed = await factory.sign(signer);
    await publish(signed, outboxes);
  };
}
