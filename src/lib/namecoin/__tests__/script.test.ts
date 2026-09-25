import { describe, it, expect } from "vitest";
import { bytesToHex } from "@noble/hashes/utils.js";

import {
  buildNameIndexScript,
  electrumScriptHash,
  extractNameValue,
  parseNameScript,
} from "@/lib/namecoin/script";
import { hexToBytes } from "@/lib/namecoin/hex";

const enc = new TextEncoder();

describe("hexToBytes", () => {
  it("decodes valid hex strictly", () => {
    expect(Array.from(hexToBytes("00ff"))).toEqual([0, 255]);
  });
  it("rejects odd-length input", () => {
    expect(() => hexToBytes("0")).toThrow(/odd/);
  });
  it("rejects invalid bytes", () => {
    expect(() => hexToBytes("0g")).toThrow(/invalid/);
  });
});

describe("buildNameIndexScript + electrumScriptHash", () => {
  it("builds the documented OP_NAME_UPDATE prefix for short names", () => {
    const script = buildNameIndexScript(enc.encode("d/testls"));
    const hex = bytesToHex(script);
    // 53 = OP_NAME_UPDATE; 08 = push 8 bytes; "d/testls" UTF-8; 00 push empty;
    // 6d = OP_2DROP; 75 = OP_DROP; 6a = OP_RETURN.
    expect(hex).toBe("530864" + "2f7465" + "73746c" + "73" + "00" + "6d756a");
  });

  it("uses OP_PUSHDATA1 for names ≥ 0x4c bytes", () => {
    const long = "d/" + "a".repeat(200);
    const script = buildNameIndexScript(enc.encode(long));
    // Second byte should be OP_PUSHDATA1 (0x4c).
    expect(script[1]).toBe(0x4c);
  });

  it("electrumScriptHash returns a 64-char hex SHA-256 result", () => {
    const script = buildNameIndexScript(enc.encode("d/example"));
    const h = electrumScriptHash(script);
    expect(h).toMatch(/^[0-9a-f]{64}$/);
  });
});

describe("parseNameScript + extractNameValue", () => {
  it("round-trips a NAME_UPDATE script with name + value", () => {
    // Build the script manually: 53 NAME, push("d/foo"), push('{"nostr":"…"}'), 6d 75 ...
    const name = "d/foo";
    const value = '{"nostr":"' + "a".repeat(64) + '"}';
    const nameBytes = enc.encode(name);
    const valueBytes = enc.encode(value);
    const out: number[] = [0x53];
    out.push(nameBytes.length);
    for (const b of nameBytes) out.push(b);
    // OP_PUSHDATA1 for value (which is > 0x4c bytes):
    out.push(0x4c, valueBytes.length);
    for (const b of valueBytes) out.push(b);
    out.push(0x6d, 0x75);
    const parsed = parseNameScript(new Uint8Array(out));
    expect(parsed).toEqual({ name, value });
  });

  it("returns null for non-NAME_UPDATE scripts", () => {
    expect(parseNameScript(new Uint8Array([0x6a]))).toBeNull();
  });

  it("parses a NAME_FIRSTUPDATE vout (52 opcode, name + rand + value)", () => {
    // OP_NAME_FIRSTUPDATE <push name> <push 20-byte rand> <pushdata1 value>
    // OP_2DROP OP_2DROP OP_DROP <p2pkh>
    const name = "d/foo";
    const value = '{"nostr":"' + "b".repeat(64) + '"}';
    const nameBytes = enc.encode(name);
    const valueBytes = enc.encode(value);
    const rand = new Uint8Array(20).fill(0xaa);
    const out: number[] = [0x52];
    out.push(nameBytes.length);
    for (const b of nameBytes) out.push(b);
    out.push(rand.length);
    for (const b of rand) out.push(b);
    out.push(0x4c, valueBytes.length);
    for (const b of valueBytes) out.push(b);
    out.push(0x6d, 0x6d, 0x75); // OP_2DROP OP_2DROP OP_DROP
    const parsed = parseNameScript(new Uint8Array(out));
    expect(parsed).toEqual({ name, value });
  });

  it("rejects NAME_FIRSTUPDATE with a non-20-byte rand push", () => {
    // Same layout as above but the rand push is 21 bytes — invalid.
    const nameBytes = enc.encode("d/foo");
    const out: number[] = [0x52];
    out.push(nameBytes.length);
    for (const b of nameBytes) out.push(b);
    out.push(21);
    for (let i = 0; i < 21; i++) out.push(0xaa);
    out.push(0x02, 0x7b, 0x7d); // push '{}'
    out.push(0x6d, 0x6d, 0x75);
    expect(parseNameScript(new Uint8Array(out))).toBeNull();
  });

  it("extractNameValue picks the FIRSTUPDATE vout for a freshly-registered name", () => {
    // Real-world case: d/mstrofnone, whose only on-chain tx is the
    // first-update. Mirror its layout (op 0x52, 12-byte name, 20-byte
    // rand, OP_PUSHDATA1 value).
    const name = "d/mstrofnone";
    const value =
      '{"nostr":{"pubkey":"' +
      "4".repeat(64) +
      '","relays":["wss://r.example/"]}}';
    const nameBytes = enc.encode(name);
    const valueBytes = enc.encode(value);
    const rand = new Uint8Array(20).fill(0x77);
    const out: number[] = [0x52];
    out.push(nameBytes.length);
    for (const b of nameBytes) out.push(b);
    out.push(rand.length);
    for (const b of rand) out.push(b);
    out.push(0x4c, valueBytes.length);
    for (const b of valueBytes) out.push(b);
    out.push(0x6d, 0x6d, 0x75);
    const hex = bytesToHex(new Uint8Array(out));
    const v = extractNameValue(
      [
        { scriptPubKey: { hex: "76a914aabb" } }, // p2pkh-ish, skipped
        { scriptPubKey: { hex } },
      ],
      name,
    );
    expect(v).toBe(value);
  });

  it("extractNameValue picks the matching vout and skips others", () => {
    // Vout 0: OP_RETURN noise (skipped because no 0x53 prefix).
    // Vout 1: NAME_UPDATE d/foo "{...}"
    const valueA = '{"nostr":"' + "a".repeat(64) + '"}';
    const valueB = enc.encode(valueA);
    const scriptBytes: number[] = [0x53, 5];
    for (const b of enc.encode("d/foo")) scriptBytes.push(b);
    scriptBytes.push(0x4c, valueB.length);
    for (const b of valueB) scriptBytes.push(b);
    scriptBytes.push(0x6d, 0x75);
    const hex = bytesToHex(new Uint8Array(scriptBytes));
    const v = extractNameValue(
      [{ scriptPubKey: { hex: "6a00" } }, { scriptPubKey: { hex } }],
      "d/foo",
    );
    expect(v).toBe(valueA);
  });
});
