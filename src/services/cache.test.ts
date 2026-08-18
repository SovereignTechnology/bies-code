import type { NostrEvent } from "nostr-tools";
import { afterEach, describe, expect, it, vi } from "vitest";
import { saveDeletionEvent } from "./cache";

function deletionEvent(): NostrEvent {
  return {
    id: "d".repeat(64),
    pubkey: "a".repeat(64),
    created_at: 1,
    kind: 5,
    tags: [
      ["k", "1111"],
      ["e", "b".repeat(64)],
    ],
    content: "withdrawn",
    sig: "c".repeat(128),
  };
}

describe("saveDeletionEvent", () => {
  afterEach(() => {
    vi.useRealTimers();
    vi.restoreAllMocks();
  });

  it("waits for a detached tombstone to become durably readable", async () => {
    const source = deletionEvent();
    let queued: NostrEvent | undefined;
    vi.spyOn(window.nostrdb, "add").mockImplementation(async (event) => {
      queued = event;
      return true;
    });
    const read = vi
      .spyOn(window.nostrdb, "event")
      .mockResolvedValueOnce(undefined)
      .mockImplementation(async () => queued);

    const saved = saveDeletionEvent(source);
    await saved;

    expect(window.nostrdb.add).toHaveBeenCalledOnce();
    expect(queued).not.toBe(source);
    expect(queued?.tags).not.toBe(source.tags);
    expect(queued?.tags[1]).not.toBe(source.tags[1]);
    expect(read).toHaveBeenCalledTimes(2);
  });

  it("rejects when the queued tombstone never reaches durable storage", async () => {
    vi.useFakeTimers();

    vi.spyOn(window.nostrdb, "add").mockResolvedValue(true);
    vi.spyOn(window.nostrdb, "event").mockResolvedValue(undefined);

    const saved = saveDeletionEvent(deletionEvent());
    const rejection = expect(saved).rejects.toThrow(
      /was not durably stored within 5000ms/,
    );
    await vi.runAllTimersAsync();
    await rejection;
  });
});
