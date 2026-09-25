import { EventStore } from "applesauce-core";
import type { CastRefEventStore } from "applesauce-common/casts/cast";
import { nip19, type NostrEvent } from "nostr-tools";
import { describe, expect, it } from "vitest";

import { RepositoryState } from "@/casts/RepositoryState";
import {
  graspRepositoryCloneUrl,
  graspServerFromAddress,
  isValidGraspServiceAddress,
  relayMatchesGraspService,
  type GraspServer,
} from "@/lib/grasp";
import {
  graspCloneUrlServiceAddress,
  getRepoCloneUrls,
  getRepoMaintainers,
  resolveChain,
  type ResolvedRepo,
} from "@/lib/nip34";
import {
  buildMaintainerAcceptanceTemplate,
  classifyInvitationState,
  getAcceptanceMaintainerSelection,
} from "@/lib/repositoryInvitation";

const owner = "a".repeat(64);
const invitee = "b".repeat(64);
const collaborator = "c".repeat(64);
const secondCollaborator = "d".repeat(64);
const repoId = "invited-repo";
const mainRef = "refs/heads/main";
const topicRef = "refs/heads/topic";
const ownerCommit = "1".repeat(40);
const inviteeCommit = "2".repeat(40);

describe("path-mounted GRASP service addresses", () => {
  it("preserves mount paths while converting between relay and clone URLs", () => {
    const server = graspServerFromAddress(
      "wss://Relay.Example/services/Grasp/",
    );
    expect(server).toEqual({
      serviceAddress: "relay.example/services/Grasp",
      wsUrl: "wss://relay.example/services/Grasp",
    });
    expect(isValidGraspServiceAddress(server!.serviceAddress)).toBe(true);

    const npub = nip19.npubEncode(owner);
    const cloneUrl = graspRepositoryCloneUrl(
      server!.serviceAddress,
      npub,
      "mounted-repo",
    );
    expect(cloneUrl).toBe(
      `https://relay.example/services/Grasp/${npub}/mounted-repo.git`,
    );
    expect(graspCloneUrlServiceAddress(cloneUrl)).toBe(
      "relay.example/services/Grasp",
    );
  });

  it("keeps sibling relay mounts distinct", () => {
    expect(
      relayMatchesGraspService("wss://relay.example/grasp", [
        "relay.example/grasp",
      ]),
    ).toBe(true);
    expect(
      relayMatchesGraspService("wss://relay.example/other", [
        "relay.example/grasp",
      ]),
    ).toBe(false);
  });

  it("does not mistake an npub-like mount segment for the repository owner", () => {
    const npub = nip19.npubEncode(owner);
    const cloneUrl = `https://relay.example/npub1mount/${npub}/repo.git`;

    expect(graspCloneUrlServiceAddress(cloneUrl)).toBe(
      "relay.example/npub1mount",
    );
  });
});

function announcement(
  pubkey: string,
  createdAt: number,
  maintainers: string[],
  extraTags: string[][] = [],
): NostrEvent {
  return {
    id: pubkey,
    pubkey,
    kind: 30617,
    created_at: createdAt,
    content: "",
    tags: [
      ["d", repoId],
      ["name", "Invitation test"],
      ["maintainers", ...maintainers],
      ...extraTags,
    ],
    sig: "f".repeat(128),
  };
}

function state(
  pubkey: string,
  createdAt: number,
  refs: Array<[string, string]>,
  idPrefix: string,
): RepositoryState {
  const event: NostrEvent = {
    id: idPrefix.repeat(64),
    pubkey,
    kind: 30618,
    created_at: createdAt,
    content: "",
    tags: [["d", repoId], ["HEAD", `ref: ${mainRef}`], ...refs],
    sig: "e".repeat(128),
  };
  const store = new EventStore() as unknown as CastRefEventStore;
  return new RepositoryState(event, store);
}

function resolve(events: NostrEvent[]): ResolvedRepo {
  const repo = resolveChain(events, owner, repoId);
  if (!repo) throw new Error("Expected repository to resolve");
  return repo;
}

