/**
 * Pure lane-layout algorithm for rendering a condensed commit graph
 * (VS Code "Git Graph" style) from a set of commits with parent links.
 *
 * The input array may be in any order — `GitGraspPool.getCommitHistory`
 * returns commits sorted by committer timestamp, which is *not* a valid
 * display order for a graph (a merge parent can sort before the merge
 * commit). This module topologically sorts the commits (children before
 * parents, newest-first among ties) and assigns each commit a lane plus
 * the edge segments needed to draw rails between consecutive rows.
 *
 * Rendering model: each row owns a fixed-height cell. Edges describe
 * segments within that cell, connecting the top edge, the dot at the
 * vertical centre, and the bottom edge:
 *
 * - `pass`: a rail unrelated to this commit, running top → bottom.
 * - `in`:   a rail ending at this commit's dot (a child's parent link),
 *           running top → centre, curving from lane `from` to the dot.
 * - `out`:  a rail leaving this commit's dot towards a parent, running
 *           centre → bottom, curving from the dot to lane `to`.
 * - `stub`: a parent link whose target is outside the loaded commit set,
 *           drawn as a short fading tail below the dot rather than a
 *           persistent lane (avoids misleading full-height rails when
 *           history is truncated at a range or page boundary).
 */

import type { Commit } from "@/lib/git-grasp-pool";

/** Lane colors — chosen to read on both light and dark card backgrounds. */
export const GRAPH_LANE_COLORS = [
  "#ec4899", // pink
  "#3b82f6", // blue
  "#10b981", // emerald
  "#f59e0b", // amber
  "#8b5cf6", // violet
  "#06b6d4", // cyan
  "#ef4444", // red
  "#84cc16", // lime
  "#f97316", // orange
  "#14b8a6", // teal
];

export interface CommitGraphEdge {
  /** Lane index at the segment's start (top edge, or the dot for out/stub). */
  from: number;
  /** Lane index at the segment's end (the dot for in, or bottom edge). */
  to: number;
  /** Index into GRAPH_LANE_COLORS. */
  color: number;
  kind: "pass" | "in" | "out" | "stub";
}

export interface CommitGraphRow {
  commit: Commit;
  /** Lane (column) of this commit's dot. */
  lane: number;
  /** Index into GRAPH_LANE_COLORS for the dot. */
  color: number;
  /** True when the commit has more than one parent. */
  isMerge: boolean;
  edges: CommitGraphEdge[];
}

export interface CommitGraphLayout {
  /** Topologically ordered rows, newest first. */
  rows: CommitGraphRow[];
  /** Total number of lanes needed to render the graph. */
  laneCount: number;
}

function commitTime(commit: Commit): number {
  return commit.committer?.timestamp ?? commit.author.timestamp;
}

/**
 * Extract the merged-in source ref from a merge commit subject, e.g.
 * "Merge branch 'master' into feat/x" → "master", "Merge pull request #7
 * from alex/feat" → "alex/feat". Returns null when no pattern matches.
 */
export function parseMergeSourceRef(subject: string): string | null {
  const patterns = [
    /^Merge (?:remote-tracking )?branch '([^']+)'/,
    /^Merge (?:remote-tracking )?branch "([^"]+)"/,
    /^Merge pull request #\d+ (?:in \S+ )?from (\S+)/,
    /^Merge tag '([^']+)'/,
    /^Merge (\S+) into \S+/,
  ];
  for (const pattern of patterns) {
    const match = subject.match(pattern);
    if (match) return match[1];
  }
  return null;
}

export interface SpineCollapse {
  /** The tip's first-parent chain — the branch's own commits. */
  spine: Commit[];
  /**
   * Commits reachable only through a spine merge's later parents, keyed by
   * that merge's hash, sorted newest first. These are history merged in from
   * elsewhere (e.g. "merge master into feature"), not authored on the branch.
   */
  groups: Map<string, Commit[]>;
}

/**
 * Split a single-tip commit range (e.g. a PR's `reachable(tip) −
 * reachable(base)` set) into the tip's first-parent spine and, per spine
 * merge commit, the commits it merged in from other branches. Lets callers
 * collapse merged-in history instead of presenting it as the branch's own.
 *
 * Returns null when the set has no unique tip or nothing to collapse, in
 * which case the range should be rendered as-is.
 */
export function collapseMergedInCommits(
  commits: readonly Commit[],
): SpineCollapse | null {
  const byHash = new Map<string, Commit>();
  for (const commit of commits) {
    if (!byHash.has(commit.hash)) byHash.set(commit.hash, commit);
  }
  const referenced = new Set<string>();
  for (const commit of byHash.values()) {
    for (const parent of commit.parents) referenced.add(parent);
  }
  const tips = [...byHash.values()].filter(
    (commit) => !referenced.has(commit.hash),
  );
  if (tips.length !== 1) return null;

  const spineHashes = new Set<string>();
  let current: Commit | undefined = tips[0];
  while (current && !spineHashes.has(current.hash)) {
    spineHashes.add(current.hash);
    current = byHash.get(current.parents[0] ?? "");
  }
  if (spineHashes.size === byHash.size) return null;

  const claimed = new Set<string>();
  const groups = new Map<string, Commit[]>();
  // Spine order is newest→oldest, so an outer merge claims commits before
  // any older merge that can also reach them.
  for (const spineHash of spineHashes) {
    const spineCommit = byHash.get(spineHash);
    if (!spineCommit || spineCommit.parents.length < 2) continue;
    const group: Commit[] = [];
    const pending = spineCommit.parents.slice(1);
    while (pending.length > 0) {
      const hash = pending.pop();
      if (!hash || spineHashes.has(hash) || claimed.has(hash)) continue;
      const commit = byHash.get(hash);
      if (!commit) continue;
      claimed.add(hash);
      group.push(commit);
      pending.push(...commit.parents);
    }
    if (group.length > 0) {
      group.sort((a, b) => commitTime(b) - commitTime(a));
      groups.set(spineHash, group);
    }
  }
  if (groups.size === 0) return null;

  // Every commit must be accounted for — if any are neither on the spine nor
  // claimed by a merge (unexpected for a single-tip reachable set), render
  // the range as-is rather than hiding commits.
  if (spineHashes.size + claimed.size !== byHash.size) return null;

  const spine: Commit[] = [];
  for (const commit of commits) {
    if (spineHashes.has(commit.hash)) spine.push(commit);
  }
  return { spine, groups };
}

