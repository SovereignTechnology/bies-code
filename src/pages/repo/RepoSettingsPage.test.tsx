import { fireEvent, render, screen, waitFor } from "@testing-library/react";
import type { NostrEvent } from "nostr-tools";
import { beforeEach, describe, expect, it, vi } from "vitest";

import { resolveChain, type ResolvedRepo } from "@/lib/nip34";
import { TestApp } from "@/test/TestApp";
import RepoSettingsPage from "./RepoSettingsPage";

const owner = "a".repeat(64);
const bob = "b".repeat(64);
const carol = "c".repeat(64);
const repoId = "settings-account-scope";

const mockState = vi.hoisted(() => ({
  activePubkey: "b".repeat(64),
  repo: undefined as ResolvedRepo | undefined,
  membershipMutate: vi.fn(),
}));

vi.mock("applesauce-react/hooks", async (importOriginal) => {
  const actual =
    await importOriginal<typeof import("applesauce-react/hooks")>();
  return {
    ...actual,
    useActiveAccount: () => ({
      pubkey: mockState.activePubkey,
      signer: {},
    }),
  };
});

vi.mock("./RepoContext", () => ({
  useRepoContext: () => ({
    resolved: mockState.repo ? { repo: mockState.repo } : undefined,
    repoState: null,
    basePath: "/repo/settings-account-scope",
    announcementsSettled: true,
    repoRelayEose: true,
  }),
}));

vi.mock("@/hooks/useRepositoryMembershipMutation", () => ({
  useRepositoryMembershipMutation: () => ({
    enabled: true,
    deliveryBlocked: false,
    mutate: mockState.membershipMutate,
    pendingIntent: undefined,
    failure: undefined,
    clearFailure: vi.fn(),
  }),
}));

vi.mock("@/hooks/useGraspServers", () => ({
  useGraspServers: () => ({
    servers: [],
    isFromUserList: false,
    isLoading: false,
  }),
}));

vi.mock("@/hooks/useResolvedUpstreamNip05", () => ({
  useResolvedUpstreamNip05: () => ({
    status: "idle",
    resolvedUpstream: undefined,
  }),
}));

function announcement(
  pubkey: string,
  name: string,
  maintainers: string[],
  createdAt: number,
  idCharacter: string,
): NostrEvent {
  return {
    id: idCharacter.repeat(64),
    pubkey,
    kind: 30617,
    created_at: createdAt,
    content: "",
    tags: [
      ["d", repoId],
      ["name", name],
      ["clone", "https://example.com/repository.git"],
      ["relays", "wss://relay.example.com"],
      ["maintainers", ...maintainers],
    ],
    sig: "f".repeat(128),
  };
}

describe("repository settings account scope", () => {
  beforeEach(() => {
    mockState.membershipMutate
      .mockReset()
      .mockResolvedValue(
        announcement(owner, "Saved announcement", [owner], 10, "9"),
      );
    const events = [
      announcement(owner, "Owner announcement", [bob, carol], 1, "1"),
      announcement(bob, "Bob announcement", [owner], 2, "2"),
      announcement(carol, "Carol announcement", [owner], 3, "3"),
    ];
    mockState.repo = resolveChain(events, owner, repoId);
    mockState.activePubkey = bob;
  });

  it("remounts account-authored form state when the active account changes", () => {
    const view = render(
      <TestApp>
        <RepoSettingsPage />
      </TestApp>,
    );

    const nameInput = screen.getByLabelText("Name");
    expect(nameInput).toHaveValue("Bob announcement");
    fireEvent.change(nameInput, { target: { value: "Unsaved Bob edit" } });

    mockState.activePubkey = carol;
    view.rerender(
      <TestApp>
        <RepoSettingsPage />
      </TestApp>,
    );

    expect(screen.getByLabelText("Name")).toHaveValue("Carol announcement");
  });

  it("stages several roster changes and publishes them only on save", async () => {
    const ownerEvent: NostrEvent = {
      ...announcement(owner, "Owner announcement", [owner, bob], 1, "1"),
      tags: [
        ["d", repoId],
        ["name", "Owner announcement"],
        ["clone", "https://example.com/repository.git"],
        ["relays", "wss://relay.example.com"],
        ["M", owner],
        ["m", bob],
        ["maintainers", owner, bob],
      ],
    };
    const bobEvent: NostrEvent = {
      ...announcement(bob, "Bob announcement", [owner, bob], 2, "2"),
      tags: [
        ["d", repoId],
        ["name", "Bob announcement"],
        ["clone", "https://example.com/repository.git"],
        ["relays", "wss://relay.example.com"],
        ["M", owner],
        ["m", bob],
        ["maintainers", owner, bob],
      ],
    };
    mockState.repo = resolveChain([ownerEvent, bobEvent], owner, repoId);
    mockState.activePubkey = owner;

    render(
      <TestApp>
        <RepoSettingsPage />
      </TestApp>,
    );

    fireEvent.change(screen.getByLabelText("Add maintainers"), {
      target: { value: carol },
    });
    fireEvent.click(
      screen.getByRole("button", { name: "Stage maintainer invitation" }),
    );
    fireEvent.click(
      screen.getByRole("button", { name: `Remove relationship ${bob}` }),
    );

    expect(mockState.membershipMutate).not.toHaveBeenCalled();
    expect(screen.getByText("will invite")).toBeInTheDocument();
    expect(screen.getByText("will remove")).toBeInTheDocument();

    fireEvent.click(screen.getByRole("button", { name: "Save changes" }));

    await waitFor(() =>
      expect(mockState.membershipMutate).toHaveBeenCalledWith(
        {
          type: "update-roster",
          addPubkeys: [carol],
          removePubkeys: [bob],
        },
        {
          expectedAnnouncementId: ownerEvent.id,
          announcementFields: undefined,
        },
      ),
    );
  });
});
