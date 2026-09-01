import type { ISigner } from "applesauce-signers";
import type { EventTemplate } from "nostr-tools";
import { finalizeEvent, generateSecretKey, getPublicKey } from "nostr-tools";
import { describe, expect, it } from "vitest";

import {
  createPrivateGitRelayListEvent,
  decodePrivateGitRelayListEvent,
  normalizePrivateGitRelayUrls,
  PRIVATE_GIT_RELAY_LIST_KIND,
  PrivateGitRelayListDecodeError,
  selectPrivateGitRelayList,
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

  it("skips an invalid newest event but honors deletion of a valid newest list", async () => {
    const { pubkey, signer, sign } = testIdentity();
    const older = sign({
      kind: PRIVATE_GIT_RELAY_LIST_KIND,
      created_at: 10,
      tags: [],
      content: JSON.stringify([["g", "wss://older.example"]]),
    });
    const malformed = sign({
      kind: PRIVATE_GIT_RELAY_LIST_KIND,
      created_at: 12,
      tags: [],
      content: "not-json",
    });
    const newest = sign({
      kind: PRIVATE_GIT_RELAY_LIST_KIND,
      created_at: 11,
      tags: [],
      content: JSON.stringify([["g", "wss://new.example"]]),
    });

    await expect(
      selectPrivateGitRelayList([older, malformed, newest], pubkey, signer),
    ).resolves.toMatchObject({
      event: { id: newest.id },
      relayUrls: ["wss://new.example"],
    });

    const deletion = sign({
      kind: 5,
      created_at: 13,
      tags: [["e", newest.id]],
      content: "",
    });
    await expect(
      selectPrivateGitRelayList([older, newest], pubkey, signer, {
        deletions: [deletion],
      }),
    ).resolves.toBeUndefined();
  });
});
