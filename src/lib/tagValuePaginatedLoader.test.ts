import { subscribeSpyTo } from "@hirez_io/observer-spy";
import type { NostrEvent } from "nostr-tools";
import { of } from "rxjs";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { WS } from "vitest-websocket-mock";
import { Relay, RelayPool } from "applesauce-relay";
import { createPaginatedTagValueLoader } from "@/lib/tagValuePaginatedLoader";

const RELAY_URL = "wss://tag-loader.test";

function taggedEvent(id: string, target: string): NostrEvent {
  return {
    kind: 7,
    id,
    pubkey: "dd" + "0".repeat(62),
    created_at: 1_700_000_000,
    tags: [["e", target]],
    content: "+",
    sig: "ee" + "0".repeat(126),
  };
}

describe("createPaginatedTagValueLoader batching", () => {
  let server: WS;
  let pool: RelayPool;

  beforeEach(() => {
    vi.spyOn(Relay, "fetchInformationDocument").mockImplementation(() =>
      of(null),
    );
    server = new WS(RELAY_URL, { jsonProtocol: true });
    pool = new RelayPool();

    const originalRelay = pool.relay.bind(pool);
    vi.spyOn(pool, "relay").mockImplementation((url: string) => {
      const relay = originalRelay(url);
      relay.keepAlive = 0;
      relay.reconnectTimer = () => of(0);
      return relay;
    });
  });

  afterEach(async () => {
    await WS.clean();
    vi.clearAllMocks();
  });

  it("delivers the batch to the pointer that fills bufferSize", async () => {
    const loader = createPaginatedTagValueLoader(pool, "e", {
      bufferTime: 60_000,
      bufferSize: 2,
      settleTime: 1,
    });

    const first = subscribeSpyTo(
      loader({ value: "first-target", relays: [RELAY_URL] }),
    );
    const second = subscribeSpyTo(
      loader({ value: "batch-edge-target", relays: [RELAY_URL] }),
    );

    const request = (await server.nextMessage) as [
      string,
      string,
      { "#e": string[] },
    ];
    expect(request[0]).toBe("REQ");
    expect(request[2]["#e"]).toEqual(["first-target", "batch-edge-target"]);

    const firstEvent = taggedEvent("11".repeat(32), "first-target");
    const secondEvent = taggedEvent("22".repeat(32), "batch-edge-target");
    server.send(["EVENT", request[1], firstEvent]);
    server.send(["EVENT", request[1], secondEvent]);

    await vi.waitFor(
      () => {
        expect(first.getValues().map((event) => event.id)).toContain(
          firstEvent.id,
        );
        expect(second.getValues().map((event) => event.id)).toContain(
          secondEvent.id,
        );
      },
      { timeout: 1_000 },
    );

    first.unsubscribe();
    second.unsubscribe();
  });
});
