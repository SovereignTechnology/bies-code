import { describe, it, expect, vi } from "vitest";
import { EventStore } from "applesauce-core";
import { finalizeEvent, generateSecretKey, verifyEvent } from "nostr-tools";
import type { NostrEvent } from "nostr-tools";
import { createDedupedVerifyEvent } from "./dedupeVerifyEvent";

/** JSON round-trip: a fresh object per relay copy, no memoization symbols. */
function relayCopy(event: NostrEvent): NostrEvent {
  return JSON.parse(JSON.stringify(event));
}

function makeStore(verify: (event: NostrEvent) => boolean): EventStore {
  const store = new EventStore();
  store.verifyEvent = createDedupedVerifyEvent(store, verify);
  return store;
}

describe("createDedupedVerifyEvent", () => {
  const sk = generateSecretKey();
  const signed = finalizeEvent(
    { kind: 1, created_at: 1700000000, tags: [], content: "hello" },
    sk,
  );

  it("verifies duplicate copies of one event exactly once", () => {
    const verify = vi.fn(verifyEvent);
    const store = makeStore(verify);

    const first = store.add(relayCopy(signed));
    expect(first).not.toBeNull();
    expect(verify).toHaveBeenCalledTimes(1);

    const second = store.add(relayCopy(signed));
    const third = store.add(relayCopy(signed));
    expect(second).toBe(first);
    expect(third).toBe(first);
    expect(verify).toHaveBeenCalledTimes(1);
  });

  it("rejects a tampered second copy with a mismatched id", () => {
    const verify = vi.fn(verifyEvent);
    const store = makeStore(verify);

    store.add(relayCopy(signed));
    expect(verify).toHaveBeenCalledTimes(1);

    // Tampered content under an id not in the store: the id no longer
    // matches the event hash, so full verification runs and rejects it.
    const tampered = relayCopy(signed);
    tampered.content = "evil";
    tampered.id = "f".repeat(64);
    expect(store.add(tampered)).toBeNull();
    expect(verify).toHaveBeenCalledTimes(2);
    expect(store.hasEvent(tampered.id)).toBe(false);
  });

  it("discards a tampered copy claiming a stored id without replacing content", () => {
    const verify = vi.fn(verifyEvent);
    const store = makeStore(verify);

    const stored = store.add(relayCopy(signed));

    // Same id as the stored event but different content: verification is
    // skipped, and the store's id-based dedupe discards the copy.
    const impostor = relayCopy(signed);
    impostor.content = "evil";
    const result = store.add(impostor);
    expect(result).toBe(stored);
    expect(verify).toHaveBeenCalledTimes(1);
    expect(store.getEvent(signed.id)?.content).toBe("hello");
  });

  it("re-verifies an id after the event is removed from the store", () => {
    const verify = vi.fn(verifyEvent);
    const store = makeStore(verify);

    store.add(relayCopy(signed));
    store.remove(signed.id);

    const readded = store.add(relayCopy(signed));
    expect(readded).not.toBeNull();
    expect(verify).toHaveBeenCalledTimes(2);
  });
});
