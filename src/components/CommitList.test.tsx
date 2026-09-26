import { render, screen } from "@testing-library/react";
import { describe, expect, it } from "vitest";
import { CommitList } from "./CommitList";
import { selectCommitRange, type Commit } from "@/lib/git-grasp-pool";
import { TestApp } from "@/test/TestApp";

const hashes = {
  root: "0".repeat(40),
  mainBeforeMerge: "1".repeat(40),
  mergedFeature: "2".repeat(40),
  noFFMerge: "3".repeat(40),
  oldPRTip: "4".repeat(40),
  currentPRTip: "5".repeat(40),
};

function commit(
  hash: string,
  message: string,
  parents: string[],
  timestamp: number,
): Commit {
  const person = {
    name: "Contributor",
    email: "contributor@example.com",
    timestamp,
    timezone: "+0000",
  };
  return {
    hash,
    tree: "f".repeat(40),
    parents,
    author: person,
    committer: person,
    message,
  };
}

function noFFMergeFixture(tip: "old" | "current"): {
  history: Commit[];
  tipCommit: Commit;
  mergedFeature: Commit;
} {
  const root = commit(hashes.root, "initial commit", [], 100);
  const mainBeforeMerge = commit(
    hashes.mainBeforeMerge,
    "main before merge",
    [root.hash],
    200,
  );
  const mergedFeature = commit(
    hashes.mergedFeature,
    "feature already merged into main",
    [mainBeforeMerge.hash],
    400,
  );
  const noFFMerge = commit(
    hashes.noFFMerge,
    "Merge feature with --no-ff",
    [mainBeforeMerge.hash, mergedFeature.hash],
    300,
  );
  const tipCommit = commit(
    tip === "current" ? hashes.currentPRTip : hashes.oldPRTip,
    tip === "current" ? "new PR commit" : "old PR revision",
    [noFFMerge.hash],
    500,
  );

  // GitGraspPool returns graph history sorted by commit timestamp. The
  // second parent deliberately sorts before its no-ff merge commit, matching
  // the ordering that exposed the production bug.
  return {
    history: [tipCommit, mergedFeature, noFFMerge, mainBeforeMerge, root],
    tipCommit,
    mergedFeature,
  };
}

describe("PR commit list range", () => {
  it("counts and displays only commits not reachable from a no-ff merge base", () => {
    const fixture = noFFMergeFixture("current");
    const range = selectCommitRange(fixture.history, hashes.noFFMerge);

    expect(range.map((entry) => entry.hash)).toEqual([fixture.tipCommit.hash]);
    expect(range).toHaveLength(1);

    render(
      <TestApp>
        <CommitList commits={range} basePath="/repo/pr" />
      </TestApp>,
    );

    expect(screen.getByText("new PR commit")).toBeInTheDocument();
    expect(
      screen.queryByText(fixture.mergedFeature.message),
    ).not.toBeInTheDocument();
  });

  it("applies the same one-commit range to an outdated revision", () => {
    const fixture = noFFMergeFixture("old");
    const range = selectCommitRange(fixture.history, hashes.noFFMerge);

    expect(range.map((entry) => entry.message)).toEqual(["old PR revision"]);
    expect(range).toHaveLength(1);
  });
});
