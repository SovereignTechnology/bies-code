/**
 * Verifies the shared repository coordinator-status owner grows additively:
 * a maintainer confirmed after the query opened produces one delta REQ
 * containing only the new maintainer's service-control clause, instead of a
 * new owner re-sending the status and control clauses already live.
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

import {
  CI_REPOSITORY_STATUS_KIND,
  CI_SERVICE_REQUEST_KIND,
  CI_SERVICE_STOP_KIND,
} from "@/lib/ci";
import { ciRepositoryCoordinatorStatus$ } from "@/services/ciQueries";
import { eventStore, pool } from "@/services/nostr";

const RELAY_URL = "wss://coordinator-status.test";

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

describe("ciRepositoryCoordinatorStatus$", () => {
  it("adds a late-confirmed maintainer as one delta REQ without closing the existing REQ", async () => {
    const secretKey = generateSecretKey();
    const maintainer1 = getPublicKey(secretKey);
    const maintainer2 = getPublicKey(generateSecretKey());
    const dTag = "status-test-repo";
    const coordinate = `30617:${maintainer1}:${dTag}`;

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

    subscriptions.push(
      ciRepositoryCoordinatorStatus$([coordinate], coordinate, [
        maintainer1,
      ]).subscribe(),
    );

    await vi.waitFor(() => expect(requests(server)).toHaveLength(1));
    const initialReq = requests(server)[0];
    expect(initialReq.slice(2)).toEqual([
      { kinds: [CI_REPOSITORY_STATUS_KIND], "#a": [coordinate] },
      {
        kinds: [CI_SERVICE_REQUEST_KIND, CI_SERVICE_STOP_KIND],
        authors: [maintainer1],
        "#a": [coordinate],
      },
    ]);

    // A maintainer confirmed later grows the service-control value set. The
    // old implementation keyed the owner by the full maintainer set, so this
    // opened a brand-new query re-sending every clause; the additive owner
    // must emit a single delta REQ carrying only the new maintainer.
    subscriptions.push(
      ciRepositoryCoordinatorStatus$([coordinate], coordinate, [
        maintainer1,
        maintainer2,
      ]).subscribe(),
    );

    await vi.waitFor(() => expect(requests(server)).toHaveLength(2));
    const deltaReq = requests(server)[1];
    expect(deltaReq.slice(2)).toEqual([
      {
        kinds: [CI_SERVICE_REQUEST_KIND, CI_SERVICE_STOP_KIND],
        authors: [maintainer2],
        "#a": [coordinate],
      },
    ]);
    expect(closes(server)).not.toContainEqual(["CLOSE", initialReq[1]]);
  });
});
