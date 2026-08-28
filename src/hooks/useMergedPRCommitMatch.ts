import { useMemo } from "react";
import type { Observable } from "rxjs";
import type { NostrEvent } from "nostr-tools";
import { use$ } from "@/hooks/use$";
import { useEventStore } from "@/hooks/useEventStore";
import {
  coordsCacheKey,
  hasAcceptedRepositoryReference,
  STATUS_RESOLVED,
  type ResolvedPRLite,
  type ResolvedRepo,
} from "@/lib/nip34";
import {
  buildStackCandidateFilter,
  getPRRootsAdvertisingCommit,
} from "@/lib/inferredPRParents";

export interface MergedPRCommitMatch {
  rootId: string;
  subject: string;
}

/**
 * Find one already-merged PR that advertised an exact commit ID.
 *
 * RepoLayout has already loaded the relevant NIP-34 events, so this is a
 * store-only lookup. Ambiguous matches deliberately return null rather than
 * attributing the commit to the wrong PR.
 *
 * The current PR must also have been opened before the matched PR's
 * maintainer-signed merged status. A fast-forwarded parent leaves no merge
 * commit, so the status event timestamp is the only record of when the parent
 * landed; the gate guards against mislabelling a PR that recorded a bad merge
 * base after its base commit was already merged. Timestamps are
 * author-claimed, so this is a safeguard for honest tooling, not attackers —
 * the merge itself always uses Git's computed base either way.
 */
export function useMergedPRCommitMatch(
  commitId: string | undefined,
  currentRootId: string,
  currentCreatedAt: number,
  prs: ResolvedPRLite[] | undefined,
  repo: ResolvedRepo,
): MergedPRCommitMatch | null | undefined {
  const store = useEventStore();
  const validCommitId =
    commitId && /^[0-9a-f]{40}$/i.test(commitId) ? commitId : undefined;
  const coordsKey = useMemo(
    () => coordsCacheKey(repo.confirmedMemberCoordinates),
    [repo.confirmedMemberCoordinates],
  );
  const coords = useMemo(
    () => (coordsKey ? coordsKey.split(",") : []),
    [coordsKey],
  );

  const candidateEvents = use$(() => {
    if (!validCommitId) return undefined;
    const filter = buildStackCandidateFilter(coords, [validCommitId]);
    if (!filter) return undefined;
    return store.timeline([filter]) as Observable<NostrEvent[]>;
  }, [coordsKey, store, validCommitId]);

  const parent = useMemo(() => {
    if (!validCommitId) return null;
    if (!prs || !candidateEvents) return undefined;

    const repoPRs = prs.filter((candidate) => candidate.itemType === "pr");
    const byRootId = new Map(
      repoPRs.map((candidate) => [candidate.id, candidate]),
    );
    const roots = repoPRs.map((candidate) => candidate.event);
    const matches = getPRRootsAdvertisingCommit(
      roots,
      candidateEvents,
      coords,
      validCommitId,
    )
      .map((root) => byRootId.get(root.id))
      .filter(
        (candidate): candidate is ResolvedPRLite =>
          candidate !== undefined &&
          candidate.id !== currentRootId &&
          candidate.status === "resolved" &&
          hasAcceptedRepositoryReference(candidate.repoCoords, repo),
      );

    if (matches.length !== 1) return null;
    return matches[0];
  }, [candidateEvents, coords, currentRootId, prs, repo, validCommitId]);

  const parentId = parent ? parent.id : undefined;
  const parentStatusEvents = use$(() => {
    if (!parentId) return undefined;
    return store.timeline([
      { kinds: [STATUS_RESOLVED], "#e": [parentId] },
    ]) as Observable<NostrEvent[]>;
  }, [parentId, store]);

  return useMemo(() => {
    if (!parent) return parent;
    if (!parentStatusEvents) return undefined;

    const mergedAt = parentStatusEvents
      .filter((ev) => repo.confirmedMaintainers.includes(ev.pubkey))
      .reduce((max, ev) => Math.max(max, ev.created_at), 0);
    if (mergedAt === 0 || currentCreatedAt >= mergedAt) return null;

    return {
      rootId: parent.id,
      subject: parent.currentSubject || parent.originalSubject,
    };
  }, [currentCreatedAt, parent, parentStatusEvents, repo]);
}
