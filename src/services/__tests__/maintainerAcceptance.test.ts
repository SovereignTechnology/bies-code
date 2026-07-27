import { afterEach, describe, expect, it, vi } from "vitest";
import type { NostrEvent } from "nostr-tools";
import {
  clearMaintainerAcceptanceJob,
  deliverMaintainerAcceptance,
  getMaintainerAcceptanceJob,
  saveMaintainerAcceptanceJob,
  type MaintainerAcceptanceDeliveryDependencies,
  type MaintainerAcceptanceJob,
} from "@/services/maintainerAcceptance";

const key = `${"a".repeat(64)}:invited-repo`;
const announcement: NostrEvent = {
  id: "b".repeat(64),
  pubkey: "a".repeat(64),
  kind: 30617,
  created_at: 1_700_000_000,
  content: "",
  tags: [["d", "invited-repo"]],
  sig: "c".repeat(128),
};

function makeJob(): MaintainerAcceptanceJob {
  return {
    key,
    accountPubkey: announcement.pubkey,
    dTag: "invited-repo",
    announcement,
    cloneUrls: [
      "https://one.example/owner/invited-repo.git",
      "https://two.example/owner/invited-repo.git",
    ],
    relayUrls: ["wss://one.example", "wss://two.example"],
    deliveredRelayUrls: [],
    relayErrors: {},
    outboxQueued: false,
    phase: "publishing",
    stateRefs: [
      {
        name: "refs/heads/main",
        commitId: "d".repeat(40),
        parentCommitIds: [],
      },
    ],
    knownHeadCommit: "d".repeat(40),
    stateCreatedAt: 1_700_000_000,
    updatedAt: Date.now(),
  };
}

afterEach(() => {
  clearMaintainerAcceptanceJob(key);
  vi.restoreAllMocks();
});

describe("maintainer acceptance delivery", () => {
  it("does not enter syncing until every selected GRASP relay accepts", async () => {
    saveMaintainerAcceptanceJob(makeJob());
    const addEvent = vi.fn();
    const queueOutbox = vi.fn().mockResolvedValue(undefined);
    const firstPublish = vi.fn(
      async (_event: NostrEvent, relayUrl: string) => ({
        relayUrl,
        ok: relayUrl === "wss://one.example",
        message:
          relayUrl === "wss://one.example" ? "accepted" : "connection failed",
      }),
    );
    const firstDependencies: MaintainerAcceptanceDeliveryDependencies = {
      addEvent,
      queueOutbox,
      publishRelay: firstPublish,
    };

    const partial = await deliverMaintainerAcceptance(key, firstDependencies);

    expect(partial?.phase).toBe("delivery-error");
    expect(partial?.outboxQueued).toBe(true);
    expect(partial?.deliveredRelayUrls).toEqual(["wss://one.example"]);
    expect(partial?.relayErrors).toEqual({
      "wss://two.example": "connection failed",
    });
    expect(addEvent).toHaveBeenCalledWith(announcement);
    expect(queueOutbox).toHaveBeenCalledWith(announcement, [
      `outbox:${announcement.pubkey}`,
      "fallback-relays",
      "git-index",
    ]);

    const retryPublish = vi.fn(
      async (_event: NostrEvent, relayUrl: string) => ({
        relayUrl,
        ok: true,
        message: "accepted",
      }),
    );
    const retryQueueOutbox = vi.fn().mockResolvedValue(undefined);
    const retryDependencies: MaintainerAcceptanceDeliveryDependencies = {
      addEvent: vi.fn(),
      queueOutbox: retryQueueOutbox,
      publishRelay: retryPublish,
    };

    const completed = await deliverMaintainerAcceptance(key, retryDependencies);

    expect(completed?.phase).toBe("syncing");
    expect(completed?.deliveredRelayUrls).toEqual([
      "wss://one.example",
      "wss://two.example",
    ]);
    expect(retryPublish).toHaveBeenCalledTimes(1);
    expect(retryPublish).toHaveBeenCalledWith(
      announcement,
      "wss://two.example",
    );
    expect(retryQueueOutbox).not.toHaveBeenCalled();
  });

  it("keeps the durable job in an error state when outbox persistence fails", async () => {
    saveMaintainerAcceptanceJob(makeJob());
    const dependencies: MaintainerAcceptanceDeliveryDependencies = {
      addEvent: vi.fn(),
      queueOutbox: vi
        .fn()
        .mockRejectedValue(new Error("IndexedDB unavailable")),
      publishRelay: vi.fn(async (_event: NostrEvent, relayUrl: string) => ({
        relayUrl,
        ok: true,
        message: "accepted",
      })),
    };

    const result = await deliverMaintainerAcceptance(key, dependencies);

    expect(result?.phase).toBe("delivery-error");
    expect(result?.deliveredRelayUrls).toEqual([
      "wss://one.example",
      "wss://two.example",
    ]);
    expect(result?.relayErrors.outbox).toBe("IndexedDB unavailable");
    expect(getMaintainerAcceptanceJob(key)).toEqual(result);
  });
});
