/** Actions for the active user's kind:10317 GRASP server singleton. */

import type { Action } from "applesauce-actions";
import type { NostrEvent } from "nostr-tools";

export const GRASP_LIST_KIND = 10317;

/**
 * Replace only the public GRASP-server tags on the snapshot approved by
 * personal-singleton preflight. Unknown tags and content remain intact.
 */
export function ReplaceGraspListFromPreflight(
  event: NostrEvent | undefined,
  outboxes: string[],
  relayUrls: string[],
): Action {
  return async ({ publish, signer }) => {
    const retainedTags = event?.tags.filter(([name]) => name !== "g") ?? [];
    const graspTags = [...new Set(relayUrls)].map((url) => ["g", url]);
    const signed = await signer.signEvent({
      kind: GRASP_LIST_KIND,
      content: event?.content ?? "",
      tags: [...retainedTags, ...graspTags],
      created_at: Math.floor(Date.now() / 1000),
    });
    await publish(signed, outboxes);
  };
}
