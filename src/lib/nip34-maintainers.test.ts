import type { NostrEvent } from "nostr-tools";
import { describe, expect, it } from "vitest";

import {
  buildRepositoryComponentIndex,
  getRepositoryComponentForCoordinate,
  repoCoordinate,
  resolveChain,
  selectRepositoryComponents,
} from "@/lib/nip34";
import {
  isHistoricalRepositoryMember,
  repositoryRoleStateAt,
} from "@/lib/nip34-maintainer-model";
import {
  prepareRepositoryMembershipMutation,
  RepositoryMembershipMutationRefusal,
} from "@/lib/repositoryMembershipMutation";

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
    expect(resolved?.invitedMaintainers).toEqual([invitee]);
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

  it("deduplicates active role targets like ngit without discarding authority", () => {
    const resolved = resolveChain(
      [
        announcement(owner, [
          ["M", invitee, "10"],
          ["M", invitee, "10"],
          ["m", owner, "10"],
          ["maintainers", owner, invitee],
        ]),
        announcement(
          invitee,
          [
            ["M", invitee, "20"],
            ["m", owner, "20"],
            ["maintainers", owner, invitee],
          ],
          2,
        ),
      ],
      owner,
      repoId,
    );

    expect(new Set(resolved?.confirmedMaintainers)).toEqual(
      new Set([owner, invitee]),
    );
    expect(resolved?.leadResolution).toEqual({
      leadMaintainer: invitee,
      source: "explicit",
      path: [owner, invitee],
    });
    expect(resolved?.repositoryHealth).toContainEqual(
      expect.objectContaining({
        code: "duplicate-role-record",
        author: owner,
        role: "M",
        subject: invitee,
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

describe("repository component indexing", () => {
  it("keeps unrelated same-identifier repositories separate across invitation edges", () => {
    const ownerEvent = legacyAnnouncement(owner, [invitee, recursiveInvitee]);
    const inviteeEvent = legacyAnnouncement(invitee, [owner], 2);
    const unrelatedEvent = announcement(recursiveInvitee, [], 3);

    const forward = buildRepositoryComponentIndex([
      ownerEvent,
      inviteeEvent,
      unrelatedEvent,
    ]);
    const reverse = buildRepositoryComponentIndex([
      unrelatedEvent,
      inviteeEvent,
      ownerEvent,
    ]);

    expect(forward.components.map(({ componentId }) => componentId)).toEqual(
      reverse.components.map(({ componentId }) => componentId),
    );
    expect(forward.components).toHaveLength(2);
    const joined = getRepositoryComponentForCoordinate(forward, owner, repoId);
    const reciprocal = getRepositoryComponentForCoordinate(
      forward,
      invitee,
      repoId,
    );
    const unrelated = getRepositoryComponentForCoordinate(
      forward,
      recursiveInvitee,
      repoId,
    );
    expect(reciprocal?.componentId).toBe(joined?.componentId);
    expect(unrelated?.componentId).not.toBe(joined?.componentId);
    expect(joined?.invitedMaintainers).toContain(recursiveInvitee);

    const selected = selectRepositoryComponents(
      [ownerEvent, inviteeEvent, unrelatedEvent],
      [
        repoCoordinate(invitee, repoId),
        repoCoordinate(owner, repoId),
        repoCoordinate(recursiveInvitee, repoId),
      ],
    );
    expect(selected.map(({ componentId }) => componentId)).toEqual([
      joined?.componentId,
      unrelated?.componentId,
    ]);
  });

  it("takes ordinary metadata from one latest member while unioning infrastructure and privacy", () => {
    const ownerEvent = announcement(
      owner,
      [
        ["M", owner],
        ["m", invitee],
        ["maintainers", owner, invitee],
        ["name", "Old name"],
        ["description", "Old description"],
        ["web", "https://old.example"],
        ["t", "old-label"],
        ["clone", "https://git.old.example/repo.git"],
        ["relays", "wss://relay.old.example"],
        ["blossoms", "https://blossom.old.example"],
        ["private", "true"],
      ],
      10,
    );
    const inviteeEvent = announcement(
      invitee,
      [
        ["M", owner],
        ["m", invitee],
        ["maintainers", owner, invitee],
        ["name", "Current name"],
        ["description", "Current description"],
        ["web", "https://current.example"],
        ["u", `30617:${recursiveInvitee}:upstream`],
        ["t", "current-label"],
        ["clone", "https://git.current.example/repo.git"],
        ["relays", "wss://relay.current.example"],
        ["blossoms", "https://blossom.current.example"],
      ],
      20,
    );

    const resolved = resolveChain([inviteeEvent, ownerEvent], owner, repoId);

    expect(resolved).toMatchObject({
      name: "Current name",
      description: "Current description",
      webUrls: ["https://current.example"],
      labels: ["current-label"],
      isPrivate: true,
    });
    expect(resolved?.upstreams).toEqual([
      { repository: `30617:${recursiveInvitee}:upstream` },
    ]);
    expect(new Set(resolved?.cloneUrls)).toEqual(
      new Set([
        "https://git.old.example/repo.git",
        "https://git.current.example/repo.git",
      ]),
    );
    expect(new Set(resolved?.relays)).toEqual(
      new Set(["wss://relay.old.example", "wss://relay.current.example"]),
    );
    expect(new Set(resolved?.blossomUrls)).toEqual(
      new Set([
        "https://blossom.old.example/",
        "https://blossom.current.example/",
      ]),
    );
  });

  it("assigns one moderator announcement to only one active component", () => {
    const first = announcement(owner, [
      ["M", owner],
      ["o", moderator],
      ["maintainers", owner],
    ]);
    const second = announcement(recursiveInvitee, [
      ["M", recursiveInvitee],
      ["o", moderator],
      ["maintainers", recursiveInvitee],
    ]);
    const acknowledgement = announcement(moderator, [
      ["M", owner],
      ["m", recursiveInvitee],
      ["o", moderator],
      ["maintainers", owner, recursiveInvitee],
    ]);
    const index = buildRepositoryComponentIndex([
      second,
      acknowledgement,
      first,
    ]);

    const owningComponents = index.components.filter(({ confirmedMembers }) =>
      confirmedMembers.includes(moderator),
    );
    expect(owningComponents).toHaveLength(1);
    expect(
      getRepositoryComponentForCoordinate(index, moderator, repoId)
        ?.componentId,
    ).toBe(owningComponents[0].componentId);
  });
});

describe("replicated role history and exits", () => {
  it("treats reciprocal untimed legacy membership as active from zero", () => {
    const resolved = resolveChain(
      [
        legacyAnnouncement(owner, [invitee], 10),
        legacyAnnouncement(invitee, [owner], 20),
      ],
      owner,
      repoId,
    );

    expect(resolved?.confirmedMaintainers).toEqual([owner, invitee]);
    expect(
      isHistoricalRepositoryMember(resolved?.roleHistory, invitee, 0),
    ).toBe(true);
    expect(
      isHistoricalRepositoryMember(resolved?.roleHistory, invitee, 20),
    ).toBe(true);
    expect(
      isHistoricalRepositoryMember(resolved?.roleHistory, invitee, 21),
    ).toBe(true);
    const ownerSelfRole = resolved?.roleHistory.authorHistories
      .find(({ author }) => author === owner)
      ?.records.find(({ subject }) => subject === owner);
    expect(ownerSelfRole && repositoryRoleStateAt(ownerSelfRole, 1)).toBe(
      "active",
    );
  });

  it("authorizes accepted maintainers only from their signed acceptance boundary", () => {
    const resolved = resolveChain(
      [
        announcement(owner, [
          ["M", owner, "10"],
          ["m", invitee, "20"],
          ["maintainers", owner, invitee],
        ]),
        announcement(
          invitee,
          [
            ["M", owner, "20"],
            ["m", invitee, "20"],
            ["maintainers", owner, invitee],
          ],
          20,
        ),
      ],
      owner,
      repoId,
    );

    expect(
      isHistoricalRepositoryMember(resolved?.roleHistory, invitee, 19),
    ).toBe(false);
    expect(
      isHistoricalRepositoryMember(resolved?.roleHistory, invitee, 20),
    ).toBe(true);
  });

  it("keeps past actions authorized after a signed self-role exit", () => {
    const resolved = resolveChain(
      [
        announcement(owner, [
          ["M", owner, "10"],
          ["m", invitee, "20"],
          ["maintainers", owner, invitee],
        ]),
        announcement(
          invitee,
          [
            ["M", owner, "20"],
            ["m", invitee, "20", "35"],
            ["maintainers", owner],
          ],
          40,
        ),
      ],
      owner,
      repoId,
    );

    expect(resolved?.confirmedMaintainers).toEqual([owner]);
    expect(
      isHistoricalRepositoryMember(resolved?.roleHistory, invitee, 30),
    ).toBe(true);
    expect(
      isHistoricalRepositoryMember(resolved?.roleHistory, invitee, 36),
    ).toBe(false);
  });

  it("loads a former maintainer's history after every current edge ends", () => {
    const resolved = resolveChain(
      [
        announcement(owner, [
          ["M", owner, "10"],
          ["m", invitee, "20", "35"],
          ["maintainers", owner],
        ]),
        announcement(
          invitee,
          [
            ["M", owner, "20", "35"],
            ["m", invitee, "20", "35"],
            ["maintainers"],
          ],
          40,
        ),
      ],
      owner,
      repoId,
    );

    expect(resolved?.discoveryPubkeys).not.toContain(invitee);
    expect(resolved?.historyPubkeys).toContain(invitee);
    expect(
      isHistoricalRepositoryMember(resolved?.roleHistory, invitee, 30),
    ).toBe(true);
    expect(
      isHistoricalRepositoryMember(resolved?.roleHistory, invitee, 36),
    ).toBe(false);
  });

  it("uses an older root before today's selected coordinate joined", () => {
    const resolved = resolveChain(
      [
        announcement(owner, [
          ["M", owner, "10"],
          ["m", invitee, "20"],
          ["maintainers", owner, invitee],
        ]),
        announcement(
          invitee,
          [
            ["M", owner, "20"],
            ["m", invitee, "20"],
            ["maintainers", owner, invitee],
          ],
          20,
        ),
      ],
      invitee,
      repoId,
    );

    expect(isHistoricalRepositoryMember(resolved?.roleHistory, owner, 15)).toBe(
      true,
    );
    expect(
      isHistoricalRepositoryMember(resolved?.roleHistory, invitee, 15),
    ).toBe(false);
    expect(
      isHistoricalRepositoryMember(resolved?.roleHistory, invitee, 20),
    ).toBe(true);
  });

  it("requires a new self-role interval to accept a reopened invitation", () => {
    const ownerEvent = announcement(owner, [
      ["M", owner, "10"],
      ["m", invitee, "20", "35", "45"],
      ["maintainers", owner, invitee],
    ]);
    const staleAcceptance = announcement(
      invitee,
      [
        ["M", owner, "20"],
        ["m", invitee, "20", "35"],
        ["maintainers", owner],
      ],
      46,
    );
    const pending = resolveChain([ownerEvent, staleAcceptance], owner, repoId);

    expect(pending?.confirmedMaintainers).toEqual([owner]);
    expect(pending?.invitedMaintainers).toContain(invitee);

    const freshAcceptance = announcement(
      invitee,
      [
        ["M", owner, "20"],
        ["m", invitee, "20", "35", "50"],
        ["maintainers", owner, invitee],
      ],
      50,
    );
    const accepted = resolveChain([ownerEvent, freshAcceptance], owner, repoId);
    expect(accepted?.confirmedMaintainers).toEqual([owner, invitee]);
    expect(
      isHistoricalRepositoryMember(accepted?.roleHistory, invitee, 46),
    ).toBe(false);
    expect(
      isHistoricalRepositoryMember(accepted?.roleHistory, invitee, 50),
    ).toBe(true);
  });

  it("fails closed for a deferred open-ended historical interval", () => {
    expect(repositoryRoleStateAt({ boundaries: [20, "defer"] }, 30)).toBe(
      "unknown",
    );
    expect(repositoryRoleStateAt({ boundaries: [20, 35] }, 30)).toBe("active");
    expect(repositoryRoleStateAt({ boundaries: [20, 35] }, 35)).toBe(
      "inactive",
    );
  });

  it("marks a same-coordinate self-led restart as unsupported", () => {
    const resolved = resolveChain(
      [
        announcement(owner, [["M", owner, "10"]]),
        announcement(
          invitee,
          [
            ["M", owner, "20", "40"],
            ["m", invitee, "20", "40"],
            ["M", invitee, "50"],
            ["maintainers", invitee],
          ],
          50,
        ),
      ],
      invitee,
      repoId,
    );

    expect(resolved?.coordinateStatus).toBe("unsupported_restart");
  });
});

describe("conservative repository membership mutations", () => {
  it("preflights add, accept, remove, and leave as one-person effects", () => {
    const sole = resolveChain([announcement(owner, [])], owner, repoId)!;
    const add = prepareRepositoryMembershipMutation({
      repo: sole,
      actorPubkey: owner,
      intent: { type: "add", targetPubkey: invitee },
      announcements: sole.historicalAnnouncements,
      stateEvents: [],
      createdAt: 10,
    });
    const ownerInvitation = announcement(
      owner,
      add.template.tags,
      11,
      "1".repeat(64),
    );
    const invited = resolveChain([ownerInvitation], owner, repoId)!;
    expect(invited.invitedMaintainers).toEqual([invitee]);

    const accept = prepareRepositoryMembershipMutation({
      repo: invited,
      actorPubkey: invitee,
      intent: { type: "accept" },
      announcements: [ownerInvitation],
      stateEvents: [],
      createdAt: 20,
    });
    const inviteeAcceptance = announcement(
      invitee,
      accept.template.tags,
      20,
      "2".repeat(64),
    );
    const accepted = resolveChain(
      [ownerInvitation, inviteeAcceptance],
      owner,
      repoId,
    )!;
    expect(new Set(accepted.confirmedMaintainers)).toEqual(
      new Set([owner, invitee]),
    );

    const remove = prepareRepositoryMembershipMutation({
      repo: accepted,
      actorPubkey: owner,
      intent: { type: "remove", targetPubkey: invitee },
      announcements: [ownerInvitation, inviteeAcceptance],
      stateEvents: [],
      createdAt: 30,
    });
    expect(remove.expectedMaintainers).toEqual([owner]);

    const inviteeRooted = resolveChain(
      [ownerInvitation, inviteeAcceptance],
      invitee,
      repoId,
    )!;
    const leave = prepareRepositoryMembershipMutation({
      repo: inviteeRooted,
      actorPubkey: invitee,
      intent: { type: "leave" },
      announcements: [ownerInvitation, inviteeAcceptance],
      stateEvents: [],
      createdAt: 30,
    });
    expect(leave.expectedMaintainers).toEqual([owner]);
  });

  it("refuses acceptance when the invitee already has repository state", () => {
    const ownerInvitation = announcement(owner, [
      ["M", owner, "10"],
      ["m", invitee, "10"],
      ["maintainers", owner, invitee],
    ]);
    const invited = resolveChain([ownerInvitation], owner, repoId)!;
    const inviteeState: NostrEvent = {
      ...announcement(invitee, [], 15, "3".repeat(64)),
      kind: 30618,
    };

    expect(() =>
      prepareRepositoryMembershipMutation({
        repo: invited,
        actorPubkey: invitee,
        intent: { type: "accept" },
        announcements: [ownerInvitation],
        stateEvents: [inviteeState],
        createdAt: 20,
      }),
    ).toThrowError(
      expect.objectContaining<Partial<RepositoryMembershipMutationRefusal>>({
        code: "unsupported_existing_state",
      }),
    );
  });
});
