/**
 * Shared Grasp utilities.
 */

export interface Nip11Document {
  name?: string;
  description?: string;
  pubkey?: string;
  self?: string;
  supported_nips?: number[];
  software?: string;
  version?: string;
  supported_grasps?: string[];
  repo_acceptance_criteria?: string;
}

export type GraspAccessMode = "private" | "curated" | "public" | "unknown";

export interface GraspAccessSummary {
  mode: GraspAccessMode;
  title: string;
  description: string;
  criteria: string | undefined;
}

/** Describe a service's advertised repository-admission policy conservatively. */
export function getGraspAccessSummary(
  document: Nip11Document,
): GraspAccessSummary {
  const criteria = document.repo_acceptance_criteria?.trim() || undefined;
  const normalizedCriteria = criteria?.toLowerCase() ?? "";
  const grasps = new Set(
    (document.supported_grasps ?? []).map((value) => value.toUpperCase()),
  );

  if (grasps.has("GRASP-08")) {
    return {
      mode: "private",
      title: "Private service",
      description:
        "Nostr authentication and membership in the service whitelist are required.",
      criteria,
    };
  }

  if (
    /^(none|no restrictions?|open|public|anyone|all repositories?)$/i.test(
      normalizedCriteria,
    ) ||
    /\b(anyone|publicly available|no (approval|restriction|allowlist|white.?list))\b/i.test(
      normalizedCriteria,
    )
  ) {
    return {
      mode: "public",
      title: "Public hosting",
      description:
        "Anyone can announce a repository and use the service under its normal GRASP authorization rules.",
      criteria,
    };
  }

  if (
    /\b(allowlist|white.?list|invite|approval|approved|curated|selected)\b/i.test(
      normalizedCriteria,
    )
  ) {
    return {
      mode: "curated",
      title: "Approval required",
      description:
        "This service only accepts repositories selected by its operator.",
      criteria,
    };
  }

  return {
    mode: "unknown",
    title: "Access policy unknown",
    description:
      "The operator has not published an access policy this client can classify safely.",
    criteria,
  };
}

export interface ValidateGraspServerOptions {
  /** GRASP capabilities the server must advertise in its NIP-11 document. */
  requiredGrasps?: readonly string[];
}

/** A GRASP service and its canonical Nostr relay endpoint. */
export interface GraspServer {
  /** Scheme-less HTTPS service address, or an http:// address for plaintext. */
  serviceAddress: string;
  /** Canonical WebSocket relay URL, including any service mount path. */
  wsUrl: string;
}

interface ParsedGraspServiceAddress {
  host: string;
  pathname: string;
  secure: boolean;
}

function parseGraspServiceAddress(
  value: string,
): ParsedGraspServiceAddress | undefined {
  const trimmed = value.trim();
  if (!trimmed) return undefined;

  const withScheme = /^[a-z][a-z0-9+.-]*:\/\//i.test(trimmed)
    ? trimmed
    : `wss://${trimmed}`;

  try {
    const url = new URL(withScheme);
    if (!["ws:", "wss:", "http:", "https:"].includes(url.protocol)) {
      return undefined;
    }
    if (
      !url.hostname ||
      url.username ||
      url.password ||
      url.search ||
      url.hash
    ) {
      return undefined;
    }

    return {
      host: url.host.toLowerCase(),
      pathname: url.pathname === "/" ? "" : url.pathname.replace(/\/+$/, ""),
      secure: url.protocol === "wss:" || url.protocol === "https:",
    };
  } catch {
    return undefined;
  }
}

/**
 * Normalize a GRASP service location while preserving its public mount path.
 *
 * Secure services use ngit's scheme-less form (`relay.example/grasp`), while
 * plaintext services retain `http://` so callers can derive `ws://` rather
 * than accidentally upgrading a local or onion service.
 */
export function normalizeGraspServiceAddress(value: string): string {
  const parsed = parseGraspServiceAddress(value);
  if (!parsed) return "";
  const address = `${parsed.host}${parsed.pathname}`;
  return parsed.secure ? address : `http://${address}`;
}

/** Convert a normalized GRASP service address to its Nostr relay URL. */
export function graspServiceAddressToRelayUrl(address: string): string {
  const parsed = parseGraspServiceAddress(address);
  if (!parsed) throw new Error(`Invalid GRASP service address: ${address}`);
  return `${parsed.secure ? "wss" : "ws"}://${parsed.host}${parsed.pathname}`;
}

/** Convert a normalized GRASP service address to its HTTP base URL. */
export function graspServiceAddressToHttpUrl(address: string): string {
  const parsed = parseGraspServiceAddress(address);
  if (!parsed) throw new Error(`Invalid GRASP service address: ${address}`);
  return `${parsed.secure ? "https" : "http"}://${parsed.host}${parsed.pathname}`;
}

