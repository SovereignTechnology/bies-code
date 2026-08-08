/**
 * Identifier parsing for Namecoin `.bit` NIP-05 lookups.
 *
 * Accepts:
 *   - `alice@example.bit`
 *   - `example.bit`          (uses the `_` root entry)
 *   - `d/example`            (domain namespace, root)
 *   - `id/alice`             (identity namespace)
 *   - A leading `nostr:` NIP-21 prefix is tolerated.
 *
 * Local-part priority when scanning a `nostr.names` map (in `value.ts`):
 * exact → `_` → first valid entry (only when the identifier targets `_`).
 *
 * Ported semantically from the parallel implementations in Amethyst
 * (Kotlin), Nostur (Swift), rust-nostr `nip05namecoin`, applesauce's
 * `namecoin-identity` helper, ants's `lib/namecoin/identifier.ts`, and
 * nostr-tools PR #533.
 */

/**
 * Cheap front-door check: returns `true` when `identifier` should be
 * routed to Namecoin resolution instead of DNS-based NIP-05. Cheap
 * enough to use as a gate in hot paths before opening any socket.
 */
export function isNamecoinIdentifier(identifier?: string | null): boolean {
  if (typeof identifier !== "string") return false;
  let s = identifier.trim().toLowerCase();
  if (!s) return false;
  if (s.startsWith("nostr:")) s = s.slice(6);
  if (s.startsWith("d/")) return s.length > 2;
  if (s.startsWith("id/")) return s.length > 3;
  return s.endsWith(".bit") && s.length > 4;
}

/** Alias for {@link isNamecoinIdentifier}. */
export const isDotBit = isNamecoinIdentifier;

export type ParsedIdentifier = {
  /** Underlying Namecoin name to look up on chain, e.g. `d/example`. */
  namecoinName: string;
  /** Local-part within the name's value, or `_` for the root entry. */
  localPart: string;
  /** True for `d/` names (domain + `names` map); false for `id/`. */
  isDomain: boolean;
};

export function parseIdentifier(raw: string): ParsedIdentifier | null {
  if (typeof raw !== "string") return null;
  let input = raw.trim();
  if (!input) return null;
  if (input.length >= 6 && input.slice(0, 6).toLowerCase() === "nostr:") {
    input = input.slice(6);
  }
  const lower = input.toLowerCase();

  if (lower.startsWith("d/")) {
    const rest = lower.slice(2);
    if (!rest) return null;
    return { namecoinName: lower, localPart: "_", isDomain: true };
  }
  if (lower.startsWith("id/")) {
    const rest = lower.slice(3);
    if (!rest) return null;
    return { namecoinName: lower, localPart: "_", isDomain: false };
  }

  // user@domain.bit
  if (input.includes("@") && lower.endsWith(".bit")) {
    const atIdx = input.indexOf("@");
    const local = input.slice(0, atIdx).toLowerCase() || "_";
    const domainRaw = input.slice(atIdx + 1).toLowerCase();
    if (!domainRaw.endsWith(".bit")) return null;
    const domain = domainRaw.slice(0, -".bit".length);
    if (!domain) return null;
    return { namecoinName: `d/${domain}`, localPart: local, isDomain: true };
  }

  // bare.bit
  if (lower.endsWith(".bit")) {
    const domain = lower.slice(0, -".bit".length);
    if (!domain) return null;
    return { namecoinName: `d/${domain}`, localPart: "_", isDomain: true };
  }

  return null;
}
