import { ActionRunner } from "applesauce-actions";
import { EventStore, type EventSigner } from "applesauce-core";
import type { NostrEvent } from "nostr-tools";
import { describe, expect, it, vi } from "vitest";

import { FollowUserFromPreflight } from "./preflightReplaceableActions";

const OUTBOX = "wss://outbox.example.test";
const SELF = "a".repeat(64);
const TARGET = "b".repeat(64);

const signer: EventSigner = {
  getPublicKey: () => SELF,
  signEvent: (draft): NostrEvent => ({
    ...draft,
    id: "c".repeat(64),
    pubkey: SELF,
    sig: "d".repeat(128),
  }),
};

describe("preflight replaceable actions", () => {
  it("creates from confirmed absence without subscribing to the store loader", async () => {
    const events = new EventStore();
    const loader = vi.fn(() => {
      throw new Error("unexpected fallback load");
    });
    events.eventLoader = loader;
    const publish = vi.fn();
    const runner = new ActionRunner(events, signer, publish);
    runner.saveToStore = false;

    await runner.run(FollowUserFromPreflight, undefined, [OUTBOX], TARGET);

    expect(loader).not.toHaveBeenCalled();
    expect(publish).toHaveBeenCalledWith(
      expect.objectContaining({
        kind: 3,
        tags: expect.arrayContaining([["p", TARGET]]),
      }),
      [OUTBOX],
    );
  });
});
