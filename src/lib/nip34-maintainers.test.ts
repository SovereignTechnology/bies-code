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
  hasUnsupportedAcceptanceRoleHistory,
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

  it("treats numeric self-role ends as departures but keeps self-defer repairable", () => {
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
    expect(resolved?.departedMaintainers).toEqual([invitee]);
    expect(resolved?.invitedMaintainers).toContain(recursiveInvitee);
    expect(resolved?.repositoryHealth).toContainEqual(
      expect.objectContaining({
        code: "invalid-self-defer",
        author: recursiveInvitee,
        role: "m",
        selfDefer: expect.objectContaining({
          lastValidStart: 10,
          superseded: false,
        }),
      }),
    );
  });

  it("treats a valid self-moderator-only role as a maintainer departure", () => {
    const ownerEvent = announcement(owner, [
      ["M", owner, "10"],
      ["m", invitee, "10"],
      ["maintainers", owner, invitee],
    ]);
    const moderatorOnly = announcement(invitee, [
      ["M", owner, "20"],
      ["o", invitee, "20"],
      ["maintainers", owner],
    ]);

    const resolved = resolveChain([ownerEvent, moderatorOnly], owner, repoId);

    expect(resolved?.confirmedMaintainers).toEqual([owner]);
    expect(resolved?.departedMaintainers).toContain(invitee);
    expect(resolved?.invitedMaintainers).not.toContain(invitee);
  });

  it("does not turn an invalid self-moderator defer into a maintainer departure or acceptance", () => {
    const ownerEvent = announcement(owner, [
      ["M", owner, "10"],
      ["m", invitee, "10"],
      ["maintainers", owner, invitee],
    ]);
    const invalidModerator = announcement(invitee, [
      ["M", owner, "20"],
      ["o", invitee, "20", "defer"],
      ["maintainers", owner],
    ]);

    const resolved = resolveChain(
      [ownerEvent, invalidModerator],
      owner,
      repoId,
    );

    expect(resolved?.confirmedMaintainers).toEqual([owner]);
    expect(resolved?.departedMaintainers).not.toContain(invitee);
    expect(resolved?.invitedMaintainers).toContain(invitee);
    expect(resolved?.repositoryHealth).toContainEqual(
      expect.objectContaining({
        code: "invalid-self-defer",
        author: invitee,
        role: "o",
      }),
    );
  });

  it("uses a strictly later signed self-role without repairing invalid history", () => {
    const resolved = resolveChain(
      [
        announcement(
          owner,
          [
            ["m", owner, "0", "100", "120", "defer"],
            ["M", owner, "200"],
            ["maintainers", owner],
          ],
          220,
        ),
      ],
      owner,
      repoId,
    );

    expect(resolved?.confirmedMaintainers).toEqual([owner]);
    expect(resolved?.coordinateStatus).toBe("active");
    expect(resolved?.repositoryHealth).toContainEqual(
      expect.objectContaining({
        code: "invalid-self-defer",
        author: owner,
        role: "m",
        selfDefer: {
          lastValidStart: 120,
          hasPriorIntervals: true,
          superseded: true,
          proposedEnd: 200,
          successorRole: "M",
        },
      }),
    );
    expect(
      resolved?.roleHistory.resolvedRecords.some(
        ({ role, subject }) => role === "m" && subject === owner,
      ),
    ).toBe(false);
    expect(
      isHistoricalRepositoryMember(resolved?.roleHistory, owner, 150),
    ).toBe(false);
    expect(
      isHistoricalRepositoryMember(resolved?.roleHistory, owner, 200),
    ).toBe(true);
  });

  it("lets a later signed self-role supersede across maintainer and moderator roles", () => {
    const promotedMaintainer = resolveChain(
      [
        announcement(
          owner,
          [
            ["o", owner, "10", "defer"],
            ["M", owner, "20"],
            ["maintainers", owner],
          ],
          30,
        ),
      ],
      owner,
      repoId,
    );
    expect(promotedMaintainer?.confirmedMaintainers).toEqual([owner]);
    expect(promotedMaintainer?.confirmedModerators).toEqual([]);
    expect(promotedMaintainer?.repositoryHealth).toContainEqual(
      expect.objectContaining({
        role: "o",
        selfDefer: {
          lastValidStart: 10,
          hasPriorIntervals: false,
          superseded: true,
          proposedEnd: 20,
          successorRole: "M",
        },
      }),
    );

    const ownerEvent = announcement(owner, [
      ["M", owner, "5"],
      ["o", moderator, "5"],
      ["maintainers", owner],
    ]);
    const promotedModerator = resolveChain(
      [
        ownerEvent,
        announcement(
          moderator,
          [
            ["M", owner, "5"],
            ["m", moderator, "10", "defer"],
            ["o", moderator, "20"],
            ["maintainers", owner],
          ],
          30,
        ),
      ],
      owner,
      repoId,
    );
    expect(promotedModerator?.confirmedMaintainers).toEqual([owner]);
    expect(promotedModerator?.confirmedModerators).toEqual([moderator]);
    expect(promotedModerator?.repositoryHealth).toContainEqual(
      expect.objectContaining({
        role: "m",
        selfDefer: {
          lastValidStart: 10,
          hasPriorIntervals: false,
          superseded: true,
          proposedEnd: 20,
          successorRole: "o",
        },
      }),
    );
  });

  it("does not let an older cross-role survive a newer invalid self-defer", () => {
    const blockedMaintainer = resolveChain(
      [
        announcement(owner, [
          ["M", owner, "5"],
          ["o", owner, "10", "defer"],
          ["maintainers", owner],
        ]),
      ],
      owner,
      repoId,
    );
    expect(blockedMaintainer?.confirmedMaintainers).toEqual([]);
    expect(blockedMaintainer?.repositoryHealth).toContainEqual(
      expect.objectContaining({
        role: "o",
        selfDefer: expect.objectContaining({ superseded: false }),
      }),
    );

    const ownerEvent = announcement(owner, [
      ["M", owner, "5"],
      ["o", moderator, "5"],
      ["maintainers", owner],
    ]);
    const blockedModerator = resolveChain(
      [
        ownerEvent,
        announcement(moderator, [
          ["M", owner, "5"],
          ["o", moderator, "5"],
          ["m", moderator, "10", "defer"],
          ["maintainers", owner],
        ]),
      ],
      owner,
      repoId,
    );
    expect(blockedModerator?.confirmedMaintainers).toEqual([owner]);
    expect(blockedModerator?.confirmedModerators).toEqual([]);
    expect(blockedModerator?.repositoryHealth).toContainEqual(
      expect.objectContaining({
        role: "m",
        selfDefer: expect.objectContaining({ superseded: false }),
      }),
    );
  });

  it.each([
    {
      label: "the same boundary",
      successors: [
        ["M", owner, "20"],
        ["o", owner, "20"],
      ],
    },
    {
      label: "different boundaries",
      successors: [
        ["M", owner, "20"],
        ["o", owner, "30"],
      ],
    },
  ])(
    "does not infer a repair boundary from multiple successors at $label",
    ({ successors }) => {
      const resolved = resolveChain(
        [
          announcement(owner, [
            ["m", owner, "10", "defer"],
            ...successors,
            ["maintainers", owner],
          ]),
        ],
        owner,
        repoId,
      );
      const warning = resolved?.repositoryHealth.find(
        ({ code }) => code === "invalid-self-defer",
      );

      expect(resolved?.confirmedMaintainers).toEqual([owner]);
      expect(warning?.selfDefer).toEqual({
        lastValidStart: 10,
        hasPriorIntervals: false,
        superseded: true,
        proposedEnd: undefined,
        successorRole: undefined,
      });
    },
  );

  it("resolves multiple invalid self-defer records independently without proposing a repair", () => {
    const resolved = resolveChain(
      [
        announcement(owner, [
          ["m", owner, "10", "defer"],
          ["m", owner, "25", "defer"],
          ["M", owner, "20"],
          ["maintainers", owner],
        ]),
      ],
      owner,
      repoId,
    );
    const warnings = resolved?.repositoryHealth.filter(
      ({ code }) => code === "invalid-self-defer",
    );

    expect(resolved?.confirmedMaintainers).toEqual([]);
    expect(warnings?.map(({ selfDefer }) => selfDefer)).toEqual([
      {
        lastValidStart: 10,
        hasPriorIntervals: false,
        superseded: true,
        proposedEnd: undefined,
        successorRole: undefined,
      },
      {
        lastValidStart: 25,
        hasPriorIntervals: false,
        superseded: false,
        proposedEnd: undefined,
        successorRole: undefined,
      },
    ]);
  });

  it("keeps same-role invalid self-defer warnings distinct across the component dedup", () => {
    const resolved = resolveChain(
      [
        announcement(
          owner,
          [
            ["m", owner, "10", "defer"],
            ["m", owner, "25", "defer"],
            ["M", owner, "30"],
            ["maintainers", owner],
          ],
          40,
        ),
      ],
      owner,
      repoId,
    );
    const warnings = resolved?.repositoryHealth.filter(
      ({ code }) => code === "invalid-self-defer",
    );

    expect(resolved?.confirmedMaintainers).toEqual([owner]);
    expect(warnings?.map(({ selfDefer }) => selfDefer?.lastValidStart)).toEqual(
      [10, 25],
    );
  });

  it.each([
    { label: "untimed", successor: ["M", owner] },
    { label: "older", successor: ["M", owner, "5"] },
    { label: "equal-start", successor: ["M", owner, "10"] },
  ])(
    "does not let an $label apparent successor restore current authority",
    ({ successor }) => {
      const resolved = resolveChain(
        [
          announcement(owner, [
            ["m", owner, "10", "defer"],
            successor,
            ["maintainers", owner],
          ]),
        ],
        owner,
        repoId,
      );

      expect(resolved?.confirmedMaintainers).toEqual([]);
      expect(resolved?.coordinateStatus).toBe("unresolved");
      expect(resolved?.repositoryHealth).toContainEqual(
        expect.objectContaining({
          code: "invalid-self-defer",
          selfDefer: expect.objectContaining({
            lastValidStart: 10,
            superseded: false,
          }),
        }),
      );
    },
  );

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

  it("retains a same-coordinate self-led restart as visible history", () => {
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

    expect(resolved?.coordinateStatus).toBe("restarted");
    expect(resolved?.coordinateStatusChangedAt).toBe(50);
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

  it("does not make another author's invalid self-defer contagious", () => {
    const ownerEvent = announcement(owner, [
      ["M", owner, "10"],
      ["m", invitee, "10"],
      ["maintainers", owner, invitee],
    ]);
    const invalidInvitee = announcement(invitee, [
      ["M", owner, "20"],
      ["m", invitee, "20", "defer"],
      ["maintainers", owner],
    ]);
    const resolved = resolveChain([ownerEvent, invalidInvitee], owner, repoId)!;

    const proposal = prepareRepositoryMembershipMutation({
      repo: resolved,
      actorPubkey: owner,
      intent: { type: "add", targetPubkey: recursiveInvitee },
      announcements: [ownerEvent, invalidInvitee],
      stateEvents: [],
      createdAt: 30,
    });

    expect(proposal.expectedInvitations).toEqual(
      expect.arrayContaining([invitee, recursiveInvitee]),
    );
  });

  it("preserves a superseded self-defer during an unrelated membership edit", () => {
    const invalidTag = ["m", owner, "0", "10", "15", "defer"];
    const ownerEvent = announcement(owner, [
      invalidTag,
      ["M", owner, "20"],
      ["maintainers", owner],
    ]);
    const resolved = resolveChain([ownerEvent], owner, repoId)!;

    const proposal = prepareRepositoryMembershipMutation({
      repo: resolved,
      actorPubkey: owner,
      intent: { type: "add", targetPubkey: invitee },
      announcements: [ownerEvent],
      stateEvents: [],
      createdAt: 30,
    });

    expect(proposal.template.tags).toContainEqual(invalidTag);
    expect(proposal.expectedMaintainers).toEqual([owner]);
    expect(proposal.expectedInvitations).toEqual([invitee]);
  });

  it("repairs a self-defer at its unambiguous signed successor boundary", () => {
    const ownerEvent = announcement(owner, [
      ["m", owner, "0", "10", "15", "defer"],
      ["M", owner, "20"],
      ["maintainers", owner],
    ]);
    const resolved = resolveChain([ownerEvent], owner, repoId)!;

    const proposal = prepareRepositoryMembershipMutation({
      repo: resolved,
      actorPubkey: owner,
      intent: {
        type: "repair-self-defer",
        role: "m",
        repair: { action: "end", boundary: 20 },
      },
      announcements: [ownerEvent],
      stateEvents: [],
      createdAt: 30,
    });

    expect(proposal.template.tags).toContainEqual([
      "m",
      owner,
      "0",
      "10",
      "15",
      "20",
    ]);
    expect(proposal.template.tags).toContainEqual(["M", owner, "20"]);
    expect(proposal.expectedMaintainers).toEqual([owner]);
  });

  it("refuses to repair a private announcement without a relay hint", () => {
    const ownerEvent = announcement(owner, [
      ["M", owner, "10", "defer"],
      ["maintainers"],
      ["private", "true"],
    ]);
    const resolved = resolveChain([ownerEvent], owner, repoId)!;

    expect(resolved.isPrivate).toBe(true);
    expect(() =>
      prepareRepositoryMembershipMutation({
        repo: resolved,
        actorPubkey: owner,
        intent: {
          type: "repair-self-defer",
          role: "M",
          repair: { action: "continue" },
        },
        announcements: [ownerEvent],
        stateEvents: [],
        createdAt: 20,
      }),
    ).toThrowError(
      expect.objectContaining<Partial<RepositoryMembershipMutationRefusal>>({
        code: "missing_private_relay_hint",
      }),
    );
  });

  it("lets the signer explicitly continue an ambiguous self-defer", () => {
    const ownerEvent = announcement(owner, [
      ["M", owner, "10", "defer"],
      ["maintainers"],
    ]);
    const resolved = resolveChain([ownerEvent], owner, repoId)!;

    const proposal = prepareRepositoryMembershipMutation({
      repo: resolved,
      actorPubkey: owner,
      intent: {
        type: "repair-self-defer",
        role: "M",
        repair: { action: "continue" },
      },
      announcements: [ownerEvent],
      stateEvents: [],
      createdAt: 20,
    });

    expect(proposal.template.tags).toContainEqual(["M", owner, "10"]);
    expect(proposal.expectedMaintainers).toEqual([owner]);
  });

  it("validates self-defer repairs against the effective replacement timestamp", () => {
    const futureAnnouncement = announcement(
      owner,
      [["M", owner, "90", "defer"], ["maintainers"]],
      100,
    );
    const resolved = resolveChain([futureAnnouncement], owner, repoId)!;
    const proposal = prepareRepositoryMembershipMutation({
      repo: resolved,
      actorPubkey: owner,
      intent: {
        type: "repair-self-defer",
        role: "M",
        repair: { action: "end", boundary: 95 },
      },
      announcements: [futureAnnouncement],
      stateEvents: [],
      createdAt: 50,
    });

    expect(proposal.template.created_at).toBe(101);
    expect(proposal.template.tags).toContainEqual(["M", owner, "90", "95"]);
    expect(() =>
      prepareRepositoryMembershipMutation({
        repo: resolved,
        actorPubkey: owner,
        intent: {
          type: "repair-self-defer",
          role: "M",
          repair: { action: "end", boundary: 102 },
        },
        announcements: [futureAnnouncement],
        stateEvents: [],
        createdAt: 50,
      }),
    ).toThrowError(
      expect.objectContaining<Partial<RepositoryMembershipMutationRefusal>>({
        code: "history_conflict",
      }),
    );
  });

  it("refuses to repair a self-defer whose start is later than its replacement", () => {
    const futureStart = announcement(
      owner,
      [["M", owner, "50", "defer"], ["maintainers"]],
      20,
    );
    const resolved = resolveChain([futureStart], owner, repoId)!;

    for (const repair of [
      { action: "continue" as const },
      { action: "end" as const, boundary: 50 },
    ]) {
      expect(() =>
        prepareRepositoryMembershipMutation({
          repo: resolved,
          actorPubkey: owner,
          intent: { type: "repair-self-defer", role: "M", repair },
          announcements: [futureStart],
          stateEvents: [],
          createdAt: 30,
        }),
      ).toThrowError(
        expect.objectContaining<Partial<RepositoryMembershipMutationRefusal>>({
          code: "history_conflict",
        }),
      );
    }
  });

  it("gates an unrelated write only for the unresolved self-defer author", () => {
    const ownerEvent = announcement(owner, [
      ["M", owner, "10", "defer"],
      ["maintainers"],
    ]);
    const resolved = resolveChain([ownerEvent], owner, repoId)!;

    expect(() =>
      prepareRepositoryMembershipMutation({
        repo: resolved,
        actorPubkey: owner,
        intent: { type: "leave" },
        announcements: [ownerEvent],
        stateEvents: [],
        createdAt: 20,
      }),
    ).toThrowError(
      expect.objectContaining<Partial<RepositoryMembershipMutationRefusal>>({
        code: "history_conflict",
      }),
    );
  });

  it("repairs self-defer while accepting a new maintainer role", () => {
    const ownerInvitation = announcement(owner, [
      ["M", owner, "10"],
      ["m", invitee, "10"],
      ["maintainers", owner, invitee],
    ]);
    const invalidAcceptance = announcement(
      invitee,
      [
        ["M", owner, "20"],
        ["m", invitee, "20", "defer"],
        ["maintainers", owner],
      ],
      25,
    );
    const invited = resolveChain(
      [ownerInvitation, invalidAcceptance],
      owner,
      repoId,
    )!;

    expect(invited.invitedMaintainers).toContain(invitee);
    const proposal = prepareRepositoryMembershipMutation({
      repo: invited,
      actorPubkey: invitee,
      intent: { type: "accept" },
      announcements: [ownerInvitation, invalidAcceptance],
      stateEvents: [],
      createdAt: 30,
    });

    expect(proposal.template.tags).toContainEqual([
      "m",
      invitee,
      "20",
      "30",
      "30",
    ]);
    expect(proposal.template.created_at).toBe(30);
    expect(proposal.expectedMaintainers).toEqual([owner, invitee]);
    expect(proposal.expectedInvitations).toEqual([]);
  });

  it("refuses self-defer acceptance without a private relay hint", () => {
    const ownerInvitation = announcement(owner, [
      ["M", owner, "10"],
      ["m", invitee, "10"],
      ["maintainers", owner, invitee],
      ["private", "true"],
    ]);
    const invalidAcceptance = announcement(
      invitee,
      [
        ["M", owner, "20"],
        ["m", invitee, "20", "defer"],
        ["maintainers", owner],
      ],
      25,
    );
    const invited = resolveChain(
      [ownerInvitation, invalidAcceptance],
      owner,
      repoId,
    )!;

    expect(invited.isPrivate).toBe(true);
    expect(invited.relays).toEqual([]);
    expect(() =>
      prepareRepositoryMembershipMutation({
        repo: invited,
        actorPubkey: invitee,
        intent: { type: "accept" },
        announcements: [ownerInvitation, invalidAcceptance],
        stateEvents: [],
        createdAt: 30,
      }),
    ).toThrowError(
      expect.objectContaining<Partial<RepositoryMembershipMutationRefusal>>({
        code: "missing_private_relay_hint",
      }),
    );
  });

  it("requires dedicated repair when self-defer contains earlier intervals", () => {
    const ownerInvitation = announcement(owner, [
      ["M", owner, "10"],
      ["m", invitee, "25"],
      ["maintainers", owner, invitee],
    ]);
    const invalidAcceptance = announcement(
      invitee,
      [
        ["M", owner, "20"],
        ["m", invitee, "1", "5", "10", "defer"],
        ["maintainers", owner],
      ],
      25,
    );
    const invited = resolveChain(
      [ownerInvitation, invalidAcceptance],
      owner,
      repoId,
    )!;

    expect(invited.invitedMaintainers).toContain(invitee);
    expect(invited.repositoryHealth).toContainEqual(
      expect.objectContaining({
        code: "invalid-self-defer",
        author: invitee,
        role: "m",
        selfDefer: expect.objectContaining({ hasPriorIntervals: true }),
      }),
    );
    expect(() =>
      prepareRepositoryMembershipMutation({
        repo: invited,
        actorPubkey: invitee,
        intent: { type: "accept" },
        announcements: [ownerInvitation, invalidAcceptance],
        stateEvents: [],
        createdAt: 30,
      }),
    ).toThrowError(
      expect.objectContaining<Partial<RepositoryMembershipMutationRefusal>>({
        code: "unsupported_role_effect_import",
      }),
    );

    const explicitRepair = prepareRepositoryMembershipMutation({
      repo: invited,
      actorPubkey: invitee,
      intent: {
        type: "repair-self-defer",
        role: "m",
        repair: { action: "end", boundary: 20 },
      },
      announcements: [ownerInvitation, invalidAcceptance],
      stateEvents: [],
      createdAt: 30,
    });
    expect(explicitRepair.template.tags).toContainEqual([
      "m",
      invitee,
      "1",
      "5",
      "10",
      "20",
    ]);
  });

  it("accepts after a unique moderator successor without inventing another self-defer", () => {
    const ownerInvitation = announcement(owner, [
      ["M", owner, "10"],
      ["m", invitee, "25"],
      ["o", invitee, "20"],
      ["maintainers", owner, invitee],
    ]);
    const supersededInvalidAcceptance = announcement(
      invitee,
      [
        ["M", owner, "20"],
        ["m", invitee, "10", "defer"],
        ["o", invitee, "20"],
        ["maintainers", owner],
      ],
      25,
    );
    const invited = resolveChain(
      [ownerInvitation, supersededInvalidAcceptance],
      owner,
      repoId,
    )!;

    expect(invited.confirmedModerators).toContain(invitee);
    expect(invited.departedMaintainers).not.toContain(invitee);
    expect(invited.invitedMaintainers).toContain(invitee);
    const proposal = prepareRepositoryMembershipMutation({
      repo: invited,
      actorPubkey: invitee,
      intent: { type: "accept" },
      announcements: [ownerInvitation, supersededInvalidAcceptance],
      stateEvents: [],
      createdAt: 30,
    });
    const replacement: NostrEvent = {
      id: "f".repeat(64),
      sig: "f".repeat(128),
      pubkey: invitee,
      ...proposal.template,
    };
    const accepted = resolveChain(
      [ownerInvitation, replacement],
      owner,
      repoId,
    );

    expect(proposal.template.tags).toContainEqual([
      "m",
      invitee,
      "10",
      "20",
      "30",
    ]);
    expect(proposal.template.tags).toContainEqual(["o", invitee, "20"]);
    expect(proposal.template.created_at).toBe(30);
    expect(accepted?.confirmedMaintainers).toContain(invitee);
    expect(accepted?.confirmedModerators).not.toContain(invitee);
    expect(accepted?.repositoryHealth).not.toContainEqual(
      expect.objectContaining({ code: "invalid-self-defer" }),
    );
  });

  it("does not advertise acceptance that would import moderator history", () => {
    const ownerInvitation = announcement(owner, [
      ["M", owner, "10"],
      ["m", invitee, "25"],
      ["o", invitee, "1", "5", "20"],
      ["maintainers", owner, invitee],
    ]);
    const supersededInvalidAcceptance = announcement(
      invitee,
      [
        ["M", owner, "20"],
        ["m", invitee, "10", "defer"],
        ["o", invitee, "1", "5", "20"],
        ["maintainers", owner],
      ],
      25,
    );
    const invited = resolveChain(
      [ownerInvitation, supersededInvalidAcceptance],
      owner,
      repoId,
    )!;

    expect(invited.confirmedModerators).toContain(invitee);
    expect(invited.invitedMaintainers).toContain(invitee);
    expect(hasUnsupportedAcceptanceRoleHistory(invited, invitee, 30)).toBe(
      true,
    );
    expect(() =>
      prepareRepositoryMembershipMutation({
        repo: invited,
        actorPubkey: invitee,
        intent: { type: "accept" },
        announcements: [ownerInvitation, supersededInvalidAcceptance],
        stateEvents: [],
        createdAt: 30,
      }),
    ).toThrowError(
      expect.objectContaining<Partial<RepositoryMembershipMutationRefusal>>({
        code: "unsupported_role_effect_import",
      }),
    );
  });

  it("requires acceptance to start after every additional self-defer", () => {
    const ownerInvitation = announcement(owner, [
      ["M", owner, "10"],
      ["m", invitee, "10"],
      ["maintainers", owner, invitee],
    ]);
    const invalidAcceptance = announcement(
      invitee,
      [
        ["M", owner, "20"],
        ["m", invitee, "10", "defer"],
        ["o", invitee, "2000", "defer"],
        ["maintainers", owner],
      ],
      25,
    );
    const invited = resolveChain(
      [ownerInvitation, invalidAcceptance],
      owner,
      repoId,
    )!;

    expect(hasUnsupportedAcceptanceRoleHistory(invited, invitee, 1000)).toBe(
      true,
    );
    expect(hasUnsupportedAcceptanceRoleHistory(invited, invitee, 2000)).toBe(
      true,
    );
    expect(hasUnsupportedAcceptanceRoleHistory(invited, invitee, 2001)).toBe(
      false,
    );
    expect(() =>
      prepareRepositoryMembershipMutation({
        repo: invited,
        actorPubkey: invitee,
        intent: { type: "accept" },
        announcements: [ownerInvitation, invalidAcceptance],
        stateEvents: [],
        createdAt: 1000,
      }),
    ).toThrowError(
      expect.objectContaining<Partial<RepositoryMembershipMutationRefusal>>({
        code: "unsupported_role_effect_import",
      }),
    );

    const laterAcceptance = prepareRepositoryMembershipMutation({
      repo: invited,
      actorPubkey: invitee,
      intent: { type: "accept" },
      announcements: [ownerInvitation, invalidAcceptance],
      stateEvents: [],
      createdAt: 2001,
    });
    expect(laterAcceptance.template.tags).toContainEqual([
      "o",
      invitee,
      "2000",
      "defer",
    ]);
    expect(laterAcceptance.expectedMaintainers).toContain(invitee);
  });

  it("refuses acceptance when a superseded self-defer has multiple successors", () => {
    const ownerInvitation = announcement(owner, [
      ["M", owner, "10"],
      ["m", invitee, "5", "15", "25"],
      ["o", invitee, "20"],
      ["maintainers", owner, invitee],
    ]);
    const ambiguousAcceptance = announcement(
      invitee,
      [
        ["M", owner, "20"],
        ["m", invitee, "10", "defer"],
        ["o", invitee, "20"],
        ["o", invitee, "30"],
        ["maintainers", owner],
      ],
      35,
    );
    const invited = resolveChain(
      [ownerInvitation, ambiguousAcceptance],
      owner,
      repoId,
    )!;

    expect(invited.invitedMaintainers).toContain(invitee);
    expect(() =>
      prepareRepositoryMembershipMutation({
        repo: invited,
        actorPubkey: invitee,
        intent: { type: "accept" },
        announcements: [ownerInvitation, ambiguousAcceptance],
        stateEvents: [],
        createdAt: 40,
      }),
    ).toThrowError(
      expect.objectContaining<Partial<RepositoryMembershipMutationRefusal>>({
        code: "history_conflict",
      }),
    );
  });

  it("refuses acceptance with multiple invalid self-maintainer records", () => {
    const ownerInvitation = announcement(owner, [
      ["M", owner, "10"],
      ["m", invitee, "5", "15", "25"],
      ["maintainers", owner, invitee],
    ]);
    const ambiguousAcceptance = announcement(
      invitee,
      [
        ["M", owner, "20"],
        ["M", invitee, "10", "defer"],
        ["m", invitee, "10", "defer"],
        ["maintainers", owner],
      ],
      30,
    );
    const invited = resolveChain(
      [ownerInvitation, ambiguousAcceptance],
      owner,
      repoId,
    )!;

    expect(invited.invitedMaintainers).toContain(invitee);
    expect(() =>
      prepareRepositoryMembershipMutation({
        repo: invited,
        actorPubkey: invitee,
        intent: { type: "accept" },
        announcements: [ownerInvitation, ambiguousAcceptance],
        stateEvents: [],
        createdAt: 40,
      }),
    ).toThrowError(
      expect.objectContaining<Partial<RepositoryMembershipMutationRefusal>>({
        code: "unsupported_existing_announcement",
      }),
    );
  });

  it("does not repair acceptance across a valid numeric maintainer departure", () => {
    const ownerInvitation = announcement(owner, [
      ["M", owner, "10"],
      ["m", invitee, "5", "15", "25"],
      ["maintainers", owner, invitee],
    ]);
    const departedAcceptance = announcement(
      invitee,
      [
        ["M", owner, "20"],
        ["M", invitee, "25", "defer"],
        ["m", invitee, "10", "20"],
        ["maintainers", owner],
      ],
      30,
    );
    const invited = resolveChain(
      [ownerInvitation, departedAcceptance],
      owner,
      repoId,
    )!;

    expect(invited.departedMaintainers).toContain(invitee);
    expect(invited.invitedMaintainers).toContain(invitee);
    expect(() =>
      prepareRepositoryMembershipMutation({
        repo: invited,
        actorPubkey: invitee,
        intent: { type: "accept" },
        announcements: [ownerInvitation, departedAcceptance],
        stateEvents: [],
        createdAt: 40,
      }),
    ).toThrowError(
      expect.objectContaining<Partial<RepositoryMembershipMutationRefusal>>({
        code: "unsupported_role_effect_import",
      }),
    );
  });

  it("does not treat an unrelated invalid moderator defer as repairable acceptance", () => {
    const ownerInvitation = announcement(owner, [
      ["M", owner, "10"],
      ["m", invitee, "10", "20", "30"],
      ["maintainers", owner, invitee],
    ]);
    const departedInvitee = announcement(
      invitee,
      [
        ["M", owner, "10"],
        ["m", invitee, "10", "20"],
        ["o", invitee, "10", "defer"],
        ["maintainers", owner],
      ],
      25,
    );
    const invited = resolveChain(
      [ownerInvitation, departedInvitee],
      owner,
      repoId,
    )!;

    expect(invited.departedMaintainers).toContain(invitee);
    expect(invited.invitedMaintainers).toContain(invitee);
    expect(() =>
      prepareRepositoryMembershipMutation({
        repo: invited,
        actorPubkey: invitee,
        intent: { type: "accept" },
        announcements: [ownerInvitation, departedInvitee],
        stateEvents: [],
        createdAt: 40,
      }),
    ).toThrowError(
      expect.objectContaining<Partial<RepositoryMembershipMutationRefusal>>({
        code: "unsupported_existing_announcement",
      }),
    );
  });

  it("refuses acceptance when an invalid maintainer defer starts in the future", () => {
    const ownerInvitation = announcement(owner, [
      ["M", owner, "10"],
      ["m", invitee, "10"],
      ["maintainers", owner, invitee],
    ]);
    const futureInvalidAcceptance = announcement(
      invitee,
      [
        ["M", owner, "20"],
        ["m", invitee, "50", "defer"],
        ["maintainers", owner],
      ],
      20,
    );
    const invited = resolveChain(
      [ownerInvitation, futureInvalidAcceptance],
      owner,
      repoId,
    )!;

    expect(() =>
      prepareRepositoryMembershipMutation({
        repo: invited,
        actorPubkey: invitee,
        intent: { type: "accept" },
        announcements: [ownerInvitation, futureInvalidAcceptance],
        stateEvents: [],
        createdAt: 30,
      }),
    ).toThrowError(
      expect.objectContaining<Partial<RepositoryMembershipMutationRefusal>>({
        code: "history_conflict",
      }),
    );
  });
});
