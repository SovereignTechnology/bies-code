import { fireEvent, render, screen } from "@testing-library/react";
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
      ["maintainers", ...maintainers],
    ],
    sig: "f".repeat(128),
  };
}

describe("repository settings account scope", () => {
  beforeEach(() => {
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
});
