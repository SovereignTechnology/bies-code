import { parseRepoCoordinate, type ResolvedRepo } from "@/lib/nip34";
import { repoToPath } from "@/lib/routeUtils";
import { useVerifiedNip05 } from "./useVerifiedNip05";

/**
 * Returns the canonical path for a repository, preferring a verified NIP-05
 * identity segment over the npub when one is available.
 *
 * The hook returns a path immediately (using npub as fallback) and updates
 * reactively once NIP-05 verification completes. If the profile's nip05 field
 * is already cached from a previous lookup the NIP-05 path is returned on the
 * first render with no flicker.
 *
 * @param pubkey  - hex pubkey of the repo maintainer
 * @param repoId  - the repo d-tag identifier
 * @param relays  - relay list (first entry used as hint)
 */
export function useRepoPath(
  pubkey: string,
  repoId: string,
  relays: string[],
): string {
  const verifiedNip05 = useVerifiedNip05(pubkey);
  return repoToPath(pubkey, repoId, relays, verifiedNip05);
}

/**
 * Build the default path for a discovered repository.
 *
 * Discovery links preserve the selected coordinate. The repository route
 * performs canonical lead rewriting only after its bounded graph refresh, so
 * a progressive card snapshot cannot choose a transient destination.
 */
export function useDefaultRepoPath(repo: ResolvedRepo): string {
  return useRepoPath(repo.selectedMaintainer, repo.dTag, repo.relays);
}

/**
 * Build the default path for a raw repository coordinate.
 *
 * Used when a discovery surface has an `a` tag but not a ResolvedRepo. Keep the
 * referenced coordinate intact and let the destination route resolve any
 * canonical lead after its graph refresh.
 */
export function useDefaultRepoCoordPath(
  coordinate: string,
): string | undefined {
  const parsed = parseRepoCoordinate(coordinate);
  const verifiedNip05 = useVerifiedNip05(parsed?.pubkey ?? "");

  if (!parsed) return undefined;

  return repoToPath(parsed.pubkey, parsed.identifier, [], verifiedNip05);
}
