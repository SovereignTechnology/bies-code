import { act, cleanup, render, screen, waitFor } from "@testing-library/react";
import { afterAll, afterEach, beforeEach, expect, it, vi } from "vitest";
import { finalizeEvent, generateSecretKey, getPublicKey } from "nostr-tools";
import type { Filter } from "applesauce-core/helpers";
import type { PrivateGitRelayListState } from "@/services/privateGitRelays";

// jsdom's Uint8Array is a different realm from Node's TextEncoder output.
// Keep real signature verification while supplying bytes in the test realm.
vi.hoisted(() => {
  const NativeTextEncoder = globalThis.TextEncoder;
  vi.stubGlobal(
    "TextEncoder",
    class extends NativeTextEncoder {
      encode(input?: string): Uint8Array<ArrayBuffer> {
        return new Uint8Array(super.encode(input));
      }
    },
  );
});
afterAll(() => vi.unstubAllGlobals());

const mocks = vi.hoisted(() => ({
  account: undefined as { id: string; pubkey: string } | undefined,
  snapshot: vi.fn(),
  classify: vi.fn(),
}));
vi.mock("applesauce-react/hooks", async (original) => ({
  ...(await original<typeof import("applesauce-react/hooks")>()),
  useActiveAccount: () => mocks.account,
}));
vi.mock("@/services/nostr", async () => {
  const { EventStore } = await import("applesauce-core");
  return { eventStore: new EventStore(), pool: {} };
});
vi.mock("@/services/privateGitRelays", async () => {
  const { BehaviorSubject } = await import("rxjs");
  return {
    privateGitRelayList$: new BehaviorSubject<PrivateGitRelayListState>({
      generation: 0,
      status: "logged-out",
      relayUrls: [],
    }),
  };
});
vi.mock("@/lib/relaySnapshot", () => ({
  requestRelaySnapshot: mocks.snapshot,
}));
vi.mock("@/lib/grasp", () => ({
  classifyPrivateGitServiceRelay: mocks.classify,
}));

import { eventStore } from "@/services/nostr";
import { privateGitRelayList$ } from "@/services/privateGitRelays";
import {
  beginPrivateRelayTrustSession,
  clearPrivateRepositoryScope,
  markPrivateRelayEvent,
  privateRepositoryScopeRevision$,
} from "@/services/privateRepositoryScope";
import { usePrivateRepositoryProbe } from "./usePrivateRepositoryProbe";

const relay = "wss://private.example/";
const hints = [relay, "wss://hint.example/"];
let ownerKey = generateSecretKey();
let memberKey = generateSecretKey();
let owner = getPublicKey(ownerKey);
let member = getPublicKey(memberKey);
const statuses: string[] = [];

function announcement(key: Uint8Array, maintainers: string[], time = 1) {
  return finalizeEvent(
    {
      kind: 30617,
      content: "",
      created_at: time,
      tags: [
        ["d", "repo"],
        ["private", "true"],
        ["relays", relay],
        ["maintainers", ...maintainers],
      ],
    },
    key,
  );
}

function Probe({ pubkey = owner }: { pubkey?: string }) {
  const state = usePrivateRepositoryProbe(pubkey, "repo", hints);
  statuses.push(state?.status ?? "undefined");
  return (
    <>
      <output data-testid="status">
        {state?.status}: {state?.error}
      </output>
      <output data-testid="members">
        {state?.repo?.confirmedMaintainers.length}
      </output>
      {state?.status === "found" && <textarea aria-label="Issue body" />}
    </>
  );
}

beforeEach(() => {
  clearPrivateRepositoryScope();
  for (const event of eventStore.getByFilters({ kinds: [30617] }))
    eventStore.remove(event.id);
  ownerKey = generateSecretKey();
  memberKey = generateSecretKey();
  owner = getPublicKey(ownerKey);
  member = getPublicKey(memberKey);
  statuses.length = 0;
  mocks.account = { id: "owner", pubkey: owner };
  beginPrivateRelayTrustSession("owner", owner, 1);
  privateGitRelayList$.next({
    generation: 1,
    pubkey: owner,
    status: "ready",
    relayUrls: [relay],
  });
  mocks.classify.mockReset().mockResolvedValue(true);
  mocks.snapshot
    .mockReset()
    .mockImplementation(
      async (_pool: unknown, _relay: string, filters: Filter[]) => ({
        complete: true,
        events: filters[0].kinds?.includes(30617)
          ? [
              announcement(ownerKey, [owner, member]),
              announcement(memberKey, [owner, member]),
            ]
          : [],
      }),
    );
});
afterEach(cleanup);

