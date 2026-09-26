import type { RelayPool } from "applesauce-relay";
import type { NostrEvent } from "nostr-tools";
import { afterEach, describe, expect, it, vi } from "vitest";

import { OutboxStore } from "@/services/outbox";
import {
  clearPrivateRepositoryScope,
  installPrivateRepositoryRelays,
  installPrivateServiceRelays,
} from "@/services/privateRepositoryScope";

const pubkey = "a".repeat(64);
const coordinate = `30617:${pubkey}:private-outbox-test`;
const privateRelay = "wss://private.example";

function event(kind: number): NostrEvent {
  return {
    id: `${kind}`.padStart(64, "0"),
    pubkey,
    created_at: 1_700_000_000,
    kind,
    tags: [["A", coordinate]],
    content: "",
    sig: "b".repeat(128),
  };
}

describe("private repository outbox guard", () => {
  afterEach(() => clearPrivateRepositoryScope());

  it("publishes only to admitted repository relays", async () => {
    installPrivateServiceRelays("account", pubkey, 1, [privateRelay]);
    installPrivateRepositoryRelays([coordinate], [privateRelay]);
    const publish = vi.fn(async (relays: string[]) =>
      relays.map((relay) => ({ ok: true, from: relay, message: "saved" })),
    );
    const store = new OutboxStore();
    store.pool = { publish } as unknown as RelayPool;
    store.relayGroupResolver = vi.fn(async () => ["wss://public.example"]);

    await store.publish(event(1111), [
      coordinate,
      `outbox:${pubkey}`,
      "fallback-relays",
    ]);

    expect(publish).toHaveBeenCalledOnce();
    expect(publish).toHaveBeenCalledWith([privateRelay], event(1111));
    expect(store.relayGroupResolver).not.toHaveBeenCalled();
  });

  it("rejects unsupported interactions before publishing", async () => {
    installPrivateServiceRelays("account", pubkey, 1, [privateRelay]);
    installPrivateRepositoryRelays([coordinate], [privateRelay]);
    const publish = vi.fn();
    const store = new OutboxStore();
    store.pool = { publish } as unknown as RelayPool;

    await expect(store.publish(event(7), [coordinate])).rejects.toThrow(
      "Event kind 7 is not enabled for private repositories",
    );
    expect(publish).not.toHaveBeenCalled();
  });
});
