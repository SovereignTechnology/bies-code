import type { Observable } from "rxjs";
import { parseRepoCoordinate, type ResolvedRepo } from "@/lib/nip34";
import { repoToPath } from "@/lib/routeUtils";
import { RepositoryModel } from "@/models/RepositoryModel";
import { use$ } from "./use$";
import { useEventStore } from "./useEventStore";
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
 * Discovery links prefer a resolved explicit, inferred, or implicit lead once
 * the recursive graph is available. Explicit route rewriting is handled
 * separately and accepts a complete signed `M` path or unique legacy winner.
 */
export function useDefaultRepoPath(repo: ResolvedRepo): string {
  const store = useEventStore();
  const resolvedRepo = use$(() => {
    return store.model(
      RepositoryModel,
      repo.selectedMaintainer,
      repo.dTag,
    ) as unknown as Observable<ResolvedRepo | undefined>;
  }, [store, repo.selectedMaintainer, repo.dTag]);
  const routeRepo = resolvedRepo ?? repo;
  const leadMaintainer = routeRepo.leadResolution.leadMaintainer;

  return useRepoPath(
    leadMaintainer ?? routeRepo.selectedMaintainer,
    routeRepo.dTag,
    routeRepo.relays,
  );
}

/**
 * Build the default path for a raw repository coordinate.
 *
 * Used when a discovery surface has an `a` tag but not a ResolvedRepo. The
 * shared RepositoryModel hydrates the graph, so repeated coordinates reuse the
 * cached model and missing announcements are loaded through the batched store
 * loader.
 */
export function useDefaultRepoCoordPath(
  coordinate: string,
): string | undefined {
  const store = useEventStore();
  const parsed = parseRepoCoordinate(coordinate);
  const resolvedRepo = use$(() => {
    if (!parsed) return undefined;
    return store.model(
      RepositoryModel,
      parsed.pubkey,
      parsed.identifier,
    ) as unknown as Observable<ResolvedRepo | undefined>;
  }, [store, parsed?.pubkey, parsed?.identifier]);
  const leadMaintainer = resolvedRepo?.leadResolution.leadMaintainer;
  const routePubkey = leadMaintainer ?? parsed?.pubkey ?? "";
  const verifiedNip05 = useVerifiedNip05(routePubkey);

  if (!parsed) return undefined;

  return repoToPath(
    routePubkey,
    parsed.identifier,
    resolvedRepo?.relays ?? [],
    verifiedNip05,
  );
}