it("keeps the composer mounted through discovery's writes and later private refreshes", async () => {
  render(<Probe />);
  await waitFor(() =>
    expect(screen.getByTestId("status").textContent).toBe("found: "),
  );
  const composer = await screen.findByRole("textbox", { name: "Issue body" });
  composer.focus();
  await waitFor(() =>
    expect(screen.getByTestId("members")).toHaveTextContent("2"),
  );
  // Force an observable refresh after discovery, including a new private event
  // whose coordinate is unrelated to the selected repository.
  await act(async () => {
    markPrivateRelayEvent(
      finalizeEvent(
        { kind: 1, content: "private", tags: [], created_at: 2 },
        memberKey,
      ),
    );
  });
  expect(screen.getByRole("textbox")).toBe(composer);
  expect(composer).toHaveFocus();
  expect(statuses.slice(statuses.indexOf("found"))).not.toContain("loading");
});

it("refreshes reciprocal membership without resetting focus", async () => {
  render(<Probe />);
  await waitFor(() =>
    expect(screen.getByTestId("status").textContent).toBe("found: "),
  );
  const composer = await screen.findByRole("textbox");
  composer.focus();
  await waitFor(() =>
    expect(screen.getByTestId("members")).toHaveTextContent("2"),
  );
  let completeRefresh!: (privateService: boolean) => void;
  const classification = new Promise<boolean>((resolve) => {
    completeRefresh = resolve;
  });
  const callsBeforeRefresh = mocks.classify.mock.calls.length;
  mocks.classify.mockReturnValue(classification);
  await act(async () => {
    const withdrawn = announcement(memberKey, [member], 2);
    markPrivateRelayEvent(withdrawn);
    eventStore.add(withdrawn);
  });
  await waitFor(() =>
    expect(mocks.classify.mock.calls.length).toBeGreaterThan(
      callsBeforeRefresh,
    ),
  );
  expect(screen.getByRole("textbox")).toBe(composer);
  expect(composer).toHaveFocus();
  expect(screen.getByTestId("members")).toHaveTextContent("1");
  await act(async () => {
    completeRefresh(true);
  });
  await waitFor(() =>
    expect(screen.getByTestId("members")).toHaveTextContent("1"),
  );
  expect(screen.getByRole("textbox")).toBe(composer);
  expect(composer).toHaveFocus();
  expect(statuses.slice(statuses.indexOf("found"))).not.toContain("loading");
});

it("does not preserve a found repository across logout", async () => {
  const { rerender } = render(<Probe />);
  await screen.findByRole("textbox");
  mocks.account = undefined;
  act(() => {
    clearPrivateRepositoryScope();
    privateGitRelayList$.next({
      generation: 2,
      status: "logged-out",
      relayUrls: [],
    });
  });
  rerender(<Probe />);
  expect(screen.queryByRole("textbox")).not.toBeInTheDocument();
  await waitFor(() =>
    expect(screen.getByTestId("status")).toHaveTextContent("unavailable"),
  );
});

it("invalidates a found result when refresh fails", async () => {
  render(<Probe />);
  await screen.findByRole("textbox");
  // The session guard rejects relay installation once access is withdrawn.
  await act(async () => {
    clearPrivateRepositoryScope();
    privateRepositoryScopeRevision$.next(
      privateRepositoryScopeRevision$.value + 1,
    );
  });
  await waitFor(() =>
    expect(screen.getByTestId("status")).toHaveTextContent("unavailable"),
  );
  expect(screen.queryByRole("textbox")).not.toBeInTheDocument();
});
