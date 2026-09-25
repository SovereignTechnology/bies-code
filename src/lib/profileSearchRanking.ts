import type { ProfileContent } from "applesauce-core/helpers";

export interface ProfileSearchCandidate {
  pubkey: string;
  profile: ProfileContent;
  createdAt: number;
}

interface RankedProfileSearchCandidate extends ProfileSearchCandidate {
  trustTier: number;
  matchTier: number;
}

function matchValue(value: string, query: string): number | undefined {
  const normalized = value.trim().toLowerCase();
  if (!normalized) return undefined;
  if (normalized === query) return 0;
  if (normalized.startsWith(query)) return 1;
  if (normalized.includes(query)) return 2;
  return undefined;
}

function getNip05Values(value: string): string[] {
  const normalized = value.trim().toLowerCase();
  if (!normalized) return [];

  const values = [normalized];
  if (normalized.startsWith("_@")) {
    const domain = normalized.slice(2);
    values.push(domain, domain.split(".")[0] ?? domain);
  } else {
    const localName = normalized.split("@")[0];
    if (localName) values.push(localName);
  }
  return values;
}

function getMatchTier(
  profile: ProfileContent,
  query: string,
): number | undefined {
  const primaryValues = [
    profile.name,
    profile.username,
    profile.display_name,
    profile.displayName,
    ...getNip05Values(typeof profile.nip05 === "string" ? profile.nip05 : ""),
  ].filter((value): value is string => typeof value === "string");

  let bestTier: number | undefined;
  for (const value of primaryValues) {
    const tier = matchValue(value, query);
    if (tier !== undefined && (bestTier === undefined || tier < bestTier)) {
      bestTier = tier;
    }
  }
  if (bestTier !== undefined) return bestTier;

  const about =
    typeof profile.about === "string"
      ? profile.about.trim().toLowerCase()
      : undefined;
  return about?.includes(query) ? 3 : undefined;
}

/**
 * Rank validated profile candidates by account trust first, then text quality.
 *
 * Trust: git-author follow, social follow, public candidate.
 * Text: exact, prefix, substring, about.
 */
export function rankProfileSearchCandidates(
  candidates: ProfileSearchCandidate[],
  query: string,
  gitFollows: ReadonlySet<string>,
  socialFollows: ReadonlySet<string>,
): ProfileSearchCandidate[] {
  const normalizedQuery = query.trim().toLowerCase();
  if (!normalizedQuery) return [];

  const ranked: RankedProfileSearchCandidate[] = [];
  for (const candidate of candidates) {
    const matchTier = getMatchTier(candidate.profile, normalizedQuery);
    if (matchTier === undefined) continue;

    ranked.push({
      ...candidate,
      trustTier: gitFollows.has(candidate.pubkey)
        ? 0
        : socialFollows.has(candidate.pubkey)
          ? 1
          : 2,
      matchTier,
    });
  }

  return ranked
    .sort(
      (a, b) =>
        a.trustTier - b.trustTier ||
        a.matchTier - b.matchTier ||
        b.createdAt - a.createdAt ||
        a.pubkey.localeCompare(b.pubkey),
    )
    .map(({ trustTier: _trustTier, matchTier: _matchTier, ...candidate }) => ({
      ...candidate,
    }));
}
