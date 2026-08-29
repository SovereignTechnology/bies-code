import { afterEach, describe, expect, it, vi } from "vitest";
import type { NostrEvent } from "nostr-tools";
import {
  clearMaintainerAcceptanceJob,
  deliverMaintainerAcceptance,
  getMaintainerAcceptanceJob,
  isMaintainerAcceptanceJobExpired,
  maintainerAcceptanceKey,
  recordMaintainerAcceptanceBroadcast,
  recordMaintainerAcceptanceCloneSync,
  saveMaintainerAcceptanceJob,
  settleMaintainerAcceptanceJob,
  type MaintainerAcceptanceDeliveryDependencies,
  type MaintainerAcceptanceJob,
} from "@/services/maintainerAcceptance";

const accountPubkey = "a".repeat(64);
const invitationAnchor = "e".repeat(64);
const key = maintainerAcceptanceKey(
  accountPubkey,
  invitationAnchor,
  "invited-repo",
);
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
    invitationAnchor,
    dTag: "invited-repo",
    announcement,
    cloneUrls: [
      "https://one.example/owner/invited-repo.git",
      "https://two.example/owner/invited-repo.git",
    ],
    relayUrls: ["wss://one.example", "wss://two.example"],
    confirmationRelayUrls: ["wss://one.example", "wss://two.example"],
    deliveredRelayUrls: [],
    syncedCloneUrls: [],
    relayErrors: {},
    deliveryAttempt: 0,
    broadcastReceived: false,
    initialVerificationAt: Date.now(),
    initialVerificationRelayUrl: "wss://one.example",
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
    createdAt: Date.now(),
    updatedAt: Date.now(),
  };
}

afterEach(() => {
  clearMaintainerAcceptanceJob(key);
  vi.restoreAllMocks();
});

describe("maintainer acceptance delivery", () => {
  it("starts Git syncing after the first selected GRASP relay accepts", async () => {
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

    expect(partial?.phase).toBe("syncing");
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

  it("keeps failed destinations on a durable job while another relay syncs", async () => {
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

    expect(result?.phase).toBe("syncing");
    expect(result?.deliveredRelayUrls).toEqual(["wss://one.example"]);
    expect(result?.relayErrors).toEqual({
      "wss://two.example": "relay unavailable",
    });
    expect(getMaintainerAcceptanceJob(key)).toEqual(result);
  });

  it("marks first-server success without discarding pending delivery work", async () => {
    saveMaintainerAcceptanceJob(makeJob());
    const dependencies: MaintainerAcceptanceDeliveryDependencies = {
      publishRelay: vi.fn(async (_event: NostrEvent, relayUrl: string) => ({
        relayUrl,
        ok: relayUrl === "wss://one.example",
        message:
          relayUrl === "wss://one.example" ? "accepted" : "relay unavailable",
      })),
    };
    await deliverMaintainerAcceptance(key, dependencies);

    const synced = recordMaintainerAcceptanceCloneSync(
      key,
      "https://one.example/owner/invited-repo.git",
    );

    expect(synced?.phase).toBe("synced");
    expect(synced?.syncedCloneUrls).toEqual([
      "https://one.example/owner/invited-repo.git",
    ]);
    expect(synced?.relayErrors).toEqual({
      "wss://two.example": "relay unavailable",
    });
    expect(synced?.completedAt).toBeUndefined();
  });

  it("does not confirm a local job until its exact broadcast is received", () => {
    saveMaintainerAcceptanceJob(makeJob());

    expect(getMaintainerAcceptanceJob(key)?.broadcastReceived).toBe(false);
    recordMaintainerAcceptanceBroadcast(key, {
      ...announcement,
      id: "f".repeat(64),
    });
    expect(getMaintainerAcceptanceJob(key)?.broadcastReceived).toBe(false);

    recordMaintainerAcceptanceBroadcast(key, announcement);
    expect(getMaintainerAcceptanceJob(key)?.broadcastReceived).toBe(true);
  });

  it("becomes terminal only after delivery, broadcast, and every clone settle", () => {
    const job = makeJob();
    saveMaintainerAcceptanceJob({
      ...job,
      deliveredRelayUrls: job.relayUrls,
      syncedCloneUrls: [job.cloneUrls[0]],
      broadcastReceived: true,
      phase: "synced",
    });

    expect(settleMaintainerAcceptanceJob(key)?.completedAt).toBeUndefined();
    recordMaintainerAcceptanceCloneSync(key, job.cloneUrls[1]);

    expect(settleMaintainerAcceptanceJob(key)?.completedAt).toEqual(
      expect.any(Number),
    );
  });

  it("scopes jobs to the invitation anchor as well as invitee and identifier", () => {
    expect(key).not.toBe(
      maintainerAcceptanceKey(accountPubkey, "f".repeat(64), "invited-repo"),
    );
  });

  it("expires unfinished background work after the bounded retry window", () => {
    const job = makeJob();
    expect(
      isMaintainerAcceptanceJobExpired({
        ...job,
        createdAt: Date.now() - 8 * 24 * 60 * 60 * 1000,
      }),
    ).toBe(true);
    expect(isMaintainerAcceptanceJobExpired(job)).toBe(false);
  });
});
