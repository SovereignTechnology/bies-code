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
    syncedCloneUrls: [],
    relayErrors: {},
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
    const firstPublish = vi.fn(
      async (_event: NostrEvent, relayUrl: string) => ({
        relayUrl,
        ok: relayUrl === "wss://one.example",
        message:
          relayUrl === "wss://one.example" ? "accepted" : "connection failed",
      }),
    );
    const firstDependencies: MaintainerAcceptanceDeliveryDependencies = {
      publishRelay: firstPublish,
    };

    const partial = await deliverMaintainerAcceptance(key, firstDependencies);

    expect(partial?.phase).toBe("delivery-error");
    expect(partial?.deliveredRelayUrls).toEqual(["wss://one.example"]);
    expect(partial?.relayErrors).toEqual({
      "wss://two.example": "connection failed",
    });
    const retryPublish = vi.fn(
      async (_event: NostrEvent, relayUrl: string) => ({
        relayUrl,
        ok: true,
        message: "accepted",
      }),
    );
    const retryDependencies: MaintainerAcceptanceDeliveryDependencies = {
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
  });

  it("keeps the durable job in an error state when a GRASP relay rejects it", async () => {
    saveMaintainerAcceptanceJob(makeJob());
    const dependencies: MaintainerAcceptanceDeliveryDependencies = {
      publishRelay: vi.fn(async (_event: NostrEvent, relayUrl: string) => ({
        relayUrl,
        ok: relayUrl === "wss://one.example",
        message:
          relayUrl === "wss://one.example" ? "accepted" : "relay unavailable",
      })),
    };

    const result = await deliverMaintainerAcceptance(key, dependencies);

    expect(result?.phase).toBe("delivery-error");
    expect(result?.deliveredRelayUrls).toEqual(["wss://one.example"]);
    expect(result?.relayErrors).toEqual({
      "wss://two.example": "relay unavailable",
    });
    expect(getMaintainerAcceptanceJob(key)).toEqual(result);
  });
});
