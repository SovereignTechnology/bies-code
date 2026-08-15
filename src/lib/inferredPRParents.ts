import type { Filter } from "applesauce-core/helpers";
import type { NostrEvent } from "nostr-tools";
import {
  PR_KIND,
  PR_UPDATE_KIND,
  compareNip01Chronologically,
  getRootRepositoryCoordinates,
  isItemEventAuthorised,
} from "@/lib/nip34";

export interface InferredPRParent {
  rootId: string;
  subject: string;
}

export type InferredPRParentRelation =
  | {
      status: "matched";
      child: InferredPRParent;
      parents: [InferredPRParent];
    }
  | {
      status: "ambiguous";
      child: InferredPRParent;
      parents: InferredPRParent[];
    };

export interface InferredPRStackLayer {
  position: number;
  size: number;
}

/** Calculate a PR's layer within an unambiguous inferred chain. */
export function getInferredPRStackLayer(
  relations: ReadonlyMap<string, InferredPRParentRelation>,
  rootId: string,
): InferredPRStackLayer | undefined {
  const items = getInferredPRStackItems(relations, rootId);
  const position = items.findIndex((item) => item.rootId === rootId);
  return items.length > 1 && position >= 0
    ? { position: position + 1, size: items.length }
    : undefined;
}

/** Return the ordered PRs in the linear inferred chain containing rootId. */
export function getInferredPRStackItems(
  relations: ReadonlyMap<string, InferredPRParentRelation>,
  rootId: string,
): InferredPRParent[] {
  const parentOf = new Map<string, string>();
  const nodes = new Map<string, InferredPRParent>();
  for (const [childId, relation] of relations) {
    nodes.set(childId, relation.child);
    for (const parent of relation.parents) nodes.set(parent.rootId, parent);
    if (relation.status === "matched")
      parentOf.set(childId, relation.parents[0].rootId);
  }
  if (!nodes.has(rootId)) return [];

  const ancestorIds = [rootId];
  const ancestors = new Set(ancestorIds);
  let ancestor = rootId;
  while (parentOf.has(ancestor)) {
    ancestor = parentOf.get(ancestor)!;
    if (ancestors.has(ancestor)) return [];
    ancestors.add(ancestor);
    ancestorIds.unshift(ancestor);
  }

  const ordered = ancestorIds
    .map((id) => nodes.get(id))
    .filter((node): node is InferredPRParent => node !== undefined);
  if (ordered.length !== ancestorIds.length) return [];

  const visited = new Set(ancestorIds);
  let current: string | undefined = rootId;
  while (current) {
    const children = [...parentOf.entries()]
      .filter(([, parent]) => parent === current)
      .map(([child]) => child);
    // Multiple children are separate inferred branches, not one linear stack.
    current = children.length === 1 ? children[0] : undefined;
    if (!current) break;
    const node = nodes.get(current);
    if (!node || visited.has(current)) break;
    ordered.push(node);
    visited.add(current);
  }
  return ordered;
}

/** Direct, definite children of a PR, sorted for stable branch presentation. */
export function getInferredPRChildren(
  relations: ReadonlyMap<string, InferredPRParentRelation>,
  rootId: string,
): InferredPRParent[] {
  return [...relations.values()]
    .filter(
      (relation) =>
        relation.status === "matched" && relation.parents[0].rootId === rootId,
    )
    .map((relation) => relation.child)
    .sort((a, b) => a.rootId.localeCompare(b.rootId));
}

/** Ambiguous children for which rootId is one of several possible parents. */
export function getInferredPRAmbiguousChildren(
  relations: ReadonlyMap<string, InferredPRParentRelation>,
  rootId: string,
): InferredPRParent[] {
  return [...relations.values()]
    .filter(
      (relation) =>
        relation.status === "ambiguous" &&
        relation.parents.some((parent) => parent.rootId === rootId),
    )
    .map((relation) => relation.child)
    .sort((a, b) => a.rootId.localeCompare(b.rootId));
}

export function buildStackCandidateFilter(
  repoCoordinates: string[],
  mergeBases: string[],
): Filter | undefined {
  const commits = [...new Set(mergeBases.filter(Boolean))].sort();
  if (repoCoordinates.length === 0 || commits.length === 0) return undefined;
  return {
    kinds: [PR_KIND, PR_UPDATE_KIND],
    "#a": [...new Set(repoCoordinates)].sort(),
    "#c": commits,
  } as Filter;
}

function belongsToRepository(event: NostrEvent, coordinates: Set<string>) {
  return getRootRepositoryCoordinates(event).some((coord) =>
    coordinates.has(coord),
  );
}

/**
 * Resolve PR roots whose root or authorised update advertised each commit.
 *
 * A historical update may be the event that introduced the matching `c` tag,
 * so callers must not rely on the current root event alone.
 */
