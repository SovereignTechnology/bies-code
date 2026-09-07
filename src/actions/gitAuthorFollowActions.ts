/**
 * Custom Applesauce actions for the NIP-51 Git authors follow list (kind:10017).
 *
 * These consume the exact warm snapshot resolved by personal-singleton
 * preflight, modify its public `p` tags, sign, and publish. They never reopen
 * the EventStore or its fallback loader after preflight has established
 * presence or absence.
 *
 * Because kind:10017 is a brand-new list for most users, we do NOT throw when
 * no existing event is found — we simply build a fresh one.
 */

import type { Action } from "applesauce-actions";
import type { ProfilePointer } from "applesauce-core/helpers";
import type { NostrEvent } from "nostr-tools";
import {
  GitAuthorListFactory,
  GIT_AUTHORS_KIND,
} from "@/factories/GitAuthorListFactory";

export { GIT_AUTHORS_KIND };

/** Add a pubkey to the user's NIP-51 Git authors follow list (kind:10017). */
export function AddGitAuthorFromPreflight(
  event: NostrEvent | undefined,
  outboxes: string[],
  user: string | ProfilePointer,
): Action {
  return async ({ publish, signer }) => {
    const factory = event
      ? GitAuthorListFactory.modify(event)
      : GitAuthorListFactory.create();

    const signed = await factory.addUser(user).sign(signer);
    await publish(signed, outboxes);
  };
}

/** Remove a pubkey from the user's NIP-51 Git authors follow list (kind:10017). */
export function RemoveGitAuthorFromPreflight(
  event: NostrEvent | undefined,
  outboxes: string[],
  user: string | ProfilePointer,
): Action {
  return async ({ publish, signer }) => {
    const factory = event
      ? GitAuthorListFactory.modify(event)
      : GitAuthorListFactory.create();

    const signed = await factory.removeUser(user).sign(signer);
    await publish(signed, outboxes);
  };
}
