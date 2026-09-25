import { describe, expect, it } from "vitest";
import type { NostrEvent } from "nostr-tools";
import {
  buildStackCandidateFilter,
  getEffectivePRMergeBases,
  getInferredPRChildren,
  getOpenInferredPRParent,
  getInferredPRStackItems,
  getInferredPRAmbiguousChildren,
  getInferredPRStackLayer,
  resolveInferredPRParents,
  withCurrentPRSubjects,
} from "./inferredPRParents";
import type { ResolvedPRLite } from "./nip34";

const repo = "30617:maintainer:repo";
function event(
  id: string,
  kind: number,
  tags: string[][],
  pubkey = "author",
  created_at = 1,
): NostrEvent {
  return { id, kind, tags, pubkey, created_at, content: "", sig: "sig" };
}
const root = (id: string, commit: string, mergeBase?: string) =>
  event(id, 1618, [
    ["a", repo],
    ["c", commit],
    ["subject", id],
    ...(mergeBase ? [["merge-base", mergeBase]] : []),
  ]);
const update = (
  id: string,
  rootId: string,
  commit: string,
  createdAt = 2,
  mergeBase?: string,
) =>
  event(
    id,
    1619,
    [
      ["a", repo],
      ["E", rootId],
      ["c", commit],
      ...(mergeBase ? [["merge-base", mergeBase]] : []),
    ],
    "author",
    createdAt,
  );

function resolvedPR(
  id: string,
  originalSubject: string,
  currentSubject: string,
  status: ResolvedPRLite["status"] = "open",
): ResolvedPRLite {
  return {
    id,
    pubkey: "author",
    event: root(id, `${id}-tip`),
    itemType: "pr",
    targetBranch: undefined,
    originalSubject,
    currentSubject,
    content: "",
    createdAt: 1,
    lastActivityAt: 1,
    status,
    labels: [],
    repoCoords: [repo],
    commentCount: 0,
    participantCount: 0,
    zapTotal: 0,
    authorisedUsers: new Set(["author"]),
    deletedEssentialEventIds: new Set(),
  };
}

