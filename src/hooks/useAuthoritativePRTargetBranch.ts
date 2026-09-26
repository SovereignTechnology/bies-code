import { useEffect } from "react";
import type { RepositoryState } from "@/casts/RepositoryState";
import type { GitGraspPool, PoolState } from "@/lib/git-grasp-pool";
import { useAuthoritativeDefaultBranch } from "./useAuthoritativeDefaultBranch";

export interface AuthoritativePRTargetBranch {
  /** Effective PR target. The repository default is used when `b` is absent. */
  targetBranchName: string | undefined;
  /** Authoritative tip of the effective target branch. */
  targetBranchHead: string | undefined;
  /** Repository default branch, retained for explanatory UI. */
  defaultBranchName: string | undefined;
  /** Whether the effective target is the current repository default branch. */
  targetIsDefaultBranch: boolean;
  /** Whether the declared branch can safely be used as a git branch ref. */
  targetBranchValid: boolean;
}

/** Git's check-ref-format rules that apply to a branch name. */
export function isValidGitBranchName(branchName: string): boolean {
  const hasForbiddenCharacter = Array.from(branchName).some((character) => {
    const codePoint = character.codePointAt(0) ?? 0;
    return (
      codePoint <= 0x20 ||
      codePoint === 0x7f ||
      "~^:?*[".includes(character) ||
      character === "\\"
    );
  });

  if (
    !branchName ||
    branchName === "@" ||
    branchName.startsWith("-") ||
    branchName.startsWith("/") ||
    branchName.endsWith("/") ||
    branchName.endsWith(".") ||
    branchName.includes("..") ||
    branchName.includes("//") ||
    branchName.includes("@{") ||
    hasForbiddenCharacter
  ) {
    return false;
  }

  return branchName
    .split("/")
    .every(
      (component) => !component.startsWith(".") && !component.endsWith(".lock"),
    );
}

/**
 * Resolve a PR's target branch against the pool's protocol-truth ref view.
 *
 * Non-default refs are ancestry-verified lazily by GitGraspPool, whereas HEAD
 * is verified eagerly. Calling resolveRef here starts that verification and
 * the reactive PoolState update supplies the result on completion.
 */
export function useAuthoritativePRTargetBranch(
  gitPool: GitGraspPool | null,
  gitPoolState: PoolState,
  repoState: RepositoryState | null | undefined,
  declaredTargetBranch: string | undefined,
): AuthoritativePRTargetBranch {
  const { defaultBranchName, defaultBranchHead } =
    useAuthoritativeDefaultBranch(gitPoolState, repoState);
  const targetBranchName = declaredTargetBranch ?? defaultBranchName;
  const targetBranchValid =
    targetBranchName === undefined || isValidGitBranchName(targetBranchName);
  const targetIsDefaultBranch =
    !declaredTargetBranch || declaredTargetBranch === defaultBranchName;
  const targetRef =
    targetBranchName && targetBranchValid
      ? `refs/heads/${targetBranchName}`
      : undefined;

  useEffect(() => {
    if (!gitPool || !targetRef || targetIsDefaultBranch) return;
    void gitPool.resolveRef(targetRef);
  }, [gitPool, targetRef, targetIsDefaultBranch]);

  return {
    targetBranchName,
    targetBranchValid,
    targetBranchHead: targetIsDefaultBranch
      ? targetBranchValid
        ? defaultBranchHead
        : undefined
      : targetRef
        ? gitPoolState.authoritativeRefs[targetRef]?.commitId
        : undefined,
    defaultBranchName,
    targetIsDefaultBranch,
  };
}
