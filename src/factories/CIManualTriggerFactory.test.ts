import type { NostrEvent } from "nostr-tools";
import { describe, expect, it } from "vitest";

import { CIManualTriggerFactory } from "@/factories/CIManualTriggerFactory";

const coordinator = "9".repeat(64);
const repository = `30617:${"a".repeat(64)}:ngit`;
const commit = "b".repeat(40);
const workflowRunId = "c".repeat(64);
const branchRef = "refs/heads/main";

function workflowResult(): NostrEvent {
  return {
    id: "d".repeat(64),
    pubkey: coordinator,
    created_at: 1,
    kind: 9842,
    content: "",
    tags: [
      ["a", repository],
      ["c", commit],
      ["w", ".ngit/act/workflows/ci.yaml", "e".repeat(64)],
      ["o", "push"],
      ["r", workflowRunId],
      ["conclusion", "failure"],
      ["r", branchRef],
    ],
    sig: "f".repeat(128),
  };
}

describe("CIManualTriggerFactory", () => {
  it("copies the Git ref without reusing the completed workflow run ID", async () => {
    const trigger = await CIManualTriggerFactory.create(
      workflowResult(),
      coordinator,
    );

    expect(trigger.tags.filter(([name]) => name === "r")).toEqual([
      ["r", branchRef],
    ]);
    expect(trigger.tags).toContainEqual(["c", commit]);
    expect(trigger.tags).not.toContainEqual(["r", workflowRunId]);
  });
});
