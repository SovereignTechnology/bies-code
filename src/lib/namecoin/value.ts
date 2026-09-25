/**
 * JSON value extraction for Namecoin name records.
 *
 * Pulls a Nostr pubkey + optional relay list out of the three shipped
 * wire shapes (simple, extended-domain, identity), and walks
 * [ifa-0001](https://github.com/namecoin/proposals/blob/master/ifa-0001.md)
 * `import` directives so a leaf-name pointing at a parent name with
 * `import: "d/parent"` resolves correctly.
 *
 * Import semantics:
 * - Importer keys (including `null`-valued ones, which act as suppression
 *   markers) override imported keys; remaining imported keys fill in.
 * - The canonical `import` value is `[[name, selector], ...]`. Shorthand
 *   forms `"d/foo"`, `["d/foo"]`, and `["d/foo", "sub"]` are accepted.
 * - The optional second element is a DNS-dotted Subdomain Selector that
 *   addresses a node inside the imported value's `map` tree. Walk is
 *   right-to-left (rightmost label first) with priority
 *   exact → `*` wildcard → `""` default. A non-object child terminates
 *   the walk and the import is skipped.
 * - Recursion depth defaults to 4 (spec minimum). Cycles are broken via
 *   a visited-set keyed `name|selector`.
 * - A failed import (`null`, throw, malformed JSON) is absorbed
 *   best-effort and treated as an empty object.
 *
 * Parser semantics ported from applesauce's `namecoin-identity` helper +
 * ants's `lib/namecoin/value.ts`, both of which were ported from
 * rust-nostr / Amethyst / Nostur / nostr-tools.
 */
import type { ParsedIdentifier } from "./identifier";

const HEX_PUBKEY_RE = /^[0-9a-fA-F]{64}$/;

export type NamecoinResolveResult = {
  pubkey: string;
  relays?: string[];
};

/** Spec-mandated minimum import-chain depth (ifa-0001). */
export const DEFAULT_IMPORT_DEPTH = 4;

/**
 * Async lookup callback used by {@link expandImports}. Returns the raw
 * Namecoin name-value JSON string for the supplied name, or `null` when
 * the name does not exist / cannot be fetched. Thrown errors are
 * absorbed by {@link expandImports} so a transient failure on one
 * sub-import never nukes the importing record.
 */
export type NamecoinValueFetcher = (
  namecoinName: string,
) => Promise<string | null>;

/**
 * Pull the `nostr` pubkey and optional relay list out of a Namecoin
 * name value. Supports the simple `"nostr": "hex"` form, the extended
 * `"nostr": { "names": {...}, "relays": {...} }` form, and the `id/`
 * identity object shape.
 *
 * For identifiers that come with an `import` directive, run
 * {@link resolveValueWithImports} first to merge the imported records
 * into the importing object before calling this.
 */
export function extractNostrFromValue(
  value: Record<string, unknown> | string,
  parsed: ParsedIdentifier,
): NamecoinResolveResult | null {
  let root: Record<string, unknown>;
  if (typeof value === "string") {
    try {
      const parsedJson = JSON.parse(value);
      if (!isPlainObject(parsedJson)) return null;
      root = parsedJson;
    } catch {
      return null;
    }
  } else {
    root = value;
  }

  const nostrField = root["nostr"];
  if (nostrField === undefined || nostrField === null) return null;

  // Simple form: "nostr": "hex-pubkey"
  if (typeof nostrField === "string") {
    if (parsed.isDomain && parsed.localPart !== "_") return null;
    if (!HEX_PUBKEY_RE.test(nostrField)) return null;
    return { pubkey: nostrField.toLowerCase() };
  }

  if (!isPlainObject(nostrField)) return null;

  return parsed.isDomain
    ? extractFromDomainNamesObject(nostrField, parsed)
    : extractFromIdentityObject(nostrField);
}