describe("invitation state safety", () => {
  it("allows acceptance when the invitee has no state", () => {
    const canonical = state(owner, 20, [[mainRef, ownerCommit]], "a");

    expect(classifyInvitationState(canonical, undefined, invitee)).toEqual({
      blocked: false,
      destructiveRefs: [],
    });
  });

  it("blocks a newer owner state that would replace or remove invitee refs", () => {
    const own = state(
      invitee,
      10,
      [
        [mainRef, inviteeCommit],
        [topicRef, inviteeCommit],
      ],
      "b",
    );
    const canonical = state(owner, 20, [[mainRef, ownerCommit]], "c");

    expect(classifyInvitationState(canonical, own, invitee)).toEqual({
      blocked: true,
      destructiveRefs: [mainRef, topicRef],
    });
  });

  it("allows an owner state that is newer but preserves every invitee ref", () => {
    const own = state(invitee, 10, [[mainRef, inviteeCommit]], "b");
    const canonical = state(
      owner,
      20,
      [
        [mainRef, inviteeCommit],
        [topicRef, ownerCommit],
      ],
      "c",
    );

    expect(classifyInvitationState(canonical, own, invitee).blocked).toBe(
      false,
    );
  });

  it("allows an invitee state that is newer than the owner's state", () => {
    const own = state(invitee, 20, [[mainRef, inviteeCommit]], "b");
    const canonical = state(owner, 10, [[mainRef, ownerCommit]], "c");

    expect(classifyInvitationState(canonical, own, invitee).blocked).toBe(
      false,
    );
  });

  it("allows equal timestamps after the canonical NIP-01 ID tiebreak", () => {
    const own = state(invitee, 20, [[mainRef, inviteeCommit]], "a");
    const canonical = state(owner, 20, [[mainRef, ownerCommit]], "f");

    expect(classifyInvitationState(canonical, own, invitee).blocked).toBe(
      false,
    );
  });
});

describe("invitation announcement construction", () => {
  it("preserves non-GRASP clone URLs and existing maintainer relationships", () => {
    const ownNpub = nip19.npubEncode(invitee);
    const ownAnnouncement = announcement(
      invitee,
      10,
      [collaborator],
      [
        [
          "clone",
          `https://old.example/${ownNpub}/${repoId}.git`,
          "https://github.com/example/invited-repo.git",
        ],
        ["relays", "wss://old.example"],
      ],
    );
    const repo = resolve([
      announcement(owner, 20, [invitee]),
      ownAnnouncement,
      announcement(collaborator, 5, [invitee]),
    ]);
    const servers: GraspServer[] = [
      {
        serviceAddress: "new.example/services/grasp",
        wsUrl: "wss://new.example/services/grasp",
      },
    ];

    const template = buildMaintainerAcceptanceTemplate(
      repo,
      ownAnnouncement,
      invitee,
      [owner],
      servers,
      30,
    );
    const templateEvent: NostrEvent = {
      ...template,
      id: "0".repeat(64),
      pubkey: invitee,
      sig: "0".repeat(128),
    };

    expect(getRepoCloneUrls(templateEvent)).toEqual([
      `https://new.example/services/grasp/${ownNpub}/${repoId}.git`,
      "https://github.com/example/invited-repo.git",
    ]);
    expect(template.tags).toContainEqual([
      "relays",
      "wss://new.example/services/grasp",
      "wss://old.example",
    ]);
    expect(getRepoMaintainers(templateEvent)).toEqual([
      invitee,
      collaborator,
      owner,
    ]);
  });

  it("selects the sole confirmed maintainer by default", () => {
    const repo = resolve([
      announcement(owner, 20, [invitee]),
      announcement(invitee, 10, []),
    ]);

    expect(getAcceptanceMaintainerSelection(repo, invitee)).toMatchObject({
      options: [owner],
      defaults: [owner],
    });
  });

  it("defaults to the unique lead and leaves ambiguous multi-maintainer groups empty", () => {
    const uniqueLeadRepo = resolve([
      announcement(owner, 20, [collaborator, secondCollaborator, invitee]),
      announcement(collaborator, 10, [owner]),
      announcement(secondCollaborator, 10, [owner]),
      announcement(invitee, 5, []),
    ]);

    expect(
      getAcceptanceMaintainerSelection(uniqueLeadRepo, invitee),
    ).toMatchObject({
      options: [owner, collaborator, secondCollaborator],
      defaults: [owner],
      leadMaintainer: owner,
    });

    const ambiguousRepo = resolve([
      announcement(owner, 20, [collaborator, invitee]),
      announcement(collaborator, 10, [owner]),
      announcement(invitee, 5, []),
    ]);
    expect(
      getAcceptanceMaintainerSelection(ambiguousRepo, invitee).defaults,
    ).toEqual([]);
  });
});
