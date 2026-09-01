import { getReplaceableIdentifier } from "applesauce-core/helpers";
import { verifyEvent, type NostrEvent } from "nostr-tools";
import { BehaviorSubject } from "rxjs";

import { normalizeUrl } from "@/lib/url";

interface PrivateRelayTrustSession {
  accountId: string;
  pubkey: string;
  generation: number;
  sources: Set<"list" | "hint">;
}

const privateEventIds = new Set<string>();
// Page-lifetime quarantine. Active relay mappings are account-scoped below,
// but a coordinate once proven private must never become eligible for public
// delivery merely because an account switch cleared its current access.
const privateRepositoryCoordinates = new Set<string>();
const privateRepositoryRelays = new Map<string, Set<string>>();
const privateRelaySessions = new Map<string, PrivateRelayTrustSession>();
let activePrivateRelayTrustSession:
  | Pick<PrivateRelayTrustSession, "accountId" | "pubkey" | "generation">
  | undefined;

export const privateRepositoryScopeRevision$ = new BehaviorSubject(0);

function emitRevision(): void {
  privateRepositoryScopeRevision$.next(
    privateRepositoryScopeRevision$.getValue() + 1,
  );
}

/**
 * Establish the account generation that may admit private relay hints.
 *
 * This intentionally happens before the encrypted service list settles: a
 * GRASP-08/Buzz-positive route hint is an independent trust source. Account
 * switches still clear the whole scope before a new generation begins.
 */
export function beginPrivateRelayTrustSession(
  accountId: string,
  pubkey: string,
  generation: number,
): void {
  activePrivateRelayTrustSession = { accountId, pubkey, generation };
  let changed = false;
  for (const [relay, session] of privateRelaySessions) {
    if (session.accountId !== accountId || session.generation !== generation) {
      privateRelaySessions.delete(relay);
      changed = true;
    }
  }
  if (changed) emitRevision();
}

export function installPrivateServiceRelays(
  accountId: string,
  pubkey: string,
  generation: number,
  relayUrls: readonly string[],
): string[] {
  const next = new Set(relayUrls.map(normalizeUrl));
  const removed: string[] = [];
  beginPrivateRelayTrustSession(accountId, pubkey, generation);
  for (const [relay, session] of privateRelaySessions) {
    if (session.accountId !== accountId || session.generation !== generation) {
      privateRelaySessions.delete(relay);
      removed.push(relay);
    } else if (
      !next.has(relay) &&
      session.sources.delete("list") &&
      session.sources.size === 0
    ) {
      privateRelaySessions.delete(relay);
      removed.push(relay);
    }
  }
  for (const relay of next) {
    const existing = privateRelaySessions.get(relay);
    if (
      existing?.accountId === accountId &&
      existing.generation === generation
    ) {
      existing.sources.add("list");
    } else {
      privateRelaySessions.set(relay, {
        accountId,
        pubkey,
        generation,
        sources: new Set(["list"]),
      });
    }
  }
  if (removed.length > 0 || next.size > 0) emitRevision();
  return removed;
}

/** Admit a GRASP-08 route hint without changing the encrypted service list. */
export function installPrivateServiceRelayHint(
  accountId: string,
  pubkey: string,
  generation: number,
  relayUrl: string,
): boolean {
  const active = activePrivateRelayTrustSession;
  if (
    !active ||
    active.accountId !== accountId ||
    active.pubkey !== pubkey ||
    active.generation !== generation
  ) {
    return false;
  }

  const relay = normalizeUrl(relayUrl);
  const existing = privateRelaySessions.get(relay);
  let changed = false;
  if (existing) {
    if (
      existing.accountId !== accountId ||
      existing.generation !== generation
    ) {
      return false;
    }
    if (!existing.sources.has("hint")) {
      existing.sources.add("hint");
      changed = true;
    }
  } else {
    privateRelaySessions.set(relay, {
      accountId,
      pubkey,
      generation,
      sources: new Set(["hint"]),
    });
    changed = true;
  }
  if (changed) emitRevision();
  return true;
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

/**
 * Admit a verified repository announcement discovered on private services.
 *
 * The event and coordinate are quarantined before the caller inserts the event
 * into the EventStore. Only services that actually returned the announcement
 * become repository relay targets; other entries in the user's private list
 * must not learn about this repository through later publication.
 */
export function admitPrivateRepositoryAnnouncement(
  event: NostrEvent,
  relayUrls: readonly string[],
): boolean {
  const identifier = getReplaceableIdentifier(event);
  if (event.kind !== 30617 || !identifier || !verifyEvent(event)) return false;

  const coordinate = `30617:${event.pubkey}:${identifier}`;
  const discoveredRelays = relayUrls.map(normalizeUrl);
  if (discoveredRelays.length === 0) return false;

  markPrivateRelayEvent(event);
  installPrivateRepositoryRelays(
    [coordinate],
    [
      ...new Set([
        ...(getPrivateRepositoryRelays(coordinate) ?? []),
        ...discoveredRelays,
      ]),
    ],
  );
  return true;
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
  activePrivateRelayTrustSession = undefined;
  emitRevision();
  return cleared;
}
