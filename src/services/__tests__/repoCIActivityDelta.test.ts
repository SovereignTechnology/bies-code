/**
 * Verifies the shared repo-wide CI activity owner grows additively: a
 * maintainer coordinate confirmed after the query opened produces one delta
 * REQ containing only the new coordinate's clause, instead of a new owner
 * closing the live REQ and re-sending every coordinate.
 *
 * Uses vitest-websocket-mock like resilientAdditiveSubscription.test.ts so
 * the real relay stack (RelayPool → Relay → WebSocket) runs unmodified. The
 * repository relay comes from a genuinely signed kind:30617 announcement,
 * because the owner resolves its relay list through the model-cached
 * RepositoryRelayGroup and the singleton EventStore verifies signatures.
 */

import { Relay } from "applesauce-relay";
import type { Filter } from "applesauce-core/helpers";
import { finalizeEvent, generateSecretKey, getPublicKey } from "nostr-tools";
import type { Subscription } from "rxjs";
import { of } from "rxjs";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { WS } from "vitest-websocket-mock";

import { CI_EVENT_KINDS } from "@/lib/ci";
import { repoCIActivity$ } from "@/services/ciQueries";
import { eventStore, pool } from "@/services/nostr";

const RELAY_URL = "wss://repo-ci-activity.test";

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

let server: WS;
let subscriptions: Subscription[] = [];

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
  for (const subscription of subscriptions) subscription.unsubscribe();
  subscriptions = [];
  await WS.clean();
  vi.restoreAllMocks();
});

describe("repoCIActivity$", () => {
  it("adds a late-confirmed coordinate as one delta REQ without closing the existing REQ", async () => {
    const secretKey = generateSecretKey();
    const maintainer1 = getPublicKey(secretKey);
    const maintainer2 = getPublicKey(generateSecretKey());
    const dTag = "activity-test-repo";
    const coordinate1 = `30617:${maintainer1}:${dTag}`;
    const coordinate2 = `30617:${maintainer2}:${dTag}`;

    // Announce the repository with the mock relay so the owner's
    // RepositoryRelayGroup resolution yields it.
    eventStore.add(
      finalizeEvent(
        {
          kind: 30617,
          created_at: 1_700_000_000,
          content: "",
          tags: [
            ["d", dTag],
            ["relays", RELAY_URL],
          ],
        },
        secretKey,
      ),
    );

    subscriptions.push(repoCIActivity$([coordinate1], coordinate1).subscribe());

    await vi.waitFor(() => expect(requests(server)).toHaveLength(1));
    const initialReq = requests(server)[0];
    expect(initialReq.slice(2)).toEqual([
      { kinds: [...CI_EVENT_KINDS], "#a": [coordinate1] },
    ]);

    // A second maintainer coordinate confirmed later grows the #a value
    // set. The old implementation keyed the owner by the full coordinate
    // set, so this opened a brand-new query re-sending every coordinate;
    // the additive owner must emit a single delta REQ carrying only the
    // new one.
    subscriptions.push(
      repoCIActivity$([coordinate1, coordinate2], coordinate1).subscribe(),
    );

    await vi.waitFor(() => expect(requests(server)).toHaveLength(2));
    const deltaReq = requests(server)[1];
    expect(deltaReq.slice(2)).toEqual([
      { kinds: [...CI_EVENT_KINDS], "#a": [coordinate2] },
    ]);
    expect(closes(server)).not.toContainEqual(["CLOSE", initialReq[1]]);
  });
});