describe("inferred PR parents", () => {
  it("matches root tips and resolves historical update tips to their root", () => {
    const parent = root("parent", "old-tip");
    const child = root("child", "child-tip", "old-tip");
    const historical = update("parent-update", parent.id, "old-tip");
    const result = resolveInferredPRParents(
      [parent, child],
      [historical],
      [parent, historical],
      [repo],
    );
    expect(result.get(child.id)).toEqual({
      status: "matched",
      child: { rootId: child.id, subject: "child" },
      parents: [{ rootId: parent.id, subject: "parent" }],
    });
  });

  it("applies authorised subject renames to every stack node", () => {
    const relations = new Map([
      [
        "child",
        {
          status: "matched" as const,
          child: { rootId: "child", subject: "Old child" },
          parents: [{ rootId: "parent", subject: "Old parent" }] as [
            { rootId: string; subject: string },
          ],
        },
      ],
    ]);

    const updated = withCurrentPRSubjects(relations, [
      resolvedPR("parent", "Old parent", "Renamed parent"),
      resolvedPR("child", "Old child", "Renamed child"),
    ]);

    expect(getInferredPRStackItems(updated, "child")).toEqual([
      { rootId: "parent", subject: "Renamed parent" },
      { rootId: "child", subject: "Renamed child" },
    ]);
  });

  it("recognises only a definite open or draft stack parent", () => {
    const relation = {
      status: "matched" as const,
      child: { rootId: "child", subject: "Child" },
      parents: [{ rootId: "parent", subject: "Original parent" }] as [
        { rootId: string; subject: string },
      ],
    };

    expect(
      getOpenInferredPRParent(relation, [
        resolvedPR("parent", "Original parent", "Current parent"),
      ]),
    ).toEqual({ rootId: "parent", subject: "Current parent" });
    expect(
      getOpenInferredPRParent(relation, [
        resolvedPR("parent", "Original parent", "Current parent", "resolved"),
      ]),
    ).toBeNull();
    expect(getOpenInferredPRParent(relation, undefined)).toBeUndefined();
  });

  it("uses a child's latest update merge base", () => {
    const parent = root("parent", "parent-tip");
    const child = root("child", "child-tip", "ordinary-base");
    const childUpdate = update(
      "child-update",
      child.id,
      "new-child-tip",
      3,
      "parent-tip",
    );
    const result = resolveInferredPRParents(
      [parent, child],
      [childUpdate],
      [parent],
      [repo],
    );
    expect(result.get(child.id)?.parents[0].rootId).toBe(parent.id);
  });

  it("falls back to the root merge base when the latest update omits it", () => {
    const parent = root("parent", "root-base");
    const staleParent = root("stale-parent", "stale-base");
    const child = root("child", "child-tip", "root-base");
    const older = update("older", child.id, "tip-2", 2, "stale-base");
    const latest = update("latest", child.id, "tip-3", 3);
    const result = resolveInferredPRParents(
      [parent, staleParent, child],
      [older, latest],
      [parent, staleParent],
      [repo],
    );
    expect(result.get(child.id)?.parents[0].rootId).toBe(parent.id);
  });

  it("excludes self matches and deduplicates a PR thread", () => {
    const parent = root("parent", "tip");
    const child = root("child", "tip", "tip");
    const duplicate = update("update", parent.id, "tip");
    const result = resolveInferredPRParents(
      [parent, child],
      [duplicate],
      [parent, child, duplicate],
      [repo],
    );
    expect(result.get(child.id)?.parents).toHaveLength(1);
    expect(result.has(parent.id)).toBe(false);
  });

  it("represents distinct roots advertising one commit as ambiguous", () => {
    const child = root("child", "child-tip", "shared");
    const result = resolveInferredPRParents(
      [root("a", "shared"), root("b", "shared"), child],
      [],
      [root("a", "shared"), root("b", "shared")],
      [repo],
    );
    expect(result.get(child.id)?.status).toBe("ambiguous");
    expect(result.get(child.id)?.parents).toHaveLength(2);
  });

  it("returns no match for missing candidates and excludes other repositories", () => {
    const child = root("child", "child-tip", "missing");
    const foreign = event("foreign", 1618, [
      ["a", "30617:maintainer:other"],
      ["c", "missing"],
    ]);
    expect(resolveInferredPRParents([child], [], [], [repo]).size).toBe(0);
    expect(resolveInferredPRParents([child], [], [foreign], [repo]).size).toBe(
      0,
    );
  });

  it("constructs one deduplicated repository-scoped batch filter", () => {
    expect(buildStackCandidateFilter([repo], ["b", "a", "b"])).toEqual({
      kinds: [1618, 1619],
      "#a": [repo],
      "#c": ["a", "b"],
    });
    expect(buildStackCandidateFilter([repo], [])).toBeUndefined();
  });

  it("queries only latest authorised effective merge bases", () => {
    const child = root("child", "tip", "root-base");
    const stale = update("stale", child.id, "tip-2", 2, "stale-base");
    const latest = update("latest", child.id, "tip-3", 3, "latest-base");
    const forged = event(
      "forged",
      1619,
      [
        ["a", repo],
        ["E", child.id],
        ["c", "forged-tip"],
        ["merge-base", "forged-base"],
      ],
      "attacker",
      4,
    );

    const effective = getEffectivePRMergeBases(
      [child],
      [stale, latest, forged],
      [repo],
    );
    expect([...effective.values()]).toEqual(["latest-base"]);
    expect(buildStackCandidateFilter([repo], [...effective.values()])).toEqual({
      kinds: [1618, 1619],
      "#a": [repo],
      "#c": ["latest-base"],
    });
  });

  it("uses the lower event ID as NIP-01's equal-timestamp winner", () => {
    const child = root("child", "tip", "root-base");
    const higherId = update("f".repeat(64), child.id, "tip-2", 3, "wrong-base");
    const lowerId = update("0".repeat(64), child.id, "tip-3", 3, "right-base");

    expect([
      ...getEffectivePRMergeBases(
        [child],
        [higherId, lowerId],
        [repo],
      ).values(),
    ]).toEqual(["right-base"]);
    expect([
      ...getEffectivePRMergeBases(
        [child],
        [lowerId, higherId],
        [repo],
      ).values(),
    ]).toEqual(["right-base"]);
  });

  it("calculates layers for every PR in an inferred chain", () => {
    const relations = new Map([
      [
        "middle",
        {
          status: "matched" as const,
          child: { rootId: "middle", subject: "Middle" },
          parents: [{ rootId: "base", subject: "Base" }] as [
            { rootId: string; subject: string },
          ],
        },
      ],
      [
        "top",
        {
          status: "matched" as const,
          child: { rootId: "top", subject: "Top" },
          parents: [{ rootId: "middle", subject: "Middle" }] as [
            { rootId: string; subject: string },
          ],
        },
      ],
    ]);
    expect(getInferredPRStackLayer(relations, "base")).toEqual({
      position: 1,
      size: 3,
    });
    expect(getInferredPRStackLayer(relations, "top")).toEqual({
      position: 3,
      size: 3,
    });
    expect(getInferredPRStackItems(relations, "base")).toEqual([
      { rootId: "base", subject: "Base" },
      { rootId: "middle", subject: "Middle" },
      { rootId: "top", subject: "Top" },
    ]);
  });

  it("exposes ambiguous relationships from each possible parent", () => {
    const relation = {
      status: "ambiguous" as const,
      child: { rootId: "child", subject: "Child" },
      parents: [
        { rootId: "a", subject: "A" },
        { rootId: "b", subject: "B" },
      ],
    };
    const relations = new Map([["child", relation]]);
    expect(getInferredPRAmbiguousChildren(relations, "a")).toEqual([
      relation.child,
    ]);
    expect(getInferredPRAmbiguousChildren(relations, "b")).toEqual([
      relation.child,
    ]);
    expect(getInferredPRAmbiguousChildren(relations, "other")).toEqual([]);
  });

  it("keeps forked stacks as coherent per-branch paths", () => {
    const relations = new Map([
      [
        "left",
        {
          status: "matched" as const,
          child: { rootId: "left", subject: "Left" },
          parents: [{ rootId: "base", subject: "Base" }] as [
            { rootId: string; subject: string },
          ],
        },
      ],
      [
        "right",
        {
          status: "matched" as const,
          child: { rootId: "right", subject: "Right" },
          parents: [{ rootId: "base", subject: "Base" }] as [
            { rootId: string; subject: string },
          ],
        },
      ],
    ]);

    expect(getInferredPRStackItems(relations, "left")).toEqual([
      { rootId: "base", subject: "Base" },
      { rootId: "left", subject: "Left" },
    ]);
    expect(getInferredPRStackLayer(relations, "left")).toEqual({
      position: 2,
      size: 2,
    });
    expect(getInferredPRStackLayer(relations, "base")).toBeUndefined();
    expect(getInferredPRChildren(relations, "base")).toEqual([
      { rootId: "left", subject: "Left" },
      { rootId: "right", subject: "Right" },
    ]);
  });

  it("keeps ancestors coherent when a non-root PR forks", () => {
    const matched = (child: string, parent: string) =>
      [
        child,
        {
          status: "matched" as const,
          child: { rootId: child, subject: child },
          parents: [{ rootId: parent, subject: parent }] as [
            { rootId: string; subject: string },
          ],
        },
      ] as const;
    const relations = new Map([
      matched("middle", "base"),
      matched("left", "middle"),
      matched("right", "middle"),
    ]);

    expect(getInferredPRStackItems(relations, "middle")).toEqual([
      { rootId: "base", subject: "base" },
      { rootId: "middle", subject: "middle" },
    ]);
    expect(getInferredPRStackLayer(relations, "middle")).toEqual({
      position: 2,
      size: 2,
    });
    expect(getInferredPRChildren(relations, "middle")).toEqual([
      { rootId: "left", subject: "left" },
      { rootId: "right", subject: "right" },
    ]);
  });
});
