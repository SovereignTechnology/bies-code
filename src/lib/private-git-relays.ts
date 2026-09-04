import type { ISigner } from "applesauce-signers";
import { verifyEvent, type NostrEvent } from "nostr-tools";

import { normalizeUrl } from "@/lib/url";

/** GRASP-08 encrypted private Git relay list. */
export const PRIVATE_GIT_RELAY_LIST_KIND = 10_318;
export const GLOBAL_VANISH_KIND = 62;

export type PrivateGitRelayListDecodeFailure = "invalid" | "signer";

export class PrivateGitRelayListDecodeError extends Error {
  constructor(
    readonly failure: PrivateGitRelayListDecodeFailure,
    message: string,
    options?: ErrorOptions,
  ) {
    super(message, options);
    this.name = "PrivateGitRelayListDecodeError";
  }
}

interface PrivateGitRelayListCache {
  /** Event ID whose authenticated ciphertext produced these relay URLs. */
  eventId: string;
  relayUrls: string[];
}

function privateGitRelayListCacheKey(pubkey: string): string {
  return `private_git_relay_list:${pubkey}`;
}

function loadPrivateGitRelayListCache(
  pubkey: string,
): PrivateGitRelayListCache | undefined {
  try {
    const raw = localStorage.getItem(privateGitRelayListCacheKey(pubkey));
    if (!raw) return undefined;

    const parsed = JSON.parse(raw) as unknown;
    if (typeof parsed !== "object" || parsed === null) return undefined;

    const candidate = parsed as Record<string, unknown>;
    if (
      typeof candidate.eventId !== "string" ||
      !Array.isArray(candidate.relayUrls) ||
      !candidate.relayUrls.every(
        (relay): relay is string => typeof relay === "string",
      )
    ) {
      return undefined;
    }

    return {
      eventId: candidate.eventId,
      relayUrls: normalizePrivateGitRelayUrls(candidate.relayUrls),
    };
  } catch {
    return undefined;
  }
}

function savePrivateGitRelayListCache(
  pubkey: string,
  cache: PrivateGitRelayListCache,
): void {
  try {
    localStorage.setItem(
      privateGitRelayListCacheKey(pubkey),
      JSON.stringify(cache),
    );
  } catch {
    // Storage is an optimization; decoding still works without it.
  }
}

function validateRelayUrl(raw: string): string {
  let url: URL;
  try {
    url = new URL(raw);
  } catch (cause) {
    throw new PrivateGitRelayListDecodeError(
      "invalid",
      "Private Git relay list contains an invalid relay URL",
      { cause },
    );
  }

  if (
    (url.protocol !== "ws:" && url.protocol !== "wss:") ||
    url.username ||
    url.password ||
    url.hash
  ) {
    throw new PrivateGitRelayListDecodeError(
      "invalid",
      "Private Git relay list contains an invalid relay URL",
    );
  }

  return normalizeUrl(url.toString());
}

export function normalizePrivateGitRelayUrls(
  relayUrls: readonly string[],
): string[] {
  return [...new Set(relayUrls.map(validateRelayUrl))].sort();
}

function parsePrivateItems(plaintext: string): string[] {
  let value: unknown;
  try {
    value = JSON.parse(plaintext);
  } catch (cause) {
    throw new PrivateGitRelayListDecodeError(
      "invalid",
      "Private Git relay list plaintext is not valid JSON",
      { cause },
    );
  }

  if (!Array.isArray(value)) {
    throw new PrivateGitRelayListDecodeError(
      "invalid",
      "Private Git relay list plaintext must be an array",
    );
  }

  const relayUrls: string[] = [];
  for (const item of value) {
    if (
      !Array.isArray(item) ||
      item.length !== 2 ||
      item[0] !== "g" ||
      typeof item[1] !== "string"
    ) {
      throw new PrivateGitRelayListDecodeError(
        "invalid",
        "Private Git relay list contains a non-g item",
      );
    }
    relayUrls.push(item[1]);
  }

  return normalizePrivateGitRelayUrls(relayUrls);
}

export function isStructurallyValidPrivateGitRelayListEvent(
  event: NostrEvent,
  pubkey: string,
): boolean {
  return (
    event.kind === PRIVATE_GIT_RELAY_LIST_KIND &&
    event.pubkey === pubkey &&
    event.tags.length === 0
  );
}

export async function decodePrivateGitRelayListEvent(
  event: NostrEvent,
  pubkey: string,
  signer: ISigner,
): Promise<string[]> {
  if (!isStructurallyValidPrivateGitRelayListEvent(event, pubkey)) {
    throw new PrivateGitRelayListDecodeError(
      "invalid",
      "Private Git relay list has an invalid public envelope",
    );
  }
  if (!signer.nip44) {
    throw new PrivateGitRelayListDecodeError(
      "signer",
      "This signer does not support NIP-44 decryption",
    );
  }

  let plaintext: string;
  try {
    plaintext = await signer.nip44.decrypt(pubkey, event.content);
  } catch (cause) {
    throw new PrivateGitRelayListDecodeError(
      "signer",
      "Failed to decrypt the private Git relay list",
      { cause },
    );
  }

  return parsePrivateItems(plaintext);
}

