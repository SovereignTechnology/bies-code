import type { NostrEvent } from "nostr-tools";
import { BehaviorSubject } from "rxjs";

import { normalizeUrl } from "@/lib/url";

interface PrivateRelayTrustSession {
  accountId: string;
  pubkey: string;
  generation: number;
}

const privateEventIds = new Set<string>();
// Page-lifetime quarantine. Active relay mappings are account-scoped below,
// but a coordinate once proven private must never become eligible for public
// delivery merely because an account switch cleared its current access.
const privateRepositoryCoordinates = new Set<string>();
const privateRepositoryRelays = new Map<string, Set<string>>();
const privateRelaySessions = new Map<string, PrivateRelayTrustSession>();

export const privateRepositoryScopeRevision$ = new BehaviorSubject(0);

function emitRevision(): void {
  privateRepositoryScopeRevision$.next(
    privateRepositoryScopeRevision$.getValue() + 1,
  );
}

export function installPrivateServiceRelays(
  accountId: string,
  pubkey: string,
  generation: number,
  relayUrls: readonly string[],
): string[] {
  const next = new Set(relayUrls.map(normalizeUrl));
  const removed: string[] = [];
  for (const [relay, session] of privateRelaySessions) {
    if (
      session.accountId !== accountId ||
      session.generation !== generation ||
      !next.has(relay)
    ) {
      privateRelaySessions.delete(relay);
      removed.push(relay);
    }
  }
  for (const relay of next) {
    privateRelaySessions.set(relay, { accountId, pubkey, generation });
  }
  if (removed.length > 0 || next.size > 0) emitRevision();
  return removed;
}

export function getPrivateRelayTrustSession(
  relayUrl: string,
): PrivateRelayTrustSession | undefined {
  return privateRelaySessions.get(normalizeUrl(relayUrl));
}

export function isTrustedPrivateRepositoryRelay(relayUrl: string): boolean {
  return privateRelaySessions.has(normalizeUrl(relayUrl));
}

export function markPrivateRepositoryCoordinate(coordinate: string): void {
  if (!privateRepositoryCoordinates.has(coordinate)) {
    privateRepositoryCoordinates.add(coordinate);
    emitRevision();
  }
}

export function installPrivateRepositoryRelays(
  coordinates: readonly string[],
  relayUrls: readonly string[],
): void {
  const relays = new Set(relayUrls.map(normalizeUrl));
  let changed = false;
  for (const coordinate of coordinates) {
    markPrivateRepositoryCoordinate(coordinate);
    const previous = privateRepositoryRelays.get(coordinate);
    if (
      !previous ||
      previous.size !== relays.size ||
      [...relays].some((relay) => !previous.has(relay))
    ) {
      privateRepositoryRelays.set(coordinate, new Set(relays));
      changed = true;
    }
  }
  if (changed) emitRevision();
}

export function getPrivateRepositoryRelays(
  coordinate: string,
): string[] | undefined {
  const relays = privateRepositoryRelays.get(coordinate);
  return relays ? [...relays] : undefined;
}

export function isPrivateRepositoryCoordinate(coordinate: string): boolean {
  return privateRepositoryCoordinates.has(coordinate);
}

export function markPrivateRelayEvent(event: NostrEvent): void {
  if (!privateEventIds.has(event.id)) {
    privateEventIds.add(event.id);
    emitRevision();
  }
}

export function isPrivateRepositoryEvent(event: NostrEvent): boolean {
  if (privateEventIds.has(event.id)) return true;
  return event.tags.some(
    ([name, value]) =>
      ((name === "a" || name === "A") &&
        privateRepositoryCoordinates.has(value)) ||
      ((name === "e" || name === "E" || name === "q") &&
        privateEventIds.has(value)),
  );
}

export function isPrivateRepositoryEventId(eventId: string): boolean {
  return privateEventIds.has(eventId);
}

export interface ClearedPrivateRepositoryScope {
  eventIds: string[];
  relayUrls: string[];
}

export function clearPrivateRepositoryScope(): ClearedPrivateRepositoryScope {
  const cleared = {
    eventIds: [...privateEventIds],
    relayUrls: [...privateRelaySessions.keys()],
  };
  privateEventIds.clear();
  privateRepositoryRelays.clear();
  privateRelaySessions.clear();
  emitRevision();
  return cleared;
}
