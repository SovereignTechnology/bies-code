import type { LeadResolution } from "@/lib/nip34-maintainer-model";
import { repoToPath } from "@/lib/routeUtils";

export interface RepositoryLeadRedirectInput {
  selectedPubkey: string;
  dTag: string;
  relayHints: string[];
  pageSuffix: string;
  search: string;
  hash: string;
  leadResolution: LeadResolution;
  /**
   * First-fresh-EOSE tier of the announcement snapshot: at least one initial
   * relay delivered an actual EOSE for the identifier-only announcement wave
   * this session. Cached store data alone must never authorize a redirect —
   * a stale cached graph could route and then bounce on fresh data.
   */
  announcementsFreshEose: boolean;
}

/**
 * Build a canonical repository redirect only from a fresh, redirectable lead
 * result. Explicit and unique legacy-inferred leads may route; every absent,
 * unresolved, conflicting, or stale result remains on the selected coordinate.
 *
 * Both lead sources fire at the first fresh EOSE rather than the full
 * snapshot settle. Explicit leads are structurally fail-closed on partial
 * data (a complete `M`-path can be withheld but never fabricated), and for
 * legacy-inferred leads the first fresh EOSE view is graph-complete in
 * practice: a grasp/index relay holding any maintainer's announcement for a
 * repository holds the whole group's. A later correction arrives as another
 * `replace`-navigation — the existing recovery path.
 */
export function getRepositoryLeadRedirectPath({
  selectedPubkey,
  dTag,
  relayHints,
  pageSuffix,
  search,
  hash,
  leadResolution,
  announcementsFreshEose,
}: RepositoryLeadRedirectInput): string | undefined {
  if (!announcementsFreshEose) return undefined;
  if (
    leadResolution.source !== "explicit" &&
    leadResolution.source !== "legacy_inferred"
  ) {
    return undefined;
  }

  const leadMaintainer = leadResolution.leadMaintainer;
  if (!leadMaintainer || leadMaintainer === selectedPubkey) return undefined;

  return `${repoToPath(leadMaintainer, dTag, relayHints)}${pageSuffix}${search}${hash}`;
}
