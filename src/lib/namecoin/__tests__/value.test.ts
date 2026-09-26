import { describe, it, expect } from "vitest";
import { parseIdentifier } from "@/lib/namecoin/identifier";
import {
  extractNostrFromValue,
  resolveValueWithImports,
  type NamecoinValueFetcher,
} from "@/lib/namecoin/value";

const PK_ROOT =
  "aaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaa";
const PK_ALICE =
  "bbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbb";
const PK_BOB =
  "cccccccccccccccccccccccccccccccccccccccccccccccccccccccccccccccc";

describe("extractNostrFromValue — simple form", () => {
  const parsed = parseIdentifier("example.bit")!;

  it("accepts a bare hex pubkey on the root entry", () => {
    expect(extractNostrFromValue({ nostr: PK_ROOT }, parsed)).toEqual({
      pubkey: PK_ROOT,
    });
  });

  it("rejects a bare hex pubkey when a specific local part is asked", () => {
    const aliceParsed = parseIdentifier("alice@example.bit")!;
    expect(extractNostrFromValue({ nostr: PK_ROOT }, aliceParsed)).toBeNull();
  });

  it("rejects non-hex strings", () => {
    expect(extractNostrFromValue({ nostr: "not-a-pubkey" }, parsed)).toBeNull();
  });
});

describe("extractNostrFromValue — extended domain form", () => {
  it("returns exact match before the underscore root", () => {
    const value = {
      nostr: { names: { _: PK_ROOT, alice: PK_ALICE } },
    };
    const root = parseIdentifier("example.bit")!;
    const alice = parseIdentifier("alice@example.bit")!;
    expect(extractNostrFromValue(value, root)).toEqual({
      pubkey: PK_ROOT,
    });
    expect(extractNostrFromValue(value, alice)).toEqual({
      pubkey: PK_ALICE,
    });
  });

  it("falls back to underscore when the exact match is missing", () => {
    const value = { nostr: { names: { _: PK_ROOT } } };
    const alice = parseIdentifier("alice@example.bit")!;
    expect(extractNostrFromValue(value, alice)).toEqual({
      pubkey: PK_ROOT,
    });
  });

  it("falls back to the first valid pubkey only when targeting the root", () => {
    const value = { nostr: { names: { bob: PK_BOB } } };
    expect(
      extractNostrFromValue(value, parseIdentifier("example.bit")!),
    ).toEqual({ pubkey: PK_BOB });
    expect(
      extractNostrFromValue(value, parseIdentifier("alice@example.bit")!),
    ).toBeNull();
  });

  it("attaches relays from the per-pubkey relays map", () => {
    const value = {
      nostr: {
        names: { alice: PK_ALICE },
        relays: { [PK_ALICE]: ["wss://r1", "wss://r2"] },
      },
    };
    expect(
      extractNostrFromValue(value, parseIdentifier("alice@example.bit")!),
    ).toEqual({ pubkey: PK_ALICE, relays: ["wss://r1", "wss://r2"] });
  });
});

describe("extractNostrFromValue — domain name with identity-shaped value", () => {
  // Some `d/<name>` records on chain use the flat identity shape
  // (`{ nostr: { pubkey, relays } }`) instead of the canonical domain
  // shape (`{ nostr: { names: { ... } } }`). Real-world example:
  // `d/mstrofnone` and `d/testls`. The resolver must accept this when
  // the identifier targets the root.
  it("accepts identity-shape value for d/<name> targeting the root", () => {
    const value = {
      nostr: { pubkey: PK_ALICE, relays: ["wss://a", "wss://b"] },
    };
    expect(extractNostrFromValue(value, parseIdentifier("d/alice")!)).toEqual({
      pubkey: PK_ALICE,
      relays: ["wss://a", "wss://b"],
    });
  });

  it("accepts identity-shape value for bare.bit targeting the root", () => {
    const value = { nostr: { pubkey: PK_ALICE } };
    expect(extractNostrFromValue(value, parseIdentifier("alice.bit")!)).toEqual(
      { pubkey: PK_ALICE },
    );
  });

  it("rejects identity-shape value when a specific local-part is asked", () => {
    const value = {
      nostr: { pubkey: PK_ALICE, relays: ["wss://a"] },
    };
    expect(
      extractNostrFromValue(value, parseIdentifier("bob@alice.bit")!),
    ).toBeNull();
  });
});

