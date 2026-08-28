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
  announcementsSettled: boolean;
}

/**
 * Build a canonical repository redirect only from a fresh, redirectable lead
 * result. Explicit and unique legacy-inferred leads may route; every absent,
 * unresolved, conflicting, or stale result remains on the selected coordinate.
 */
export function getRepositoryLeadRedirectPath({
  selectedPubkey,
  dTag,
  relayHints,
  pageSuffix,
  search,
  hash,
  leadResolution,
  announcementsSettled,
}: RepositoryLeadRedirectInput): string | undefined {
  if (!announcementsSettled) return undefined;
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
