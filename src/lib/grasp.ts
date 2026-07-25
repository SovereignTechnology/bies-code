/**
 * Shared Grasp utilities.
 */

interface Nip11Document {
  supported_grasps?: string[];
  [key: string]: unknown;
}

export interface ValidateGraspServerOptions {
  /** GRASP capabilities the server must advertise in its NIP-11 document. */
  requiredGrasps?: readonly string[];
}

/** Normalize a pasted WebSocket URL or domain to a lowercase host[:port]. */
export function normalizeGraspDomain(value: string): string {
  return value
    .trim()
    .toLowerCase()
    .replace(/^wss?:\/\//, "")
    .replace(/\/+$/, "");
}

/** Whether a normalized value looks like a public DNS hostname[:port]. */
export function isValidGraspDomain(domain: string): boolean {
  const match = domain.match(/^([a-z0-9.-]+\.[a-z]{2,})(?::(\d{1,5}))?$/);
  if (!match) return false;
  if (!match[2]) return true;
  const port = Number(match[2]);
  return port > 0 && port <= 65_535;
}

/** Deduplicate domains while preserving the first occurrence. */
export function uniqueGraspDomains(domains: readonly string[]): string[] {
  const seen = new Set<string>();
  const result: string[] = [];
  for (const value of domains) {
    const domain = normalizeGraspDomain(value);
    if (!domain || seen.has(domain)) continue;
    seen.add(domain);
    result.push(domain);
  }
  return result;
}

/**
 * Select the first non-empty preference group, then backfill from defaults
 * until the desired redundancy is reached or the defaults are exhausted.
 */
export function selectGraspDomainsWithBackfill(
  preferenceGroups: ReadonlyArray<readonly string[]>,
  defaults: readonly string[],
  minimum = 3,
): string[] {
  const preferred =
    preferenceGroups
      .map(uniqueGraspDomains)
      .find((domains) => domains.length > 0) ?? [];
  const selected = uniqueGraspDomains(preferred);

  for (const domain of uniqueGraspDomains(defaults)) {
    if (selected.length >= minimum) break;
    if (!selected.includes(domain)) selected.push(domain);
  }

  return selected;
}

/**
 * Fetch the NIP-11 relay information document for a domain and verify it
 * advertises the required GRASP capabilities.
 *
 * Returns `null` on success, or an error string to display to the user.
 */
export async function validateGraspServer(
  domain: string,
  options: ValidateGraspServerOptions = {},
): Promise<string | null> {
  const url = `https://${domain}`;
  const requiredGrasps = options.requiredGrasps ?? ["GRASP-01"];
  let doc: Nip11Document;

  try {
    const res = await fetch(url, {
      headers: { Accept: "application/nostr+json" },
      signal: AbortSignal.timeout(8000),
    });

    if (!res.ok) {
      return `Server returned HTTP ${res.status} — is it a Nostr relay?`;
    }

    doc = (await res.json()) as Nip11Document;
  } catch (err) {
    if (err instanceof DOMException && err.name === "TimeoutError") {
      return "Server did not respond in time";
    }
    return "Could not reach server — check the domain and try again";
  }

  const grasps = doc.supported_grasps;
  const missing = requiredGrasps.filter(
    (grasp) => !Array.isArray(grasps) || !grasps.includes(grasp),
  );
  if (missing.length > 0) {
    return `Server does not advertise ${missing.join(" and ")} support in NIP-11`;
  }

  return null;
}