describe("extractNostrFromValue — identity form", () => {
  it("returns pubkey + relay array", () => {
    const value = {
      nostr: { pubkey: PK_ALICE, relays: ["wss://a", "wss://b"] },
    };
    expect(extractNostrFromValue(value, parseIdentifier("id/alice")!)).toEqual({
      pubkey: PK_ALICE,
      relays: ["wss://a", "wss://b"],
    });
  });

  it("falls back to a names map with _ on identity form", () => {
    const value = { nostr: { names: { _: PK_ALICE } } };
    expect(extractNostrFromValue(value, parseIdentifier("id/alice")!)).toEqual({
      pubkey: PK_ALICE,
    });
  });

  it("ignores an empty relays array", () => {
    const value = { nostr: { pubkey: PK_ALICE, relays: [] } };
    expect(extractNostrFromValue(value, parseIdentifier("id/alice")!)).toEqual({
      pubkey: PK_ALICE,
    });
  });
});

describe("extractNostrFromValue — input shapes", () => {
  it("accepts a raw JSON string", () => {
    const json = JSON.stringify({ nostr: PK_ROOT });
    expect(
      extractNostrFromValue(json, parseIdentifier("example.bit")!),
    ).toEqual({ pubkey: PK_ROOT });
  });

  it("returns null on malformed JSON", () => {
    expect(
      extractNostrFromValue("not json", parseIdentifier("example.bit")!),
    ).toBeNull();
  });
});

// ---------------------------------------------------------------------------
// resolveValueWithImports — ifa-0001
// ---------------------------------------------------------------------------

function fakeLookup(records: Record<string, unknown>): NamecoinValueFetcher {
  return async (name) => {
    if (!(name in records)) return null;
    return JSON.stringify(records[name]);
  };
}

describe("resolveValueWithImports — basic import", () => {
  it("returns the input parsed when no import key is present", async () => {
    const json = JSON.stringify({ nostr: PK_ROOT });
    const out = await resolveValueWithImports(json, async () => null);
    expect(out).toEqual({ nostr: PK_ROOT });
  });

  it("merges a single imported record with importer-wins precedence", async () => {
    const parent = { nostr: { names: { _: PK_ROOT } } };
    const child = {
      import: "d/parent",
      nostr: { names: { alice: PK_ALICE } },
    };
    const merged = await resolveValueWithImports(
      JSON.stringify(child),
      fakeLookup({ "d/parent": parent }),
    );
    // Importer's nostr.names wins entirely because nostr is a leaf object
    // here — importer-wins precedence is per-top-level-key.
    expect(merged?.nostr).toEqual({ names: { alice: PK_ALICE } });
  });

  it("fills in keys missing on the importer from the imported record", async () => {
    const parent = { ip: "1.2.3.4", nostr: PK_ROOT };
    const child = { import: "d/parent", ip: "9.9.9.9" };
    const merged = await resolveValueWithImports(
      JSON.stringify(child),
      fakeLookup({ "d/parent": parent }),
    );
    expect(merged).toEqual({ ip: "9.9.9.9", nostr: PK_ROOT });
  });

  it("treats null importer values as suppression markers", async () => {
    const parent = { ip: "1.2.3.4", nostr: PK_ROOT };
    const child = { import: "d/parent", ip: null };
    const merged = await resolveValueWithImports(
      JSON.stringify(child),
      fakeLookup({ "d/parent": parent }),
    );
    expect(merged?.ip).toBeNull();
    expect(merged?.nostr).toBe(PK_ROOT);
  });
});