function extractFromDomainNamesObject(
  obj: Record<string, unknown>,
  parsed: ParsedIdentifier,
): NamecoinResolveResult | null {
  const names = obj["names"];
  if (!isPlainObject(names)) {
    // Some `d/<name>` records use the identity-style flat shape
    // (`"nostr": { "pubkey": "...", "relays": [...] }`) instead of the
    // canonical domain shape with a `names` map. Accept that shape only
    // when the identifier targets the root (`example.bit` / `d/example`,
    // no user local-part). A `user@example.bit` lookup against an
    // identity-shaped record still has to return `null` because there is
    // no local-part addressing here.
    if (parsed.localPart !== "_") return null;
    return extractFromIdentityObject(obj);
  }

  let pickedPubkey: string | null = null;

  const exact = names[parsed.localPart];
  if (typeof exact === "string" && HEX_PUBKEY_RE.test(exact)) {
    pickedPubkey = exact;
  } else {
    const underscore = names["_"];
    if (typeof underscore === "string" && HEX_PUBKEY_RE.test(underscore)) {
      pickedPubkey = underscore;
    } else if (parsed.localPart === "_") {
      for (const v of Object.values(names)) {
        if (typeof v === "string" && HEX_PUBKEY_RE.test(v)) {
          pickedPubkey = v;
          break;
        }
      }
    }
  }

  if (!pickedPubkey) return null;
  const relays = extractRelays(obj, pickedPubkey);
  return relays
    ? { pubkey: pickedPubkey.toLowerCase(), relays }
    : { pubkey: pickedPubkey.toLowerCase() };
}

function extractFromIdentityObject(
  obj: Record<string, unknown>,
): NamecoinResolveResult | null {
  const pk = obj["pubkey"];
  if (typeof pk === "string" && HEX_PUBKEY_RE.test(pk)) {
    const relaysRaw = obj["relays"];
    if (Array.isArray(relaysRaw)) {
      const relays = relaysRaw.filter(
        (r): r is string => typeof r === "string",
      );
      return relays.length > 0
        ? { pubkey: pk.toLowerCase(), relays }
        : { pubkey: pk.toLowerCase() };
    }
    return { pubkey: pk.toLowerCase() };
  }

  // Fall back to NIP-05-like "names" with "_" root.
  const names = obj["names"];
  if (isPlainObject(names)) {
    const underscore = names["_"];
    if (typeof underscore === "string" && HEX_PUBKEY_RE.test(underscore)) {
      const relays = extractRelays(obj, underscore);
      return relays
        ? { pubkey: underscore.toLowerCase(), relays }
        : { pubkey: underscore.toLowerCase() };
    }
  }

  return null;
}

function extractRelays(
  obj: Record<string, unknown>,
  pubkey: string,
): string[] | null {
  const raw = obj["relays"];
  if (!raw) return null;
  // Domain shape: `relays` is a map keyed by pubkey -> array.
  if (isPlainObject(raw)) {
    const candidate = raw[pubkey.toLowerCase()] ?? raw[pubkey];
    if (!Array.isArray(candidate)) return null;
    const relays = candidate.filter((r): r is string => typeof r === "string");
    return relays.length > 0 ? relays : null;
  }
  // Identity shape: `relays` is a flat array.
  if (Array.isArray(raw)) {
    const relays = raw.filter((r): r is string => typeof r === "string");
    return relays.length > 0 ? relays : null;
  }
  return null;
}

// ---------------------------------------------------------------------------
// Import-chain resolution (ifa-0001 §"import")
// ---------------------------------------------------------------------------

type ImportOp = {
  /** Namecoin name to import (e.g. `d/foo`). */
  name: string;
  /** DNS-dotted subdomain selector inside the imported value. */
  selector: string;
};

/**
 * Resolve `import` directives in a Namecoin name value, merging the
 * imported records underneath the importing one with importer-wins
 * precedence. The result is the same shape as the input minus the
 * `import` key.
 *
 * If `valueJSON` has no `import` key (or fails to parse), it is
 * returned as a parsed object unchanged with zero extra I/O.
 */
export async function resolveValueWithImports(
  valueJSON: string,
  lookup: NamecoinValueFetcher,
  maxDepth: number = DEFAULT_IMPORT_DEPTH,
): Promise<Record<string, unknown> | null> {
  const root = tryParseObject(valueJSON);
  if (!root) return null;
  if (!("import" in root)) return root;
  return expandRecursive(root, lookup, maxDepth, new Set<string>());
}

