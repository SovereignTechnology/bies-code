/**
 * Verifies the stack-candidate (#c) discovery subscription inside
 * nip34RepoLoader is additive: a merge base discovered after the
 * subscription opened produces one delta REQ containing only the new
 * commit's filter, instead of a CLOSE + full re-REQ of every known commit.
 *
 * Uses vitest-websocket-mock like resilientAdditiveSubscription.test.ts so
 * the real relay stack (RelayPool → Relay → WebSocket) runs unmodified.
 * Events are genuinely signed because the singleton EventStore verifies
 * signatures on add.
 */

import { Relay, RelayGroup } from "applesauce-relay";
import type { Filter } from "applesauce-core/helpers";
import { finalizeEvent, generateSecretKey, getPublicKey } from "nostr-tools";
import type { Subscription } from "rxjs";
import { of } from "rxjs";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { WS } from "vitest-websocket-mock";

import { eventStore, nip34RepoLoader, pool } from "@/services/nostr";

const RELAY_URL = "wss://stack-candidates.test";

type ReqMessage = ["REQ", string, ...Filter[]];

function requests(server: WS): ReqMessage[] {
  return server.messages.filter(
    (message): message is ReqMessage =>
      Array.isArray(message) && message[0] === "REQ",
  );
}

function closes(server: WS): Array<["CLOSE", string]> {
  return server.messages.filter(
    (message): message is ["CLOSE", string] =>
      Array.isArray(message) && message[0] === "CLOSE",
  );
}

/** REQ frames whose filters include a #c clause (stack-candidate queries). */
function stackCandidateReqs(server: WS): ReqMessage[] {
  return requests(server).filter((req) =>
    req.slice(2).some((filter) => "#c" in (filter as Filter)),
  );
}

let server: WS;
let loaderSub: Subscription | undefined;

beforeEach(() => {
  vi.spyOn(Relay, "fetchInformationDocument").mockImplementation(() =>
    of(null),
  );
  server = new WS(RELAY_URL, { jsonProtocol: true });

  // Disable keep-alive pings and the 1s+ reconnect backoff on the singleton
  // pool's relay so the mock server sees only protocol frames.
  const relay = pool.relay(RELAY_URL);
  relay.keepAlive = 0;
  relay.reconnectTimer = () => of(0);
});

afterEach(async () => {
  loaderSub?.unsubscribe();
  loaderSub = undefined;
  await WS.clean();
  vi.restoreAllMocks();
});

describe("nip34RepoLoader stack-candidate subscription", () => {
  it("adds a late merge base as one delta REQ without closing the existing REQ", async () => {
    const secretKey = generateSecretKey();
    const pubkey = getPublicKey(secretKey);
    const coord = `30617:${pubkey}:stack-test-repo`;
    const mergeBase1 = "1".repeat(40);
    const mergeBase2 = "2".repeat(40);

    const group = new RelayGroup([pool.relay(RELAY_URL)]);
    loaderSub = nip34RepoLoader([coord], group).subscribe();

    // The loader's fixed queries (software app, items, repo meta) open
    // first; no #c query exists while no merge base is known.
    await vi.waitFor(() => expect(requests(server).length).toBeGreaterThan(2));
    expect(stackCandidateReqs(server)).toHaveLength(0);

    // First PR root advertising a merge base → the #c query opens.
    eventStore.add(
      finalizeEvent(
        {
          kind: 1618,
          created_at: 1_700_000_000,
          content: "",
          tags: [
            ["a", coord],
            ["merge-base", mergeBase1],
          ],
        },
        secretKey,
      ),
    );

    await vi.waitFor(() => expect(stackCandidateReqs(server)).toHaveLength(1));
    const initialReq = stackCandidateReqs(server)[0];
    expect(initialReq.slice(2)).toEqual([
      { kinds: [1618, 1619], "#a": [coord], "#c": [mergeBase1] },
    ]);

    // A second PR root discovered later grows the #c value set. The old
    // implementation restarted the whole subscription here (CLOSE + one
    // REQ re-reading both commits); the additive subscription must open a
    // single delta REQ carrying only the new commit.
    eventStore.add(
      finalizeEvent(
        {
          kind: 1618,
          created_at: 1_700_000_001,
          content: "",
          tags: [
            ["a", coord],
            ["merge-base", mergeBase2],
          ],
        },
        secretKey,
      ),
    );

    await vi.waitFor(() => expect(stackCandidateReqs(server)).toHaveLength(2));
    const deltaReq = stackCandidateReqs(server)[1];
    expect(deltaReq.slice(2)).toEqual([
      { kinds: [1618, 1619], "#a": [coord], "#c": [mergeBase2] },
    ]);
    expect(closes(server)).not.toContainEqual(["CLOSE", initialReq[1]]);
  });
});
