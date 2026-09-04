import { describe, expect, it } from "vitest";
import type { NostrEvent } from "nostr-tools";

import {
  buildAdvancedRepairReplacement,
  classifyRoleTag,
  diffRoleTags,
  regenerateMaintainersProjection,
  repositoryAnnouncementRoleTags,
} from "@/lib/repositoryAdvancedRepair";
import { parseAnnouncement } from "@/lib/nip34-maintainer-model";
import { RepositoryMembershipMutationRefusal } from "@/lib/repositoryMembershipMutation";

const author = "a".repeat(64);
const bob = "b".repeat(64);
const carol = "c".repeat(64);

function announcement(
  tags: string[][],
  createdAt = 1_000,
  content = "",
): NostrEvent {
  return {
    id: "1".repeat(64),
    pubkey: author,
    kind: 30617,
    created_at: createdAt,
    content,
    tags,
    sig: "f".repeat(128),
  };
}

function announcementBy(
  pubkey: string,
  tags: string[][],
  createdAt = 1_000,
): NostrEvent {
  return {
    ...announcement(tags, createdAt),
    id: pubkey,
    pubkey,
  };
}

function repositoryContext(
  isPrivate = false,
  announcements: NostrEvent[] = [],
) {
  return {
    selectedMaintainer: author,
    dTag: "repo",
    isPrivate,
    discoveredAnnouncements: announcements,
    historicalAnnouncements: [],
  };
}

function expectRefusal(run: () => unknown, code: string): void {
  try {
    run();
  } catch (error) {
    expect(error).toBeInstanceOf(RepositoryMembershipMutationRefusal);
    expect((error as RepositoryMembershipMutationRefusal).code).toBe(code);
    return;
  }
  throw new Error(`expected a ${code} refusal`);
}

describe("buildAdvancedRepairReplacement", () => {
  const baseTags = [
    ["d", "repo"],
    ["name", "Repo"],
    ["description", "About"],
    ["clone", "https://git.example.com/repo.git"],
    ["relays", "wss://relay.example.com"],
    ["alt", "git repository: Repo"],
    ["r", "e".repeat(40), "euc"],
    ["custom", "value", "extra"],
    ["m", bob, "100"],
    ["M", author],
    ["maintainers", author, bob],
    ["web", "https://example.com"],
  ];

  it("carries every non-membership tag byte-for-byte in order", () => {
    const event = announcement(baseTags);
    const { template } = buildAdvancedRepairReplacement({
      announcement: event,
      roleTags: [["M", author]],
      repository: repositoryContext(),
    });
    const carried = template.tags.filter(
      ([name]) => !["M", "m", "o", "maintainers"].includes(name),
    );
    expect(carried).toEqual(
      baseTags.filter(
        ([name]) => !["M", "m", "o", "maintainers"].includes(name),
      ),
    );
    expect(template.content).toBe(event.content);
    expect(template.kind).toBe(30617);
  });

  it("regenerates the maintainers projection from active valid M/m records", () => {
    const { template, maintainersProjection } = buildAdvancedRepairReplacement({
      announcement: announcement(baseTags),
      roleTags: [
        ["M", author],
        ["m", bob, "100", "200"], // ended — excluded
        ["m", carol, "150"],
        ["o", bob, "100"], // moderator — excluded
        ["m", author, "100", "defer"], // invalid self-defer — excluded
        ["m", "not-a-pubkey"], // malformed — excluded
      ],
      repository: repositoryContext(),
    });
    expect(maintainersProjection).toEqual([author, carol]);
    expect(template.tags.filter(([name]) => name === "maintainers")).toEqual([
      ["maintainers", author, carol],
    ]);
  });

  it("never emits an inconsistent-maintainers-projection warning", () => {
    const roleTags = [
      ["M", author],
      ["m", bob, "100", "200", "300"],
      ["o", carol, "50"],
    ];
    const { simulated } = buildAdvancedRepairReplacement({
      announcement: announcement(baseTags),
      roleTags,
      repository: repositoryContext(),
    });
    expect(
      parseAnnouncement(simulated).health.filter(
        ({ code }) => code === "inconsistent-maintainers-projection",
      ),
    ).toEqual([]);
  });

  it("bumps created_at strictly past the existing announcement", () => {
    const old = announcement(baseTags, 5_000);
    const stale = buildAdvancedRepairReplacement({
      announcement: old,
      roleTags: [["M", author]],
      repository: repositoryContext(),
      createdAt: 4_000,
    });
    expect(stale.template.created_at).toBe(5_001);
    const fresh = buildAdvancedRepairReplacement({
      announcement: old,
      roleTags: [["M", author]],
      repository: repositoryContext(),
      createdAt: 6_000,
    });
    expect(fresh.template.created_at).toBe(6_000);
  });

  it("refuses a private replacement without a relay hint", () => {
    const noRelays = announcement(
      baseTags.filter(([name]) => name !== "relays"),
    );
    expectRefusal(
      () =>
        buildAdvancedRepairReplacement({
          announcement: noRelays,
          roleTags: [["M", author]],
          repository: repositoryContext(true),
        }),
      "missing_private_relay_hint",
    );
    // The same tags publish fine when the repository is not private.
    expect(
      buildAdvancedRepairReplacement({
        announcement: noRelays,
        roleTags: [["M", author]],
        repository: repositoryContext(),
      }).template.kind,
    ).toBe(30617);
  });

  it("accepts a private replacement whose carried relays tag has a hint", () => {
    const { template } = buildAdvancedRepairReplacement({
      announcement: announcement(baseTags),
      roleTags: [["M", author]],
      repository: repositoryContext(true),
    });
    expect(template.tags).toContainEqual(["relays", "wss://relay.example.com"]);
  });

  it("requires a relay hint when the role edit makes the component private", () => {
    const owner = announcement([
      ["d", "repo"],
      ["name", "Repo"],
      ["clone", "https://git.example.com/repo.git"],
      ["M", author, "10"],
      ["m", bob, "10", "20"],
      ["maintainers", author],
    ]);
    const privateMaintainer = announcementBy(bob, [
      ["d", "repo"],
      ["name", "Repo"],
      ["clone", "https://git.example.com/repo.git"],
      ["relays", "wss://private.example.com"],
      ["private", "true"],
      ["M", author, "30"],
      ["m", bob, "30"],
      ["maintainers", author, bob],
    ]);
    const repairedRoles = [
      ["M", author, "10"],
      ["m", bob, "10", "20", "30"],
    ];

    expectRefusal(
      () =>
        buildAdvancedRepairReplacement({
          announcement: owner,
          roleTags: repairedRoles,
          repository: repositoryContext(false, [owner, privateMaintainer]),
        }),
      "missing_private_relay_hint",
    );

    const ownerWithRelay = announcement([
      ...owner.tags,
      ["relays", "wss://owner-private.example.com"],
    ]);
    const replacement = buildAdvancedRepairReplacement({
      announcement: ownerWithRelay,
      roleTags: repairedRoles,
      repository: repositoryContext(false, [ownerWithRelay, privateMaintainer]),
    });
    expect(replacement.resolvedRepository?.isPrivate).toBe(true);
    expect(replacement.resolvedRepository?.confirmedMaintainers).toContain(bob);
  });

  it("refuses when the signer has no existing announcement", () => {
    expectRefusal(
      () =>
        buildAdvancedRepairReplacement({
          announcement: undefined,
          roleTags: [["M", author]],
          repository: repositoryContext(),
        }),
      "history_conflict",
    );
  });

  it("refuses non-role tags in the edited tag list", () => {
    expectRefusal(
      () =>
        buildAdvancedRepairReplacement({
          announcement: announcement(baseTags),
          roleTags: [["maintainers", author]],
          repository: repositoryContext(),
        }),
      "membership_side_effect",
    );
    expectRefusal(
      () =>
        buildAdvancedRepairReplacement({
          announcement: announcement(baseTags),
          roleTags: [["relays", "wss://evil.example.com"]],
          repository: repositoryContext(),
        }),
      "membership_side_effect",
    );
  });

  it("produces a simulated event that parses like the signed replacement", () => {
    const { simulated, template } = buildAdvancedRepairReplacement({
      announcement: announcement(baseTags),
      roleTags: [
        ["M", author],
        ["m", bob, "100"],
      ],
      repository: repositoryContext(),
    });
    expect(simulated.pubkey).toBe(author);
    expect(simulated.tags).toEqual(template.tags);
    expect(simulated.created_at).toBe(template.created_at);
    const parsed = parseAnnouncement(simulated);
    expect(parsed.health).toEqual([]);
    expect(parsed.activeMaintainers.map(({ pubkey }) => pubkey).sort()).toEqual(
      [author, bob].sort(),
    );
  });
});

