import type { NostrEvent } from "nostr-tools";
import { describe, expect, it } from "vitest";

import { repoCoordinate, resolveChain } from "@/lib/nip34";

const owner = "a".repeat(64);
const invitee = "b".repeat(64);
const recursiveInvitee = "c".repeat(64);
const repoId = "maintainer-authorization";

function announcement(
  pubkey: string,
  maintainers: string[],
  createdAt = 1,
): NostrEvent {
  return {
    id: pubkey,
    pubkey,
    kind: 30617,
    created_at: createdAt,
    content: "",
    tags: [
      ["d", repoId],
      ["maintainers", ...maintainers],
    ],
    sig: "d".repeat(128),
  };
}

describe("directional maintainer authorization", () => {
  it("authorizes a listed maintainer before presenting them as confirmed", () => {
    const resolved = resolveChain(
      [announcement(owner, [invitee])],
      owner,
      repoId,
    );

    expect(resolved?.maintainerSet).toEqual([owner, invitee]);
    expect(resolved?.confirmedMaintainers).toEqual([owner]);
    expect(resolved?.requestedMaintainers).toEqual([invitee]);
    expect(resolved?.selectedCoordinate).toBe(repoCoordinate(owner, repoId));
    expect(resolved?.allCoordinates).toEqual([
      repoCoordinate(owner, repoId),
      repoCoordinate(invitee, repoId),
    ]);
  });

  it("marks the invitee confirmed only after their reciprocal announcement", () => {
    const resolved = resolveChain(
      [announcement(owner, [invitee]), announcement(invitee, [owner], 2)],
      owner,
      repoId,
    );

    expect(resolved?.maintainerSet).toEqual([owner, invitee]);
    expect(resolved?.confirmedMaintainers).toEqual([owner, invitee]);
    expect(resolved?.requestedMaintainers).toEqual([]);
  });

  it("keeps recursive invitations authorized but unconfirmed", () => {
    const resolved = resolveChain(
      [
        announcement(owner, [invitee]),
        announcement(invitee, [recursiveInvitee], 2),
      ],
      owner,
      repoId,
    );

    expect(resolved?.maintainerSet).toEqual([owner, invitee, recursiveInvitee]);
    expect(resolved?.confirmedMaintainers).toEqual([owner]);
    expect(new Set(resolved?.requestedMaintainers)).toEqual(
      new Set([invitee, recursiveInvitee]),
    );
  });

  it("orders the selected coordinate before confirmed and requested peers", () => {
    const confirmed = "d".repeat(64);
    const requested = "e".repeat(64);
    const resolved = resolveChain(
      [
        announcement(owner, [requested, confirmed]),
        announcement(confirmed, [owner], 2),
      ],
      owner,
      repoId,
    );

    expect(resolved?.allCoordinates).toEqual([
      repoCoordinate(owner, repoId),
      repoCoordinate(confirmed, repoId),
      repoCoordinate(requested, repoId),
    ]);
  });
});