function getPRRootsByAdvertisedCommit(
  roots: NostrEvent[],
  candidates: NostrEvent[],
  repoCoordinates: string[],
): Map<string, Map<string, NostrEvent>> {
  const coordinates = new Set(repoCoordinates);
  const repoRoots = roots.filter(
    (event) =>
      event.kind === PR_KIND && belongsToRepository(event, coordinates),
  );
  const rootsById = new Map(repoRoots.map((event) => [event.id, event]));
  const maintainers = new Set(
    repoCoordinates.map((coord) => coord.split(":")[1]).filter(Boolean),
  );
  const byCommit = new Map<string, Map<string, NostrEvent>>();

  for (const event of candidates) {
    if (!belongsToRepository(event, coordinates)) continue;
    const commit = event.tags.find(([name]) => name === "c")?.[1];
    if (!commit) continue;
    const rootId =
      event.kind === PR_KIND
        ? event.id
        : event.kind === PR_UPDATE_KIND
          ? event.tags.find(([name]) => name === "E")?.[1]
          : undefined;
    const root = rootId ? rootsById.get(rootId) : undefined;
    if (!root) continue;
    if (
      event.kind === PR_UPDATE_KIND &&
      !isItemEventAuthorised(event.pubkey, root.pubkey, maintainers)
    )
      continue;

    const byRoot = byCommit.get(commit) ?? new Map<string, NostrEvent>();
    byRoot.set(root.id, root);
    byCommit.set(commit, byRoot);
  }

  return byCommit;
}

/** Return authoritative PR roots that have advertised an exact commit ID. */
export function getPRRootsAdvertisingCommit(
  roots: NostrEvent[],
  candidates: NostrEvent[],
  repoCoordinates: string[],
  commit: string,
): NostrEvent[] {
  return [
    ...(getPRRootsByAdvertisedCommit(roots, candidates, repoCoordinates)
      .get(commit)
      ?.values() ?? []),
  ].sort((a, b) => a.id.localeCompare(b.id));
}

/** Latest authorised merge base for each repository PR root. */
export function getEffectivePRMergeBases(
  roots: NostrEvent[],
  updates: NostrEvent[],
  repoCoordinates: string[],
): Map<string, string> {
  const coordinates = new Set(repoCoordinates);
  const repoRoots = roots.filter(
    (event) =>
      event.kind === PR_KIND && belongsToRepository(event, coordinates),
  );
  const rootsById = new Map(repoRoots.map((event) => [event.id, event]));
  const maintainers = new Set(
    repoCoordinates.map((coord) => coord.split(":")[1]).filter(Boolean),
  );
  const latestUpdates = new Map<string, NostrEvent>();
  for (const update of updates) {
    const rootId = update.tags.find(([name]) => name === "E")?.[1];
    const root = rootId ? rootsById.get(rootId) : undefined;
    if (
      update.kind !== PR_UPDATE_KIND ||
      !root ||
      !belongsToRepository(update, coordinates) ||
      !isItemEventAuthorised(update.pubkey, root.pubkey, maintainers)
    )
      continue;
    const previous = latestUpdates.get(root.id);
    if (!previous || compareNip01Chronologically(previous, update) < 0)
      latestUpdates.set(root.id, update);
  }

  const effective = new Map<string, string>();
  for (const root of repoRoots) {
    const mergeBase =
      latestUpdates
        .get(root.id)
        ?.tags.find(([name]) => name === "merge-base")?.[1] ??
      root.tags.find(([name]) => name === "merge-base")?.[1];
    if (mergeBase) effective.set(root.id, mergeBase);
  }
  return effective;
}

/** Resolve commit topology only; no event is treated as an explicit dependency. */
export function resolveInferredPRParents(
  roots: NostrEvent[],
  updates: NostrEvent[],
  candidates: NostrEvent[],
  repoCoordinates: string[],
): Map<string, InferredPRParentRelation> {
  const coordinates = new Set(repoCoordinates);
  const repoRoots = roots.filter(
    (event) =>
      event.kind === PR_KIND && belongsToRepository(event, coordinates),
  );
  const rootsById = new Map(repoRoots.map((event) => [event.id, event]));
  const maintainers = new Set(
    repoCoordinates.map((coord) => coord.split(":")[1]).filter(Boolean),
  );
  const authorisedUpdates = updates.filter((event) => {
    const rootId = event.tags.find(([name]) => name === "E")?.[1];
    const root = rootId ? rootsById.get(rootId) : undefined;
    return (
      event.kind === PR_UPDATE_KIND &&
      root !== undefined &&
      belongsToRepository(event, coordinates) &&
      isItemEventAuthorised(event.pubkey, root.pubkey, maintainers)
    );
  });

  const latestMergeBase = getEffectivePRMergeBases(
    repoRoots,
    authorisedUpdates,
    repoCoordinates,
  );

  const candidateRootsByCommit = getPRRootsByAdvertisedCommit(
    repoRoots,
    candidates,
    repoCoordinates,
  );

  const result = new Map<string, InferredPRParentRelation>();
  for (const [childId, mergeBase] of latestMergeBase) {
    const matches = [...(candidateRootsByCommit.get(mergeBase)?.values() ?? [])]
      .filter((root) => root.id !== childId)
      .map((root) => ({
        rootId: root.id,
        subject:
          root.tags.find(([name]) => name === "subject")?.[1] ?? "Untitled PR",
      }))
      .sort((a, b) => a.rootId.localeCompare(b.rootId));
    const childRoot = rootsById.get(childId);
    if (!childRoot) continue;
    const child = {
      rootId: childId,
      subject:
        childRoot.tags.find(([name]) => name === "subject")?.[1] ??
        "Untitled PR",
    };
    if (matches.length === 1)
      result.set(childId, {
        status: "matched",
        child,
        parents: [matches[0]],
      });
    else if (matches.length > 1)
      result.set(childId, { status: "ambiguous", child, parents: matches });
  }
  return result;
}
