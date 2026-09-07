/**
 * useGraspServers — resolve the user's preferred Grasp servers.
 *
 * Reads the user's kind:10317 (User Grasp List) event from the EventStore.
 * The persistent subscription in userIdentitySubscription.ts keeps this
 * event fresh from the user's outbox + index relays for the session lifetime,
 * so this hook only needs to read from the store — no relay subscription.
 *
 * Falls back to DEFAULT_GRASP_SERVERS when the user has no grasp list
 * published.
 *
 * Returns an array of GraspServer objects with both the WebSocket URL and the
 * scheme-less service address, including any public mount path.
 */

import { useMemo } from "react";
import { map } from "rxjs/operators";
import { use$ } from "@/hooks/use$";
import { useEventStore } from "@/hooks/useEventStore";
import { graspServerFromAddress, type GraspServer } from "@/lib/grasp";
import { DEFAULT_GRASP_SERVERS } from "@/services/settings";
import type { NostrEvent } from "nostr-tools";

export type { GraspServer } from "@/lib/grasp";

// ---------------------------------------------------------------------------
// Constants
// ---------------------------------------------------------------------------

/** NIP-34 User Grasp List kind */
const GRASP_LIST_KIND = 10317;

// ---------------------------------------------------------------------------
// Helpers
// ---------------------------------------------------------------------------

/**
 * Extract GRASP service addresses from a kind:10317 event.
 * Each `g` tag contains a WebSocket URL whose mount path is significant.
 */
function parseGraspListEvent(event: NostrEvent): GraspServer[] {
  const servers: GraspServer[] = [];
  const seen = new Set<string>();

  for (const tag of event.tags) {
    if (tag[0] !== "g" || !tag[1]) continue;

    const server = graspServerFromAddress(tag[1]);
    if (!server || seen.has(server.serviceAddress)) continue;
    seen.add(server.serviceAddress);
    servers.push(server);
  }

  return servers;
}

/** Convert default GRASP service addresses to GraspServer objects. */
function defaultServers(): GraspServer[] {
  return DEFAULT_GRASP_SERVERS.flatMap((address) => {
    const server = graspServerFromAddress(address);
    return server ? [server] : [];
  });
}

// ---------------------------------------------------------------------------
// Hook
// ---------------------------------------------------------------------------

/**
 * Resolve the user's Grasp server list from the EventStore.
 *
 * The persistent subscription (userIdentitySubscription.ts) keeps kind:10317
 * fresh in the store, so this hook only reads — no relay subscription needed.
 *
 * @param pubkey - The user's hex pubkey (pass undefined when not logged in)
 * @returns Object with:
 *   - `servers`: The resolved GraspServer array (from kind:10317 or defaults)
 *   - `isFromUserList`: Whether the servers came from the user's published list
 *   - `isLoading`: Whether we're still waiting for the store to emit
 *   - `sourceEvent`: The event whose ID a full-replacement draft must freeze
 */
export function useGraspServers(pubkey: string | undefined): {
  servers: GraspServer[];
  isFromUserList: boolean;
  isLoading: boolean;
  sourceEvent?: NostrEvent;
} {
  const store = useEventStore();

  // Read the kind:10317 event from the store reactively.
  // The persistent subscription in userIdentitySubscription.ts ensures this
  // event is kept up-to-date from outbox + index relays.
  const graspListEvent = use$(() => {
    if (!pubkey) return undefined;
    return store
      .replaceable(GRASP_LIST_KIND, pubkey)
      .pipe(map((event) => event ?? null));
  }, [pubkey, store]);

  return useMemo(() => {
    // Not logged in — return defaults
    if (!pubkey) {
      return {
        servers: defaultServers(),
        isFromUserList: false,
        isLoading: false,
      };
    }

    // Still loading (undefined = observable hasn't emitted yet)
    if (graspListEvent === undefined) {
      return {
        servers: defaultServers(),
        isFromUserList: false,
        isLoading: true,
      };
    }

    // No grasp list event found (null = emitted empty)
    if (graspListEvent === null) {
      return {
        servers: defaultServers(),
        isFromUserList: false,
        isLoading: false,
      };
    }

    // Parse the event
    const parsed = parseGraspListEvent(graspListEvent);
    if (parsed.length === 0) {
      return {
        servers: defaultServers(),
        isFromUserList: false,
        isLoading: false,
        sourceEvent: graspListEvent,
      };
    }

    return {
      servers: parsed,
      isFromUserList: true,
      isLoading: false,
      sourceEvent: graspListEvent,
    };
  }, [pubkey, graspListEvent]);
}
