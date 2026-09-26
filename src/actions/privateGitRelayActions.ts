/** Actions for the encrypted kind:10318 private Git relay singleton. */

import type { Action } from "applesauce-actions";
import type { NostrEvent } from "nostr-tools";

import {
  createPrivateGitRelayListEvent,
  PRIVATE_GIT_RELAY_LIST_KIND,
  privateGitRelayListTimestampFloor,
} from "@/lib/private-git-relays";

/** Replace the exact kind:10318 snapshot approved by common preflight. */
export function ReplacePrivateGitRelayListFromPreflight(
  pubkey: string,
  event: NostrEvent | undefined,
  outboxes: string[],
  relayUrls: readonly string[],
): Action {
  return async ({ publish, signer }) => {
    const signed = await createPrivateGitRelayListEvent(
      pubkey,
      signer,
      relayUrls,
      privateGitRelayListTimestampFloor(event, pubkey),
    );
    if (signed.kind !== PRIVATE_GIT_RELAY_LIST_KIND) {
      throw new Error("Unexpected private Git relay list kind");
    }
    await publish(signed, outboxes);
  };
}
