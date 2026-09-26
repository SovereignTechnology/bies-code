import { describe, expect, it } from "vitest";
import { EventStore } from "applesauce-core";
import type { NostrEvent } from "nostr-tools";
import { filter, firstValueFrom, map, timeout } from "rxjs";
import { InferredPRParentsModel } from "./InferredPRParentsModel";
import { getInferredPRStackItems } from "@/lib/inferredPRParents";

const repo = "30617:maintainer:repo";

function pr(id: string, commit: string, mergeBase?: string): NostrEvent {
  return {
    id,
    kind: 1618,
    pubkey: "author",
    created_at: 1,
    content: "",
    sig: "sig",
    tags: [
      ["a", repo],
      ["c", commit],
      ["subject", id],
      ...(mergeBase ? [["merge-base", mergeBase]] : []),
    ],
  };
}

describe("InferredPRParentsModel", () => {
  it("reactively expands an already-rendered stack when a new PR arrives", async () => {
    const store = new EventStore();
    store.verifyEvent = () => true;
    const foundation = pr("foundation", "foundation-tip");
    const followUp = pr("follow-up", "follow-up-tip", "foundation-tip");
    const third = pr("third", "third-tip", "follow-up-tip");
    store.add(foundation);
    store.add(followUp);

    const expanded = firstValueFrom(
      store.model(InferredPRParentsModel, repo).pipe(
        map((relations) => getInferredPRStackItems(relations, followUp.id)),
        filter((items) => items.length === 3),
        timeout(1_000),
      ),
    );

    store.add(third);

    await expect(expanded).resolves.toEqual([
      { rootId: foundation.id, subject: "foundation" },
      { rootId: followUp.id, subject: "follow-up" },
      { rootId: third.id, subject: "third" },
    ]);
  });
});
