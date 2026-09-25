/**
 * Verifies the shared coordinator-discovery owner grows additively: a
 * maintainer confirmed after the query opened produces one delta REQ
 * containing only the new maintainer's readiness clause, instead of a new
 * owner re-sending the advertisement and readiness clauses already live.
 *
 * Uses vitest-websocket-mock like resilientAdditiveSubscription.test.ts so
 * the real relay stack (RelayPool → Relay → WebSocket) runs unmodified.
 */

import { Relay } from "applesauce-relay";
import type { Filter } from "applesauce-core/helpers";
import { generateSecretKey, getPublicKey } from "nostr-tools";
import type { Subscription } from "rxjs";
import { of } from "rxjs";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { WS } from "vitest-websocket-mock";

import {
  CI_COORDINATOR_ADVERTISEMENT_KIND,
  CI_REQUEST_READINESS_KIND,
} from "@/lib/ci";
import { ciCoordinatorDiscovery$ } from "@/services/ciQueries";
import { pool } from "@/services/nostr";
import { gitIndexRelays } from "@/services/settings";

const RELAY_URL = "wss://coordinator-discovery.test";

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

  gitIndexRelays.next([RELAY_URL]);
});

afterEach(async () => {
  for (const subscription of subscriptions) subscription.unsubscribe();
  subscriptions = [];
  // The keyed share lingers past the unsubscribe — drain the index relay
  // list so the lingering query leaves the mock relay before it closes.
  gitIndexRelays.next([]);
  await WS.clean();
  vi.restoreAllMocks();
});

describe("ciCoordinatorDiscovery$", () => {
  it("adds a late-confirmed maintainer as one delta REQ without closing the existing REQ", async () => {
    const maintainer1 = getPublicKey(generateSecretKey());
    const maintainer2 = getPublicKey(generateSecretKey());
    const coordinate = `30617:${maintainer1}:discovery-test-repo`;

    subscriptions.push(
      ciCoordinatorDiscovery$([coordinate], [maintainer1]).subscribe(),
    );

    await vi.waitFor(() => expect(requests(server)).toHaveLength(1));
    const initialReq = requests(server)[0];
    expect(initialReq.slice(2)).toEqual([
      { kinds: [CI_COORDINATOR_ADVERTISEMENT_KIND] },
      { kinds: [CI_REQUEST_READINESS_KIND], "#a": [coordinate] },
      { kinds: [CI_REQUEST_READINESS_KIND], "#p": [maintainer1] },
    ]);

    // A maintainer confirmed later grows the readiness value set. The old
    // implementation keyed the owner by the full maintainer set, so this
    // opened a brand-new query re-sending every clause; the additive owner
    // must emit a single delta REQ carrying only the new maintainer.
    subscriptions.push(
      ciCoordinatorDiscovery$(
        [coordinate],
        [maintainer1, maintainer2],
      ).subscribe(),
    );

    await vi.waitFor(() => expect(requests(server)).toHaveLength(2));
    const deltaReq = requests(server)[1];
    expect(deltaReq.slice(2)).toEqual([
      { kinds: [CI_REQUEST_READINESS_KIND], "#p": [maintainer2] },
    ]);
    expect(closes(server)).not.toContainEqual(["CLOSE", initialReq[1]]);
  });
});
