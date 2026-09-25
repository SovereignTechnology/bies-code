/**
 * Verifies the shared per-identity CI enrichment owner grows its relay set
 * additively: a relay added to the discovery settings after the query opened
 * receives one REQ of its own carrying the full enrichment filter, while the
 * REQ already open on the existing relay is neither closed nor re-sent.
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
  CI_IDENTITY_ENRICHMENT_KINDS,
  ciIdentityEnrichment$,
} from "@/services/ciQueries";
import { pool } from "@/services/nostr";
import { gitIndexRelays, lookupRelays } from "@/services/settings";

const RELAY_A = "wss://enrichment-initial.test";
const RELAY_B = "wss://enrichment-joined.test";

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

let serverA: WS;
let serverB: WS;
let querySub: Subscription | undefined;

beforeEach(() => {
  vi.spyOn(Relay, "fetchInformationDocument").mockImplementation(() =>
    of(null),
  );
  serverA = new WS(RELAY_A, { jsonProtocol: true });
  serverB = new WS(RELAY_B, { jsonProtocol: true });

  // Disable keep-alive pings and the 1s+ reconnect backoff on the singleton
  // pool's relays so the mock servers see only protocol frames.
  for (const url of [RELAY_A, RELAY_B]) {
    const relay = pool.relay(url);
    relay.keepAlive = 0;
    relay.reconnectTimer = () => of(0);
  }

  lookupRelays.next([RELAY_A]);
  gitIndexRelays.next([]);
});

afterEach(async () => {
  querySub?.unsubscribe();
  querySub = undefined;
  // The keyed share lingers past the unsubscribe — drain the discovery relay
  // lists so the lingering query leaves the mock relays before they close.
  lookupRelays.next([]);
  gitIndexRelays.next([]);
  await WS.clean();
  vi.restoreAllMocks();
});

describe("ciIdentityEnrichment$", () => {
  it("adds a grown discovery relay as one new REQ without disturbing the existing relay", async () => {
    const pubkey = getPublicKey(generateSecretKey());
    const enrichmentFilter = {
      kinds: [...CI_IDENTITY_ENRICHMENT_KINDS],
      authors: [pubkey],
    };

    querySub = ciIdentityEnrichment$(pubkey).subscribe();

    await vi.waitFor(() => expect(requests(serverA)).toHaveLength(1));
    expect(requests(serverA)[0].slice(2)).toEqual([enrichmentFilter]);
    expect(requests(serverB)).toHaveLength(0);

    // A relay appearing in the settings later grows the discovery set. The
    // old implementation restarted the whole query here (CLOSE on the
    // existing relay + full re-REQ everywhere); the additive subscription
    // must open one REQ on the new relay alone.
    gitIndexRelays.next([RELAY_B]);

    await vi.waitFor(() => expect(requests(serverB)).toHaveLength(1));
    expect(requests(serverB)[0].slice(2)).toEqual([enrichmentFilter]);
    expect(requests(serverA)).toHaveLength(1);
    expect(closes(serverA)).toHaveLength(0);
  });
});