describe("resolveValueWithImports — selector walk", () => {
  it("walks DNS-dotted selectors right-to-left through map.<label>", async () => {
    const parent = {
      map: {
        org: {
          map: {
            blog: { nostr: PK_ALICE },
          },
        },
      },
    };
    const child = { import: [["d/parent", "blog.org"]] };
    const merged = await resolveValueWithImports(
      JSON.stringify(child),
      fakeLookup({ "d/parent": parent }),
    );
    expect(merged?.nostr).toBe(PK_ALICE);
  });

  it("prefers exact label over * wildcard over empty default", async () => {
    const parent = {
      map: {
        "*": { nostr: PK_ROOT },
        "": { nostr: PK_BOB },
        blog: { nostr: PK_ALICE },
      },
    };
    expect(
      (
        await resolveValueWithImports(
          JSON.stringify({ import: [["d/parent", "blog"]] }),
          fakeLookup({ "d/parent": parent }),
        )
      )?.nostr,
    ).toBe(PK_ALICE);
    expect(
      (
        await resolveValueWithImports(
          JSON.stringify({ import: [["d/parent", "missing"]] }),
          fakeLookup({ "d/parent": parent }),
        )
      )?.nostr,
    ).toBe(PK_ROOT);
  });

  it("rejects a trailing dot in the selector", async () => {
    const parent = { map: { blog: { nostr: PK_ALICE } } };
    const merged = await resolveValueWithImports(
      JSON.stringify({ import: [["d/parent", "blog."]] }),
      fakeLookup({ "d/parent": parent }),
    );
    expect(merged?.nostr).toBeUndefined();
  });
});

describe("resolveValueWithImports — chain depth + cycles", () => {
  it("supports the spec-mandated 4-deep chain", async () => {
    const records: Record<string, unknown> = {
      "d/l4": { nostr: PK_ROOT },
      "d/l3": { import: "d/l4" },
      "d/l2": { import: "d/l3" },
      "d/l1": { import: "d/l2" },
    };
    const merged = await resolveValueWithImports(
      JSON.stringify({ import: "d/l1" }),
      fakeLookup(records),
    );
    expect(merged?.nostr).toBe(PK_ROOT);
  });

  it("truncates chains deeper than the budget without throwing", async () => {
    const records: Record<string, unknown> = {
      "d/l5": { nostr: PK_ROOT },
      "d/l4": { import: "d/l5" },
      "d/l3": { import: "d/l4" },
      "d/l2": { import: "d/l3" },
      "d/l1": { import: "d/l2" },
    };
    // Budget 2 — l1 spends 1, l2 spends 1, l3 has 0 left so its import is dropped.
    const merged = await resolveValueWithImports(
      JSON.stringify({ import: "d/l1" }),
      fakeLookup(records),
      2,
    );
    // Result is finite, depth-limited, no throw.
    expect(merged?.nostr).toBeUndefined();
  });

  it("breaks cycles", async () => {
    const records: Record<string, unknown> = {
      "d/a": { import: "d/b" },
      "d/b": { import: "d/a", nostr: PK_ROOT },
    };
    const merged = await resolveValueWithImports(
      JSON.stringify({ import: "d/a" }),
      fakeLookup(records),
    );
    // d/a -> d/b -> d/a (visited, skipped). d/b still contributes nostr.
    expect(merged?.nostr).toBe(PK_ROOT);
  });

  it("absorbs failed sub-imports without nuking the importer", async () => {
    const child = { import: "d/missing", nostr: PK_ROOT };
    const merged = await resolveValueWithImports(
      JSON.stringify(child),
      async () => {
        throw new Error("transport boom");
      },
    );
    expect(merged?.nostr).toBe(PK_ROOT);
  });
});