/** Resolve a user-list value or service address into a canonical server. */
export function graspServerFromAddress(value: string): GraspServer | undefined {
  const serviceAddress = normalizeGraspServiceAddress(value);
  if (!serviceAddress) return undefined;
  return {
    serviceAddress,
    wsUrl: graspServiceAddressToRelayUrl(serviceAddress),
  };
}

/** Build a repository clone URL below a GRASP service's public mount path. */
export function graspRepositoryCloneUrl(
  serviceAddress: string,
  npub: string,
  encodedIdentifier: string,
): string {
  return `${graspServiceAddressToHttpUrl(serviceAddress)}/${npub}/${encodedIdentifier}.git`;
}

/** Whether a relay URL is the exact endpoint for a GRASP service address. */
export function relayMatchesGraspService(
  relayUrl: string,
  serviceAddresses: readonly string[],
): boolean {
  const relayAddress = normalizeGraspServiceAddress(relayUrl);
  return (
    !!relayAddress &&
    serviceAddresses.some(
      (address) => normalizeGraspServiceAddress(address) === relayAddress,
    )
  );
}

/** Fetch a GRASP server's NIP-11 document for read-only presentation. */
export async function fetchGraspServerInformation(
  serviceAddress: string,
  signal?: AbortSignal,
): Promise<Nip11Document> {
  const response = await fetch(graspServiceAddressToHttpUrl(serviceAddress), {
    headers: { Accept: "application/nostr+json" },
    signal: signal ?? AbortSignal.timeout(8000),
  });
  if (!response.ok) {
    throw new Error(`Server returned HTTP ${response.status}`);
  }

  const raw: unknown = await response.json();
  if (!raw || typeof raw !== "object" || Array.isArray(raw)) {
    throw new Error("Server returned an invalid NIP-11 document");
  }
  const document = raw as Record<string, unknown>;
  const stringField = (name: string) => {
    const value = document[name];
    return typeof value === "string" ? value : undefined;
  };
  const stringArray = (name: string) => {
    const value = document[name];
    return Array.isArray(value)
      ? value.filter((item): item is string => typeof item === "string")
      : undefined;
  };
  const numberArray = (name: string) => {
    const value = document[name];
    return Array.isArray(value)
      ? value.filter((item): item is number => typeof item === "number")
      : undefined;
  };

  return {
    name: stringField("name"),
    description: stringField("description"),
    pubkey: stringField("pubkey"),
    self: stringField("self"),
    supported_nips: numberArray("supported_nips"),
    software: stringField("software"),
    version: stringField("version"),
    supported_grasps: stringArray("supported_grasps"),
    repo_acceptance_criteria: stringField("repo_acceptance_criteria"),
  };
}

/** Whether a normalized value is a public GRASP service address. */
export function isValidGraspServiceAddress(serviceAddress: string): boolean {
  const normalized = normalizeGraspServiceAddress(serviceAddress);
  if (!normalized || normalized !== serviceAddress) return false;
  const parsed = parseGraspServiceAddress(normalized);
  if (!parsed || parsed.pathname.includes("//")) return false;
  const match = parsed.host.match(/^([a-z0-9.-]+\.[a-z]{2,})(?::(\d{1,5}))?$/);
  if (!match) return false;
  if (!match[2]) return true;
  const port = Number(match[2]);
  return port > 0 && port <= 65_535;
}

/** Deduplicate service addresses while preserving the first occurrence. */
export function uniqueGraspServiceAddresses(
  addresses: readonly string[],
): string[] {
  const seen = new Set<string>();
  const result: string[] = [];
  for (const value of addresses) {
    const address = normalizeGraspServiceAddress(value);
    if (!address || seen.has(address)) continue;
    seen.add(address);
    result.push(address);
  }
  return result;
}

/**
 * Select the first non-empty preference group, then backfill from defaults
 * until the desired redundancy is reached or the defaults are exhausted.
 */
export function selectGraspServiceAddressesWithBackfill(
  preferenceGroups: ReadonlyArray<readonly string[]>,
  defaults: readonly string[],
  minimum = 3,
): string[] {
  const preferred =
    preferenceGroups
      .map(uniqueGraspServiceAddresses)
      .find((addresses) => addresses.length > 0) ?? [];
  const selected = uniqueGraspServiceAddresses(preferred);

  for (const address of uniqueGraspServiceAddresses(defaults)) {
    if (selected.length >= minimum) break;
    if (!selected.includes(address)) selected.push(address);
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
  serviceAddress: string,
  options: ValidateGraspServerOptions = {},
): Promise<string | null> {
  const requiredGrasps = options.requiredGrasps ?? ["GRASP-01"];
  let doc: Nip11Document;

  try {
    const url = graspServiceAddressToHttpUrl(serviceAddress);
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
    return "Could not reach server — check the address and try again";
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