function newestFirst(left: NostrEvent, right: NostrEvent): number {
  return right.created_at - left.created_at || left.id.localeCompare(right.id);
}

function isGlobalVanishEvent(event: NostrEvent): boolean {
  return (
    event.kind === GLOBAL_VANISH_KIND &&
    event.tags.some(
      ([name, value]) => name === "relay" && value === "ALL_RELAYS",
    )
  );
}

function isDeleted(
  event: NostrEvent,
  deletions: Iterable<NostrEvent>,
): boolean {
  for (const deletion of deletions) {
    if (
      deletion.kind === 5 &&
      deletion.pubkey === event.pubkey &&
      deletion.created_at >= event.created_at &&
      verifyEvent(deletion) &&
      deletion.tags.some(([name, value]) => name === "e" && value === event.id)
    ) {
      return true;
    }
  }
  return false;
}

function isVanished(
  event: NostrEvent,
  vanishes: Iterable<NostrEvent>,
): boolean {
  for (const vanish of vanishes) {
    if (
      verifyEvent(vanish) &&
      vanish.pubkey === event.pubkey &&
      vanish.created_at >= event.created_at &&
      isGlobalVanishEvent(vanish)
    ) {
      return true;
    }
  }
  return false;
}

export interface DecodedPrivateGitRelayList {
  event: NostrEvent;
  relayUrls: string[];
}

export interface PrivateGitRelayListEvidence {
  deletions?: Iterable<NostrEvent>;
  vanishes?: Iterable<NostrEvent>;
}

/** Select the newest valid, undeleted list using NIP-01 tie ordering. */
export async function selectPrivateGitRelayList(
  candidates: Iterable<NostrEvent>,
  pubkey: string,
  signer: ISigner,
  evidence: PrivateGitRelayListEvidence = {},
): Promise<DecodedPrivateGitRelayList | undefined> {
  const cached = loadPrivateGitRelayListCache(pubkey);

  for (const event of [...candidates].sort(newestFirst)) {
    if (
      !verifyEvent(event) ||
      !isStructurallyValidPrivateGitRelayListEvent(event, pubkey)
    ) {
      continue;
    }

    try {
      const relayUrls =
        cached?.eventId === event.id
          ? cached.relayUrls
          : await decodePrivateGitRelayListEvent(event, pubkey, signer);
      if (
        isDeleted(event, evidence.deletions ?? []) ||
        isVanished(event, evidence.vanishes ?? [])
      ) {
        return undefined;
      }
      if (cached?.eventId !== event.id) {
        savePrivateGitRelayListCache(pubkey, { eventId: event.id, relayUrls });
      }
      return { event, relayUrls };
    } catch (error) {
      if (
        error instanceof PrivateGitRelayListDecodeError &&
        error.failure === "invalid"
      ) {
        continue;
      }
      throw error;
    }
  }

  return undefined;
}

export function privateGitRelayListTimestampFloor(
  candidates: Iterable<NostrEvent>,
  vanishes: Iterable<NostrEvent>,
  pubkey: string,
): number {
  let floor = 0;
  for (const event of candidates) {
    if (
      event.pubkey === pubkey &&
      event.kind === PRIVATE_GIT_RELAY_LIST_KIND &&
      verifyEvent(event)
    ) {
      floor = Math.max(floor, event.created_at);
    }
  }
  for (const event of vanishes) {
    if (
      event.pubkey === pubkey &&
      verifyEvent(event) &&
      isGlobalVanishEvent(event)
    ) {
      floor = Math.max(floor, event.created_at);
    }
  }
  return floor;
}

/** Sign an exact encrypted kind:10318 replacement with no public tags. */
export async function createPrivateGitRelayListEvent(
  pubkey: string,
  signer: ISigner,
  relayUrls: readonly string[],
  minimumCreatedAt = 0,
): Promise<NostrEvent> {
  if (!signer.nip44) {
    throw new Error(
      "Private repository discovery requires a signer that supports NIP-44",
    );
  }

  const normalized = normalizePrivateGitRelayUrls(relayUrls);
  const plaintext = JSON.stringify(normalized.map((url) => ["g", url]));
  const content = await signer.nip44.encrypt(pubkey, plaintext);
  const unsigned = {
    kind: PRIVATE_GIT_RELAY_LIST_KIND,
    content,
    tags: [],
    created_at: Math.max(Math.floor(Date.now() / 1_000), minimumCreatedAt + 1),
  };
  const event = await signer.signEvent(unsigned);

  if (
    !verifyEvent(event) ||
    event.pubkey !== pubkey ||
    event.kind !== unsigned.kind ||
    event.content !== unsigned.content ||
    event.created_at !== unsigned.created_at ||
    event.tags.length !== 0
  ) {
    throw new Error("The signer changed the private Git relay list envelope");
  }

  const roundTrip = await decodePrivateGitRelayListEvent(event, pubkey, signer);
  if (
    roundTrip.length !== normalized.length ||
    roundTrip.some((url, index) => url !== normalized[index])
  ) {
    throw new Error("The signer returned an unreadable private Git relay list");
  }

  savePrivateGitRelayListCache(pubkey, {
    eventId: event.id,
    relayUrls: roundTrip,
  });

  return event;
}
