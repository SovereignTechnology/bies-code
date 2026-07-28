/**
 * useRefsWithStatus — decorate the raw ref list from `useGitExplorer` with
 * per-ref status against the Nostr-signed state and the pool's per-URL
 * `refStatus` view. Ref commits and the effective source come from the pool's
 * shared `effectiveRefs` / `viewSource` layer.
 *
 * Extracted from `RefSelector.tsx` so the same decoration logic can be reused
 * by the full-page `/branches` and `/tags` views.
 */

import { useMemo } from "react";
import type { NostrEvent } from "nostr-tools";
import type { GitRef } from "@/hooks/useGitExplorer";
import type { RepositoryState } from "@/casts/RepositoryState";
import type {
  ResolvedRefMap,
  UrlState,
  ViewSource,
} from "@/lib/git-grasp-pool/types";
import {
  type RefWithStatus,
  getRefStatus,
  getRefStatusForServer,
  countMismatches,
} from "@/lib/refStatus";

export interface UseRefsWithStatusInput {
  /** All refs the explorer knows about (merged across servers). */
  refs: GitRef[];
  /** Winning Nostr state event, null if none found, undefined while loading. */
  repoState: RepositoryState | null | undefined;
  /** True once the relay EOSE has been received for the state query. */
  repoRelayEose: boolean;
  /** Per-relay state registry — used to detect "old-state" matches. */
  relayStateMap?: Map<string, NostrEvent>;
  /**
   * True when the git server is confirmed ahead of the Nostr-announced state.
   * Comes from `poolState.warning?.kind === "state-behind-git"`.
   */
  stateBehindGit: boolean;
  /** Pool-owned view preference. */
  viewSource: ViewSource;
  /** Pool-resolved display values for every known ref. */
  effectiveRefs: ResolvedRefMap;
  /** Full ref currently being viewed; defaults to the repository HEAD ref. */
  currentRefFullName?: string;
  /** Pool's winning git server clone URL. */
  winnerUrl?: string | null;
  /** Per-URL state from the pool. */
  urlStates: Record<string, UrlState>;
  /** All clone URLs declared by the repo. */
  cloneUrls: string[];
}

export interface UseRefsWithStatusResult {
  /** Resolved source for the active/default ref, used by the source selector. */
  effectiveSource: string;
  /** Every ref decorated with status and its own resolved display source. */
  refsWithStatus: RefWithStatus[];
  /** Branches only (preserves merged order from `refs`). */
  branches: RefWithStatus[];
  /** Tags only (preserves merged order from `refs`). */
  tags: RefWithStatus[];
  /** Number of genuine mismatches (excludes state-behind). */
  mismatchCount: number;
  /**
   * Branch count per clone URL — `undefined` for servers whose infoRefs
   * haven't been fetched yet, `number` once known (including 0).
   */
  branchCountByUrl: Record<string, number | undefined>;
  /** Tag count per clone URL — same semantics as `branchCountByUrl`. */
  tagCountByUrl: Record<string, number | undefined>;
  /** Branches in the Nostr state, or `undefined` while state is loading / absent. */
  nostrBranchCount: number | undefined;
  /** Tags in the Nostr state, or `undefined` while state is loading / absent. */
  nostrTagCount: number | undefined;
}

// ---------------------------------------------------------------------------
// Per-URL counting helpers
// ---------------------------------------------------------------------------

/**
 * Count distinct branches in a server's infoRefs.  Each ref name is counted
 * once, ignoring peeled `^{}` entries which are present only for annotated
 * tags.
 */
function countRefsByPrefix(
  infoRefs: { refs: Record<string, string> },
  prefix: string,
): number {
  let n = 0;
  for (const name of Object.keys(infoRefs.refs)) {
    if (name.endsWith("^{}")) continue;
    if (name.startsWith(prefix)) n++;
  }
  return n;
}

// ---------------------------------------------------------------------------
// Hook
// ---------------------------------------------------------------------------