describe("repositoryAnnouncementRoleTags", () => {
  it("returns copies of only the M/m/o tags in event order", () => {
    const event = announcement([
      ["d", "repo"],
      ["m", bob, "100"],
      ["maintainers", author, bob],
      ["o", carol],
      ["M", author],
    ]);
    const tags = repositoryAnnouncementRoleTags(event);
    expect(tags).toEqual([
      ["m", bob, "100"],
      ["o", carol],
      ["M", author],
    ]);
    tags[0][2] = "999";
    expect(event.tags[1][2]).toBe("100");
  });
});

describe("regenerateMaintainersProjection", () => {
  it("deduplicates subjects and ignores everything but active valid M/m", () => {
    expect(
      regenerateMaintainersProjection(author, [
        ["M", bob, "10"],
        ["m", bob, "20", "30", "40"],
        ["m", author, "5", "defer"],
        ["o", carol],
        ["m", carol, "1", "2"],
        ["garbage"],
      ]),
    ).toEqual([bob]);
  });
});

describe("classifyRoleTag", () => {
  it("matches the announcement parser's record classification", () => {
    expect(classifyRoleTag(author, ["m", bob])).toBe("active");
    expect(classifyRoleTag(author, ["m", bob, "10", "20"])).toBe("inactive");
    expect(classifyRoleTag(author, ["m", bob, "10", "defer"])).toBe("inactive");
    expect(classifyRoleTag(author, ["m", author, "10", "defer"])).toBe(
      "invalid-self-defer",
    );
    expect(classifyRoleTag(author, ["m", "nope"])).toBe("malformed");
    expect(classifyRoleTag(author, ["m", bob, "10", "defer", "20"])).toBe(
      "malformed",
    );
  });
});

describe("diffRoleTags", () => {
  it("computes a multiset diff that keeps duplicate rows distinct", () => {
    const current = [
      ["m", bob, "100"],
      ["m", bob, "100"],
      ["M", author],
    ];
    const edited = [
      ["m", bob, "100"],
      ["m", carol],
      ["M", author],
    ];
    const diff = diffRoleTags(current, edited);
    expect(diff.unchanged).toEqual([
      ["m", bob, "100"],
      ["M", author],
    ]);
    expect(diff.added).toEqual([["m", carol]]);
    expect(diff.removed).toEqual([["m", bob, "100"]]);
  });
});
