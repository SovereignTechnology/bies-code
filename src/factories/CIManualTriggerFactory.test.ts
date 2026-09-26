import type { NostrEvent } from "nostr-tools";
import { describe, expect, it } from "vitest";

import { CIManualTriggerFactory } from "@/factories/CIManualTriggerFactory";

const coordinator = "9".repeat(64);
const repository = `30617:${"a".repeat(64)}:ngit`;
const commit = "b".repeat(40);
const workflowRunId = "c".repeat(64);
const branchRef = "refs/heads/main";
const pullRequest = "1".repeat(64);
const pullRequestAuthor = "2".repeat(64);
const pullRequestUpdate = "3".repeat(64);

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

/**
 * A pull-request Workflow Result carries NIP-22 thread tags in place of a
 * Git-ref `r`, so its only `r` value is the completed run ID.
 */
function pullRequestWorkflowResult(): NostrEvent {
  return {
    ...workflowResult(),
    tags: [
      ["a", repository],
      ["c", commit],
      ["w", ".ngit/act/workflows/ci.yaml", "e".repeat(64)],
      ["o", "pull_request"],
      ["r", workflowRunId],
      ["conclusion", "failure"],
      ["E", pullRequest],
      ["K", "1618"],
      ["P", pullRequestAuthor],
      ["e", pullRequestUpdate],
      ["k", "1619"],
      ["p", pullRequestAuthor],
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

  it("addresses only the coordinator on a push retry", async () => {
    const trigger = await CIManualTriggerFactory.create(
      workflowResult(),
      coordinator,
    );

    expect(trigger.tags.filter(([name]) => name === "p")).toEqual([
      ["p", coordinator],
    ]);
    expect(trigger.tags).not.toContainEqual(["o", "push"]);
  });

  it("retains pull-request context without a Git ref or participant p tags", async () => {
    const trigger = await CIManualTriggerFactory.create(
      pullRequestWorkflowResult(),
      coordinator,
    );

    // A coordinator rejects a manual trigger that names any pubkey other than
    // itself, and rejects an `r` tag alongside the `E` pull-request root.
    expect(trigger.tags.filter(([name]) => name === "p")).toEqual([
      ["p", coordinator],
    ]);
    expect(trigger.tags.filter(([name]) => name === "r")).toEqual([]);
    expect(trigger.tags).toContainEqual(["E", pullRequest]);
    expect(trigger.tags).toContainEqual(["P", pullRequestAuthor]);
    expect(trigger.tags).toContainEqual(["c", commit]);
  });
});