export function useRefsWithStatus({
  refs,
  repoState,
  repoRelayEose,
  relayStateMap,
  stateBehindGit,
  viewSource,
  effectiveRefs,
  currentRefFullName,
  winnerUrl,
  urlStates,
  cloneUrls,
}: UseRefsWithStatusInput): UseRefsWithStatusResult {
  const effectiveSource = useMemo(() => {
    if (viewSource === "nostr") return "nostr";
    if (viewSource !== "authoritative") return viewSource;

    const defaultRef = refs.find((ref) => ref.isDefault && ref.isBranch);
    const fullRefName =
      currentRefFullName ??
      (defaultRef ? `refs/heads/${defaultRef.name}` : undefined);
    const resolved = fullRefName ? effectiveRefs[fullRefName] : undefined;
    return resolved?.source === "git"
      ? (resolved.sourceUrl ?? winnerUrl ?? "nostr")
      : "nostr";
  }, [viewSource, refs, effectiveRefs, winnerUrl, currentRefFullName]);

  // The git pool's info-refs are a useful cross-server view, but they can lag
  // behind a newly received signed state event. Include state-only refs so the
  // selector updates as soon as the EventStore receives the event, rather than
  // waiting for the pool's next info-refs fetch (or a page reload).
  const refsIncludingState = useMemo(() => {
    if (!repoState) return refs;

    const refPaths = new Set(
      refs.map(
        (ref) => `${ref.isBranch ? "refs/heads/" : "refs/tags/"}${ref.name}`,
      ),
    );
    const stateOnlyRefs: GitRef[] = [];

    for (const stateRef of repoState.refs) {
      const isBranch = stateRef.name.startsWith("refs/heads/");
      const isTag = stateRef.name.startsWith("refs/tags/");
      if ((!isBranch && !isTag) || refPaths.has(stateRef.name)) continue;

      stateOnlyRefs.push({
        name: stateRef.name.replace(/^refs\/(?:heads|tags)\//, ""),
        hash: stateRef.commitId,
        isBranch,
        isTag,
        isDefault: stateRef.name === repoState.headRef,
      });
    }

    return [...refs, ...stateOnlyRefs].map((ref) => {
      const fullRefName = `${ref.isBranch ? "refs/heads/" : "refs/tags/"}${ref.name}`;
      const effective = effectiveRefs[fullRefName];
      return effective ? { ...ref, hash: effective.commitId } : ref;
    });
  }, [refs, repoState, effectiveRefs]);

  // Compute status for each ref — against effectiveSource.
  // effectiveSource is always "nostr" or a concrete clone URL (never "default").
  const refsWithStatus: RefWithStatus[] = useMemo(() => {
    if (viewSource === "authoritative") {
      return refsIncludingState.map((ref) => {
        const fullRefName = `${ref.isBranch ? "refs/heads/" : "refs/tags/"}${ref.name}`;
        const effective = effectiveRefs[fullRefName];
        const refEffectiveSource =
          effective?.source === "git"
            ? (effective.sourceUrl ?? winnerUrl ?? "nostr")
            : "nostr";
        return {
          ...ref,
          effectiveSource: refEffectiveSource,
          ...getRefStatus(
            ref,
            repoState,
            repoRelayEose,
            effective?.source === "git",
            urlStates,
            cloneUrls,
          ),
        };
      });
    }

    if (viewSource === "nostr") {
      // "nostr" (whether explicit or resolved from "default") compares directly
      // against the signed Nostr state. When the user explicitly selected
      // "nostr" (overriding a git-ahead situation), pass stateBehindGit=false
      // so refs are compared against the state even when the server is ahead.
      return refsIncludingState.map((ref) => ({
        ...ref,
        effectiveSource: "nostr",
        ...getRefStatus(
          ref,
          repoState,
          repoRelayEose,
          false,
          urlStates,
          cloneUrls,
        ),
      }));
    }
    // A specific git server URL (explicit selection or resolved from "default")
    const serverUrlState = urlStates[viewSource];
    if (!serverUrlState?.infoRefs) {
      // Server not ready — fall back to nostr-state comparison
      return refsIncludingState.map((ref) => ({
        ...ref,
        effectiveSource: viewSource,
        ...getRefStatus(
          ref,
          repoState,
          repoRelayEose,
          stateBehindGit,
          urlStates,
          cloneUrls,
        ),
      }));
    }
    return refsIncludingState.map((ref) => ({
      ...ref,
      effectiveSource: viewSource,
      ...getRefStatusForServer(
        ref,
        serverUrlState,
        repoState,
        repoRelayEose,
        relayStateMap,
      ),
    }));
  }, [
    refsIncludingState,
    repoState,
    repoRelayEose,
    stateBehindGit,
    urlStates,
    cloneUrls,
    effectiveRefs,
    winnerUrl,
    viewSource,
    relayStateMap,
  ]);

  const branches = useMemo(
    () => refsWithStatus.filter((r) => r.isBranch),
    [refsWithStatus],
  );
  const tags = useMemo(
    () => refsWithStatus.filter((r) => r.isTag),
    [refsWithStatus],
  );

  const mismatchCount = useMemo(
    () => countMismatches(refsWithStatus),
    [refsWithStatus],
  );

  // Per-URL counts. `undefined` while infoRefs are still in flight so the
  // caller can render a skeleton; a concrete number (incl. 0) once known.
  const branchCountByUrl = useMemo(() => {
    const result: Record<string, number | undefined> = {};
    for (const url of cloneUrls) {
      const info = urlStates[url]?.infoRefs;
      result[url] = info ? countRefsByPrefix(info, "refs/heads/") : undefined;
    }
    return result;
  }, [cloneUrls, urlStates]);

  const tagCountByUrl = useMemo(() => {
    const result: Record<string, number | undefined> = {};
    for (const url of cloneUrls) {
      const info = urlStates[url]?.infoRefs;
      result[url] = info ? countRefsByPrefix(info, "refs/tags/") : undefined;
    }
    return result;
  }, [cloneUrls, urlStates]);

  const nostrBranchCount = useMemo(() => {
    if (repoState === undefined || !repoRelayEose) return undefined;
    if (repoState === null) return undefined;
    return repoState.refs.filter((r) => r.name.startsWith("refs/heads/"))
      .length;
  }, [repoState, repoRelayEose]);

  const nostrTagCount = useMemo(() => {
    if (repoState === undefined || !repoRelayEose) return undefined;
    if (repoState === null) return undefined;
    return repoState.refs.filter((r) => r.name.startsWith("refs/tags/")).length;
  }, [repoState, repoRelayEose]);

  return {
    effectiveSource,
    refsWithStatus,
    branches,
    tags,
    mismatchCount,
    branchCountByUrl,
    tagCountByUrl,
    nostrBranchCount,
    nostrTagCount,
  };
}
