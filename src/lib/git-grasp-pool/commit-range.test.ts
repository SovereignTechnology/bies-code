import { describe, expect, it } from "vitest";
import { selectCommitRange } from "./commit-range";
import type { Commit } from "./types";

function commit(hash: string, parents: string[], timestamp: number): Commit {
  const person = {
    name: "Contributor",
    email: "contributor@example.com",
    timestamp,
    timezone: "+0000",
  };
  return {
    hash,
    tree: "tree",
    parents,
    author: person,
    committer: person,
    message: hash,
  };
}

describe("selectCommitRange", () => {
  it("subtracts every parent reachable from a no-ff base regardless of history order", () => {
    const root = commit("root", [], 100);
    const main = commit("main", [root.hash], 200);
    const feature = commit("feature", [main.hash], 400);
    const noFFBase = commit("no-ff-base", [main.hash, feature.hash], 300);
    const tip = commit("tip", [noFFBase.hash], 500);

    const range = selectCommitRange(
      [tip, feature, noFFBase, main, root],
      noFFBase.hash,
    );

    expect(range.map((entry) => entry.hash)).toEqual([tip.hash]);
  });

  it("preserves the fetched history when its base is unavailable", () => {
    const root = commit("root", [], 100);
    const tip = commit("tip", [root.hash], 200);
    const history = [tip, root];

    expect(selectCommitRange(history, "outside-window")).toEqual(history);
    expect(selectCommitRange(history, undefined)).toEqual(history);
  });
});