async function expandRecursive(
  obj: Record<string, unknown>,
  lookup: NamecoinValueFetcher,
  budgetRemaining: number,
  visited: Set<string>,
): Promise<Record<string, unknown>> {
  const item = obj["import"];
  if (item === undefined) return obj;
  const ops = parseImportItem(item);
  if (!ops || ops.length === 0 || budgetRemaining <= 0) {
    return omitImportKey(obj);
  }

  let accumulator: Record<string, unknown> = {};
  for (const op of ops) {
    const visitKey = `${op.name}|${op.selector}`;
    if (visited.has(visitKey)) continue;
    visited.add(visitKey);
    try {
      let raw: string | null;
      try {
        raw = await lookup(op.name);
      } catch {
        raw = null;
      }
      if (raw == null) continue;
      const importedRoot = tryParseObject(raw);
      if (!importedRoot) continue;
      const selectorView = applySelector(importedRoot, op.selector);
      if (!selectorView) continue;
      const expanded = await expandRecursive(
        selectorView,
        lookup,
        budgetRemaining - 1,
        visited,
      );
      accumulator = mergeImporterWins(expanded, accumulator);
    } finally {
      visited.delete(visitKey);
    }
  }

  const withoutImport = omitImportKey(obj);
  return mergeImporterWins(withoutImport, accumulator);
}

function parseImportItem(item: unknown): ImportOp[] | null {
  // Shorthand: bare string -> single import with no selector.
  if (typeof item === "string") {
    const trimmed = item.trim();
    if (!trimmed) return null;
    return [{ name: trimmed, selector: "" }];
  }
  if (!Array.isArray(item)) return null;
  if (item.length === 0) return [];

  // Distinguish canonical array-of-arrays from shorthand array-of-strings.
  if (Array.isArray(item[0])) {
    const ops: ImportOp[] = [];
    for (const entry of item) {
      if (!Array.isArray(entry)) continue;
      const op = opFromArray(entry);
      if (op) ops.push(op);
    }
    return ops;
  }
  const op = opFromArray(item);
  return op ? [op] : [];
}

function opFromArray(arr: unknown[]): ImportOp | null {
  if (arr.length === 0) return null;
  const first = arr[0];
  if (typeof first !== "string") return null;
  const name = first.trim();
  if (!name) return null;
  let selector = "";
  if (arr.length >= 2) {
    const second = arr[1];
    if (typeof second !== "string") return null;
    selector = second.trim();
  }
  // Trailing dot is forbidden by spec; treat as malformed -> no selector.
  if (selector.endsWith(".")) return null;
  return { name, selector };
}

/**
 * Walk a DNS-dotted `selector` into `root.map` per ifa-0001 §"map".
 * Returns the addressed node, or `null` if no match exists.
 *
 * Per-label resolution: exact match → `*` wildcard → `""` default.
 * A non-object child terminates the walk with `null`. Labels walked
 * right-to-left (rightmost is most-specific in DNS-dotted form).
 */
function applySelector(
  root: Record<string, unknown>,
  selector: string,
): Record<string, unknown> | null {
  if (!selector) return root;
  const labels = selector
    .split(".")
    .filter((l) => l.length > 0)
    .reverse();
  if (labels.length === 0) return root;

  let current: Record<string, unknown> = root;
  for (const label of labels) {
    const map = current["map"];
    if (!isPlainObject(map)) return null;
    const exact = map[label];
    if (isPlainObject(exact)) {
      current = exact;
      continue;
    }
    const wildcard = map["*"];
    if (isPlainObject(wildcard)) {
      current = wildcard;
      continue;
    }
    const fallback = map[""];
    if (isPlainObject(fallback)) {
      current = fallback;
      continue;
    }
    return null;
  }
  return current;
}

function omitImportKey(obj: Record<string, unknown>): Record<string, unknown> {
  if (!("import" in obj)) return obj;
  const out: Record<string, unknown> = {};
  for (const [k, v] of Object.entries(obj)) {
    if (k !== "import") out[k] = v;
  }
  return out;
}

/**
 * Merge `imported` underneath `importer` with importer-wins precedence
 * per ifa-0001. Keys present in `importer` (including `null` values,
 * which act as semantic suppression markers) override imported keys;
 * remaining imported keys fill in.
 */
function mergeImporterWins(
  importer: Record<string, unknown>,
  imported: Record<string, unknown>,
): Record<string, unknown> {
  if (Object.keys(imported).length === 0) return importer;
  if (Object.keys(importer).length === 0) return imported;
  const out: Record<string, unknown> = {};
  for (const [k, v] of Object.entries(imported)) out[k] = v;
  for (const [k, v] of Object.entries(importer)) out[k] = v;
  return out;
}

function tryParseObject(raw: string): Record<string, unknown> | null {
  try {
    const parsed = JSON.parse(raw);
    return isPlainObject(parsed) ? parsed : null;
  } catch {
    return null;
  }
}

function isPlainObject(value: unknown): value is Record<string, unknown> {
  return typeof value === "object" && value !== null && !Array.isArray(value);
}
