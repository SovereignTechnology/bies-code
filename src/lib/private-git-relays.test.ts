import type { ISigner } from "applesauce-signers";
import type { EventTemplate } from "nostr-tools";
import {
  finalizeEvent,
  generateSecretKey,
  getPublicKey,
  verifiedSymbol,
  verifyEvent,
} from "nostr-tools";
import { describe, expect, it } from "vitest";

import {
  createPrivateGitRelayListEvent,
  decodePrivateGitRelayListEvent,
  isStructurallyValidPrivateGitRelayListEvent,
  normalizePrivateGitRelayUrls,
  PRIVATE_GIT_RELAY_LIST_KIND,
  privateGitRelayListTimestampFloor,
  PrivateGitRelayListDecodeError,
} from "@/lib/private-git-relays";

function testIdentity(): {
  pubkey: string;
  signer: ISigner;
  sign: (template: EventTemplate) => ReturnType<typeof finalizeEvent>;
} {
  const key = generateSecretKey();
  const pubkey = getPublicKey(key);
  const sign = (template: EventTemplate) => finalizeEvent(template, key);
  return {
    pubkey,
    sign,
    signer: {
      getPublicKey: async () => pubkey,
      signEvent: async (template) => sign(template),
      nip44: {
        encrypt: async (_recipient, plaintext) => plaintext,
        decrypt: async (_sender, ciphertext) => ciphertext,
      },
    },
  };
}

describe("GRASP-08 private relay lists", () => {
  it("creates a tagless encrypted replacement and decodes normalized g items", async () => {
    const { pubkey, signer } = testIdentity();
    const event = await createPrivateGitRelayListEvent(pubkey, signer, [
      "wss://B.example/",
      "wss://a.example",
      "wss://a.example/",
    ]);

    expect(event.kind).toBe(PRIVATE_GIT_RELAY_LIST_KIND);
    expect(event.tags).toEqual([]);
    expect(JSON.parse(event.content)).toEqual([
      ["g", "wss://a.example"],
      ["g", "wss://b.example"],
    ]);
    await expect(
      decodePrivateGitRelayListEvent(event, pubkey, signer),
    ).resolves.toEqual(["wss://a.example", "wss://b.example"]);
  });

  it("rejects malformed items and unsafe relay URLs", async () => {
    const { pubkey, signer, sign } = testIdentity();
    const malformed = sign({
      kind: PRIVATE_GIT_RELAY_LIST_KIND,
      created_at: 10,
      tags: [],
      content: JSON.stringify([["r", "wss://private.example"]]),
    });

    await expect(
      decodePrivateGitRelayListEvent(malformed, pubkey, signer),
    ).rejects.toMatchObject({
      failure: "invalid",
    });
    expect(() =>
      normalizePrivateGitRelayUrls(["wss://user:secret@private.example/relay"]),
    ).toThrow(PrivateGitRelayListDecodeError);
  });

  it("rejects an invalid signature from projection and timestamp flooring", async () => {
    const { pubkey, signer, sign } = testIdentity();
    const valid = sign({
      kind: PRIVATE_GIT_RELAY_LIST_KIND,
      created_at: 1_700_000_000,
      tags: [],
      content: JSON.stringify([["g", "wss://private.example"]]),
    });
    const forged = {
      id: valid.id,
      pubkey: valid.pubkey,
      created_at: valid.created_at,
      kind: valid.kind,
      tags: valid.tags,
      content: valid.content,
      sig: "0".repeat(128),
    };
    Reflect.set(forged, verifiedSymbol, true);

    // Demonstrate the cached-verification hazard that the private-list
    // boundary must not trust.
    expect(verifyEvent(forged)).toBe(true);

    expect(isStructurallyValidPrivateGitRelayListEvent(valid, pubkey)).toBe(
      true,
    );
    expect(privateGitRelayListTimestampFloor(valid, pubkey)).toBe(
      valid.created_at,
    );
    expect(isStructurallyValidPrivateGitRelayListEvent(forged, pubkey)).toBe(
      false,
    );
    expect(privateGitRelayListTimestampFloor(forged, pubkey)).toBe(0);
    await expect(
      decodePrivateGitRelayListEvent(forged, pubkey, signer),
    ).rejects.toMatchObject({ failure: "invalid" });
  });
});
