import { describe, it, expect } from "vitest";
import {
  isNamecoinIdentifier,
  parseIdentifier,
} from "@/lib/namecoin/identifier";

describe("isNamecoinIdentifier", () => {
  it.each([
    ["d/example", true],
    ["id/alice", true],
    ["alice@example.bit", true],
    ["example.bit", true],
    ["nostr:d/example", true],
    ["nostr:alice@example.bit", true],
    ["NOSTR:D/Example", true],
    ["", false],
    ["alice@example.com", false],
    ["d/", false],
    ["id/", false],
    [".bit", false],
    ["npub1abc", false],
    [undefined, false],
    [null, false],
  ])("isNamecoinIdentifier(%j) === %s", (input, expected) => {
    expect(isNamecoinIdentifier(input as string | null | undefined)).toBe(
      expected,
    );
  });
});

describe("parseIdentifier", () => {
  it("parses d/<name> as domain root", () => {
    expect(parseIdentifier("d/example")).toEqual({
      namecoinName: "d/example",
      localPart: "_",
      isDomain: true,
    });
  });

  it("parses id/<name> as identity root", () => {
    expect(parseIdentifier("id/alice")).toEqual({
      namecoinName: "id/alice",
      localPart: "_",
      isDomain: false,
    });
  });

  it("parses user@domain.bit", () => {
    expect(parseIdentifier("alice@example.bit")).toEqual({
      namecoinName: "d/example",
      localPart: "alice",
      isDomain: true,
    });
  });

  it("parses bare domain.bit as root", () => {
    expect(parseIdentifier("example.bit")).toEqual({
      namecoinName: "d/example",
      localPart: "_",
      isDomain: true,
    });
  });

  it("tolerates a nostr: prefix on every shape", () => {
    expect(parseIdentifier("nostr:d/example")?.namecoinName).toBe("d/example");
    expect(parseIdentifier("nostr:alice@example.bit")?.localPart).toBe("alice");
    expect(parseIdentifier("nostr:example.bit")?.localPart).toBe("_");
  });

  it("lowercases case-insensitive forms", () => {
    expect(parseIdentifier("Alice@Example.Bit")).toEqual({
      namecoinName: "d/example",
      localPart: "alice",
      isDomain: true,
    });
    expect(parseIdentifier("ID/Alice")).toEqual({
      namecoinName: "id/alice",
      localPart: "_",
      isDomain: false,
    });
  });

  it("treats empty local part as root underscore", () => {
    expect(parseIdentifier("@example.bit")).toEqual({
      namecoinName: "d/example",
      localPart: "_",
      isDomain: true,
    });
  });

  it.each(["", "d/", "id/", "alice@.bit", "@.bit", "alice@example.com"])(
    "rejects %j",
    (input) => {
      expect(parseIdentifier(input)).toBeNull();
    },
  );
});