/**
 * Topologically sort commits so every child appears before its parents,
 * preferring newer committer timestamps among the commits that are ready.
 */
function topologicalOrder(byHash: Map<string, Commit>): Commit[] {
  const pendingChildren = new Map<string, number>();
  for (const commit of byHash.values()) {
    for (const parent of commit.parents) {
      if (byHash.has(parent)) {
        pendingChildren.set(parent, (pendingChildren.get(parent) ?? 0) + 1);
      }
    }
  }

  // Ready list kept sorted by ascending timestamp so pop() yields the newest.
  const ready = [...byHash.values()]
    .filter((commit) => !pendingChildren.has(commit.hash))
    .sort((a, b) => commitTime(a) - commitTime(b));

  const ordered: Commit[] = [];
  while (ready.length > 0) {
    const commit = ready.pop();
    if (!commit) break;
    ordered.push(commit);
    for (const parentHash of commit.parents) {
      const remaining = pendingChildren.get(parentHash);
      if (remaining === undefined) continue;
      if (remaining > 1) {
        pendingChildren.set(parentHash, remaining - 1);
        continue;
      }
      pendingChildren.delete(parentHash);
      const parent = byHash.get(parentHash);
      if (!parent) continue;
      let i = ready.length;
      while (i > 0 && commitTime(ready[i - 1]) > commitTime(parent)) i--;
      ready.splice(i, 0, parent);
    }
  }
  return ordered;
}

/**
 * Compute the graph layout for a set of commits. Duplicate hashes are
 * ignored; parent links pointing outside the set become `stub` edges.
 */
export function layoutCommitGraph(
  commits: readonly Commit[],
): CommitGraphLayout {
  const byHash = new Map<string, Commit>();
  for (const commit of commits) {
    if (!byHash.has(commit.hash)) byHash.set(commit.hash, commit);
  }

  const ordered = topologicalOrder(byHash);

  interface Lane {
    awaiting: string;
    color: number;
  }
  const lanes: (Lane | null)[] = [];
  let nextColor = 0;
  let laneCount = 0;
  const rows: CommitGraphRow[] = [];

  const firstFreeLane = (): number => {
    const free = lanes.indexOf(null);
    if (free !== -1) return free;
    lanes.push(null);
    return lanes.length - 1;
  };

  for (const commit of ordered) {
    const edges: CommitGraphEdge[] = [];

    // Lanes whose awaited commit is this one converge into the dot.
    const inLanes: number[] = [];
    lanes.forEach((laneState, index) => {
      if (laneState?.awaiting === commit.hash) inLanes.push(index);
    });

    let lane: number;
    let color: number;
    if (inLanes.length > 0) {
      lane = inLanes[0];
      color = lanes[lane]?.color ?? 0;
    } else {
      lane = firstFreeLane();
      color = nextColor++ % GRAPH_LANE_COLORS.length;
    }
    for (const index of inLanes) {
      const laneState = lanes[index];
      if (!laneState) continue;
      edges.push({ from: index, to: lane, color: laneState.color, kind: "in" });
      lanes[index] = null;
    }

    // Unrelated rails pass straight through this row.
    lanes.forEach((laneState, index) => {
      if (laneState) {
        edges.push({
          from: index,
          to: index,
          color: laneState.color,
          kind: "pass",
        });
      }
    });

    // Route parent links: the first in-set parent keeps the dot's lane; each
    // further parent either converges into a lane already awaiting it or
    // opens a new lane. Out-of-set parents collapse into one stub.
    let dotLaneUsed = false;
    let stubAdded = false;
    commit.parents.forEach((parentHash, parentIndex) => {
      if (!byHash.has(parentHash)) {
        if (!stubAdded) {
          edges.push({ from: lane, to: lane, color, kind: "stub" });
          stubAdded = true;
        }
        return;
      }
      if (parentIndex > 0) {
        const existing = lanes.findIndex(
          (laneState) => laneState?.awaiting === parentHash,
        );
        if (existing !== -1) {
          const laneState = lanes[existing];
          edges.push({
            from: lane,
            to: existing,
            color: laneState?.color ?? 0,
            kind: "out",
          });
          return;
        }
      }
      if (!dotLaneUsed) {
        lanes[lane] = { awaiting: parentHash, color };
        edges.push({ from: lane, to: lane, color, kind: "out" });
        dotLaneUsed = true;
      } else {
        const newLane = firstFreeLane();
        const newColor = nextColor++ % GRAPH_LANE_COLORS.length;
        lanes[newLane] = { awaiting: parentHash, color: newColor };
        edges.push({ from: lane, to: newLane, color: newColor, kind: "out" });
      }
    });

    for (const edge of edges) {
      laneCount = Math.max(laneCount, edge.from + 1, edge.to + 1);
    }
    laneCount = Math.max(laneCount, lane + 1);

    rows.push({
      commit,
      lane,
      color,
      isMerge: commit.parents.length > 1,
      edges,
    });

    while (lanes.length > 0 && lanes[lanes.length - 1] === null) lanes.pop();
  }

  return { rows, laneCount };
}
