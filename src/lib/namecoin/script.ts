/**
 * Namecoin `OP_NAME_UPDATE` script construction + parsing.
 *
 * Builds the canonical name-index script used to derive the ElectrumX
 * scripthash for a name, and parses `name_update` vouts back into
 * `{ name, value }` pairs.
 *
 * The name-index script layout is:
 *   `OP_NAME_UPDATE <push(name)> <push(empty)> OP_2DROP OP_DROP OP_RETURN`
 *
 * Its SHA-256 (byte-reversed, hex-encoded) is the scripthash queried via
 * `blockchain.scripthash.get_history`.
 */
import { sha256 } from "@noble/hashes/sha2.js";
import { bytesToHex } from "@noble/hashes/utils.js";

import { hexToBytes } from "./hex";

/** Namecoin script opcodes used by the name-index script. */
const OP_NAME_NEW = 0x51; // OP_1, repurposed (no name/value visible)
const OP_NAME_FIRSTUPDATE = 0x52; // OP_2, repurposed; vout layout: name, rand, value
const OP_NAME_UPDATE = 0x53; // OP_3, repurposed; vout layout: name, value
const OP_2DROP = 0x6d;
const OP_DROP = 0x75;
const OP_RETURN = 0x6a;
const OP_PUSHDATA1 = 0x4c;
const OP_PUSHDATA2 = 0x4d;
const OP_PUSHDATA4 = 0x4e;

/**
 * Length (in bytes) of the random commitment push that sits between
 * the name and the value in an `OP_NAME_FIRSTUPDATE` vout. Namecoin
 * uses a 20-byte HASH160 here (per `namecore` consensus rules).
 */
const NAME_FIRSTUPDATE_RAND_LEN = 20;

export function buildNameIndexScript(nameBytes: Uint8Array): Uint8Array {
  const parts: number[] = [];
  parts.push(OP_NAME_UPDATE);
  pushData(parts, nameBytes);
  pushData(parts, new Uint8Array(0));
  parts.push(OP_2DROP, OP_DROP, OP_RETURN);
  return new Uint8Array(parts);
}

function pushData(out: number[], data: Uint8Array): void {
  const n = data.length;
  if (n < OP_PUSHDATA1) {
    out.push(n);
  } else if (n <= 0xff) {
    out.push(OP_PUSHDATA1, n);
  } else if (n <= 0xffff) {
    out.push(OP_PUSHDATA2, n & 0xff, (n >> 8) & 0xff);
  } else {
    out.push(
      OP_PUSHDATA4,
      n & 0xff,
      (n >> 8) & 0xff,
      (n >> 16) & 0xff,
      (n >> 24) & 0xff,
    );
  }
  for (let i = 0; i < n; i++) out.push(data[i]);
}

/** SHA-256 of `script`, byte-reversed, hex-encoded. */
export function electrumScriptHash(script: Uint8Array): string {
  const digest = sha256(script);
  const reversed = new Uint8Array(digest.length);
  for (let i = 0; i < digest.length; i++) {
    reversed[i] = digest[digest.length - 1 - i];
  }
  return bytesToHex(reversed);
}

/**
 * Find the vout that carries `name` and return its raw value JSON
 * string. Skips non-name outputs (the address-paying p2pkh script
 * that pays the registrant), `OP_NAME_NEW` outputs (which never
 * carry a value), and any `OP_NAME_FIRSTUPDATE` / `OP_NAME_UPDATE`
 * vout whose name push does not match `name`.
 *
 * Both `OP_NAME_FIRSTUPDATE` and `OP_NAME_UPDATE` are accepted so a
 * brand-new name (whose latest tx is still the first-update, e.g.
 * just-registered names like `d/mstrofnone`) resolves identically
 * to a name that has been re-published with an update.
 */
export function extractNameValue(
  vouts: Array<{ scriptPubKey?: { hex?: string } }>,
  name: string,
): string | null {
  for (const vout of vouts || []) {
    const hex = vout?.scriptPubKey?.hex;
    if (!hex) continue;
    // Cheap front-door: only name-op opcodes can carry a name + value.
    if (!hex.startsWith("52") && !hex.startsWith("53")) continue;
    let bytes: Uint8Array;
    try {
      bytes = hexToBytes(hex);
    } catch {
      continue;
    }
    const parsed = parseNameScript(bytes);
    if (!parsed) continue;
    if (parsed.name === name) return parsed.value;
  }
  return null;
}

/**
 * Decode a Namecoin name-op vout into its `{ name, value }` pair.
 *
 * Accepts both layouts that carry a value:
 *   - `OP_NAME_FIRSTUPDATE <name> <rand> <value> OP_2DROP OP_2DROP OP_DROP <p2pkh>`
 *   - `OP_NAME_UPDATE      <name> <value>       OP_2DROP OP_DROP        <p2pkh>`
 *
 * Returns `null` for `OP_NAME_NEW` outputs (no visible value) and for
 * anything that does not parse cleanly.
 */
export function parseNameScript(
  script: Uint8Array,
): { name: string; value: string } | null {
  if (script.length === 0) return null;
  const op = script[0];
  if (op !== OP_NAME_UPDATE && op !== OP_NAME_FIRSTUPDATE) {
    // OP_NAME_NEW intentionally falls through to null — the value
    // lives only in the matching first_update vout, not here.
    if (op === OP_NAME_NEW) return null;
    return null;
  }
  let pos = 1;
  const nameRead = readPushData(script, pos);
  if (!nameRead) return null;
  pos = nameRead.next;

  // FIRSTUPDATE wedges a 20-byte random commitment between the name and
  // the value; UPDATE goes straight to the value. Tolerate both.
  if (op === OP_NAME_FIRSTUPDATE) {
    const randRead = readPushData(script, pos);
    if (!randRead) return null;
    if (randRead.data.length !== NAME_FIRSTUPDATE_RAND_LEN) return null;
    pos = randRead.next;
  }

  const valueRead = readPushData(script, pos);
  if (!valueRead) return null;
  const decoder = new TextDecoder("utf-8", { fatal: false });
  return {
    name: decoder.decode(nameRead.data),
    value: decoder.decode(valueRead.data),
  };
}

function readPushData(
  script: Uint8Array,
  pos: number,
): { data: Uint8Array; next: number } | null {
  if (pos >= script.length) return null;
  const op = script[pos];
  if (op === 0x00) return { data: new Uint8Array(0), next: pos + 1 };
  if (op < OP_PUSHDATA1) {
    const length = op;
    const end = pos + 1 + length;
    if (end > script.length) return null;
    return { data: script.slice(pos + 1, end), next: end };
  }
  if (op === OP_PUSHDATA1) {
    if (pos + 2 > script.length) return null;
    const length = script[pos + 1];
    const end = pos + 2 + length;
    if (end > script.length) return null;
    return { data: script.slice(pos + 2, end), next: end };
  }
  if (op === OP_PUSHDATA2) {
    if (pos + 3 > script.length) return null;
    const length = script[pos + 1] | (script[pos + 2] << 8);
    const end = pos + 3 + length;
    if (end > script.length) return null;
    return { data: script.slice(pos + 3, end), next: end };
  }
  if (op === OP_PUSHDATA4) {
    if (pos + 5 > script.length) return null;
    const length =
      script[pos + 1] |
      (script[pos + 2] << 8) |
      (script[pos + 3] << 16) |
      (script[pos + 4] << 24);
    const end = pos + 5 + length;
    if (end < 0 || end > script.length) return null;
    return { data: script.slice(pos + 5, end), next: end };
  }
  return null;
}
