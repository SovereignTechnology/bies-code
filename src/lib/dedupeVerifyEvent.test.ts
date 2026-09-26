import { readFileSync } from "node:fs";
import { resolve } from "node:path";
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
    { kind: 1, created_at: 1700000000, tags: [["t", "a"]], content: "hello" },
    sk,
  );

  it("verifies identical copies of one event exactly once", () => {
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

  it("rejects a tampered copy with a mismatched id", () => {
    const verify = vi.fn(verifyEvent);
    const store = makeStore(verify);

    store.add(relayCopy(signed));

    const tampered = relayCopy(signed);
    tampered.content = "evil";
    tampered.id = "f".repeat(64);
    expect(store.add(tampered)).toBeNull();
    expect(verify).toHaveBeenCalledTimes(2);
    expect(store.hasEvent(tampered.id)).toBe(false);
  });

  it("fully verifies and rejects an impostor claiming a stored id", () => {
    const verify = vi.fn(verifyEvent);
    const store = makeStore(verify);

    store.add(relayCopy(signed));

    for (const mutate of [
      (e: NostrEvent) => (e.content = "evil"),
      (e: NostrEvent) => (e.tags = [["t", "b"]]),
      (e: NostrEvent) => (e.created_at += 1),
      (e: NostrEvent) => (e.sig = "0".repeat(128)),
    ]) {
      const impostor = relayCopy(signed);
      mutate(impostor);
      expect(store.add(impostor)).toBeNull();
    }
    expect(verify).toHaveBeenCalledTimes(5);
    expect(store.getEvent(signed.id)?.content).toBe("hello");
  });

  it("rejects a forged event whose id matches its hash but whose signature is invalid", () => {
    const store = makeStore(verifyEvent);
    const otherKey = generateSecretKey();
    const forged = relayCopy(
      finalizeEvent(
        { kind: 1, created_at: 1700000001, tags: [], content: "forged" },
        otherKey,
      ),
    );
    forged.pubkey = signed.pubkey; // claim another author; id and sig no longer match
    expect(store.add(forged)).toBeNull();
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

// BIES Code keeps signature verification on. Upstream disabled it in 26e7ed57
// (fakeVerifyEvent); this guards against a future sync silently re-disabling it.
describe("global EventStore wiring", () => {
  const source = readFileSync(
    resolve(process.cwd(), "src/services/nostr.ts"),
    "utf8",
  );

  it("verifies events through the deduped real verifier", () => {
    expect(source).toMatch(
      /eventStore\.verifyEvent = createDedupedVerifyEvent\(\s*eventStore,\s*verifyEvent,?\s*\);/,
    );
  });

  it("never imports or installs fakeVerifyEvent", () => {
    expect(source).not.toMatch(/import[^;]*\bfakeVerifyEvent\b/);
    expect(source).not.toMatch(/verifyEvent\s*=\s*fakeVerifyEvent/);
  });
});
