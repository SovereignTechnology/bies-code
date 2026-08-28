import type { NostrEvent } from "nostr-tools";
import { describe, expect, it } from "vitest";

import { repoCoordinate, resolveChain } from "@/lib/nip34";

const owner = "a".repeat(64);
const invitee = "b".repeat(64);
const recursiveInvitee = "c".repeat(64);
const moderator = "d".repeat(64);
const repoId = "maintainer-authorization";

function announcement(
  pubkey: string,
  tags: string[][],
  createdAt = 1,
  id = pubkey,
): NostrEvent {
  return {
    id,
    pubkey,
    kind: 30617,
    created_at: createdAt,
    content: "",
    tags: [["d", repoId], ...tags],
    sig: "e".repeat(128),
  };
}

function legacyAnnouncement(
  pubkey: string,
  maintainers: string[],
  createdAt = 1,
): NostrEvent {
  return announcement(pubkey, [["maintainers", ...maintainers]], createdAt);
}

describe("reciprocal maintainer authorization", () => {
  it("keeps a unilateral legacy listing outside every authority coordinate", () => {
    const resolved = resolveChain(
      [legacyAnnouncement(owner, [invitee])],
      owner,
      repoId,
    );

    expect(resolved?.confirmedMaintainers).toEqual([owner]);
    expect(resolved?.invitedMaintainers).toEqual([invitee]);
    expect(resolved?.confirmedMaintainerCoordinates).toEqual([
      repoCoordinate(owner, repoId),
    ]);
    expect(resolved?.confirmedMemberCoordinates).toEqual([
      repoCoordinate(owner, repoId),
    ]);
    expect(resolved?.discoveryPubkeys).toEqual([owner, invitee]);
  });

  it("confirms a legacy maintainer only after reciprocal acknowledgement", () => {
    const resolved = resolveChain(
      [
        legacyAnnouncement(owner, [invitee]),
        legacyAnnouncement(invitee, [owner], 2),
      ],
      owner,
      repoId,
    );

    expect(resolved?.confirmedMaintainers).toEqual([owner, invitee]);
    expect(resolved?.invitedMaintainers).toEqual([]);
  });

  it("does not let an unconfirmed invitation cycle bootstrap authority", () => {
    const resolved = resolveChain(
      [
        legacyAnnouncement(owner, [invitee]),
        legacyAnnouncement(invitee, [recursiveInvitee], 2),
        legacyAnnouncement(recursiveInvitee, [invitee], 3),
      ],
      owner,
      repoId,
    );

    expect(resolved?.confirmedMaintainers).toEqual([owner]);
    expect(new Set(resolved?.invitedMaintainers)).toEqual(
      new Set([invitee, recursiveInvitee]),
    );
  });

  it("uses indexed M/m roles instead of a contradictory legacy projection", () => {
    const resolved = resolveChain(
      [
        announcement(owner, [
          ["M", owner, "10"],
          ["m", invitee, "10"],
          ["maintainers", owner, recursiveInvitee],
        ]),
        announcement(
          invitee,
          [
            ["M", owner, "20"],
            ["m", invitee, "20"],
            ["maintainers", owner, invitee],
          ],
          2,
        ),
      ],
      owner,
      repoId,
    );

    expect(resolved?.confirmedMaintainers).toEqual([owner, invitee]);
    expect(resolved?.discoveryPubkeys).not.toContain(recursiveInvitee);
    expect(resolved?.repositoryHealth).toContainEqual(
      expect.objectContaining({
        code: "inconsistent-maintainers-projection",
        author: owner,
      }),
    );
  });

  it("treats ended and deferred self roles as departures", () => {
    const ownerEvent = announcement(owner, [
      ["M", owner, "10"],
      ["m", invitee, "10"],
      ["m", recursiveInvitee, "10"],
      ["maintainers", owner, invitee, recursiveInvitee],
    ]);
    const ended = announcement(invitee, [
      ["M", owner, "10"],
      ["m", invitee, "10", "20"],
      ["maintainers", owner],
    ]);
    const deferred = announcement(recursiveInvitee, [
      ["M", owner, "10"],
      ["m", recursiveInvitee, "10", "defer"],
      ["maintainers", owner],
    ]);

    const resolved = resolveChain([ownerEvent, ended, deferred], owner, repoId);

    expect(resolved?.confirmedMaintainers).toEqual([owner]);
    expect(resolved?.departedMaintainers).toEqual(
      expect.arrayContaining([invitee, recursiveInvitee]),
    );
  });

  it("authorizes confirmed moderators for member actions but not maintainer actions", () => {
    const resolved = resolveChain(
      [
        announcement(owner, [
          ["M", owner, "10"],
          ["o", moderator, "10"],
          ["maintainers", owner],
        ]),
        announcement(
          moderator,
          [
            ["M", owner, "20"],
            ["o", moderator, "20"],
            ["maintainers", owner],
          ],
          2,
        ),
      ],
      owner,
      repoId,
    );

    expect(resolved?.confirmedMaintainers).toEqual([owner]);
    expect(resolved?.confirmedModerators).toEqual([moderator]);
    expect(resolved?.confirmedMembers).toEqual([owner, moderator]);
    expect(resolved?.confirmedMaintainerCoordinates).toEqual([
      repoCoordinate(owner, repoId),
    ]);
    expect(resolved?.confirmedMemberCoordinates).toEqual([
      repoCoordinate(owner, repoId),
      repoCoordinate(moderator, repoId),
    ]);
  });

  it("uses the lowest event id when replacement timestamps tie", () => {
    const lowerId = "0".repeat(64);
    const higherId = "f".repeat(64);
    const resolved = resolveChain(
      [
        announcement(owner, [["maintainers", invitee]], 10, higherId),
        announcement(owner, [], 10, lowerId),
      ],
      owner,
      repoId,
    );

    expect(resolved?.confirmedMaintainers).toEqual([owner]);
    expect(resolved?.invitedMaintainers).toEqual([]);
    expect(resolved?.discoveredAnnouncements[0].id).toBe(lowerId);
  });
});
