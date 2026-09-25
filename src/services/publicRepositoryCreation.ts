import { getTagValue } from "applesauce-core/helpers";
import type { NostrEvent } from "nostr-tools";
import { verifyEvent } from "nostr-tools";

import {
  getRepoCloneUrls,
  getRepoRelays,
  getStateHeadCommit,
  REPO_KIND,
  REPO_STATE_KIND,
} from "@/lib/nip34";
import { normalizeUrl } from "@/lib/url";

const STORAGE_KEY = "gitworkshop:public-repository-creation:v1";
const MAX_STORED_TRANSACTIONS = 10;
const MAX_AGE_MS = 7 * 24 * 60 * 60 * 1000;

export interface PublicRepositoryCreationTransaction {
  pubkey: string;
  identifier: string;
  commitHash: string;
  cloneUrls: string[];
  relayUrls: string[];
  packfile: Uint8Array;
  announcement: NostrEvent;
  state: NostrEvent;
  createdAt: number;
}

interface StoredPublicRepositoryCreationTransaction extends Omit<
  PublicRepositoryCreationTransaction,
  "packfile"
> {
  packfileBase64: string;
}

function storage(): Storage | undefined {
  if (typeof window === "undefined") return undefined;
  try {
    return window.localStorage;
  } catch {
    return undefined;
  }
}

function transactionKey(pubkey: string, identifier: string): string {
  return `${pubkey}:${identifier}`;
}

function encodeBytes(bytes: Uint8Array): string {
  let binary = "";
  const chunkSize = 0x8000;
  for (let offset = 0; offset < bytes.length; offset += chunkSize) {
    binary += String.fromCharCode(
      ...bytes.subarray(offset, offset + chunkSize),
    );
  }
  return btoa(binary);
}

function decodeBytes(value: string): Uint8Array | undefined {
  try {
    return Uint8Array.from(atob(value), (character) => character.charCodeAt(0));
  } catch {
    return undefined;
  }
}

function sameStringSet(first: string[], second: string[]): boolean {
  const a = [...new Set(first)].sort();
  const b = [...new Set(second)].sort();
  return a.length === b.length && a.every((value, index) => value === b[index]);
}

function isEvent(value: unknown): value is NostrEvent {
  if (!value || typeof value !== "object") return false;
  const event = value as Partial<NostrEvent>;
  return (
    typeof event.id === "string" &&
    typeof event.pubkey === "string" &&
    typeof event.created_at === "number" &&
    typeof event.kind === "number" &&
    Array.isArray(event.tags) &&
    typeof event.content === "string" &&
    typeof event.sig === "string"
  );
}

function decodeTransaction(
  value: unknown,
  now: number,
): PublicRepositoryCreationTransaction | undefined {
  if (!value || typeof value !== "object") return undefined;
  const candidate = value as Partial<StoredPublicRepositoryCreationTransaction>;
  if (
    typeof candidate.pubkey !== "string" ||
    typeof candidate.identifier !== "string" ||
    typeof candidate.commitHash !== "string" ||
    !Array.isArray(candidate.cloneUrls) ||
    !candidate.cloneUrls.every((url) => typeof url === "string") ||
    !Array.isArray(candidate.relayUrls) ||
    !candidate.relayUrls.every((url) => typeof url === "string") ||
    typeof candidate.packfileBase64 !== "string" ||
    !isEvent(candidate.announcement) ||
    !isEvent(candidate.state) ||
    typeof candidate.createdAt !== "number" ||
    now - candidate.createdAt >= MAX_AGE_MS
  ) {
    return undefined;
  }

  const packfile = decodeBytes(candidate.packfileBase64);
  if (
    !packfile?.length ||
    candidate.announcement.kind !== REPO_KIND ||
    candidate.state.kind !== REPO_STATE_KIND ||
    candidate.announcement.pubkey !== candidate.pubkey ||
    candidate.state.pubkey !== candidate.pubkey ||
    getTagValue(candidate.announcement, "d") !== candidate.identifier ||
    getTagValue(candidate.state, "d") !== candidate.identifier ||
    getStateHeadCommit(candidate.state) !== candidate.commitHash ||
    !sameStringSet(
      getRepoCloneUrls(candidate.announcement),
      candidate.cloneUrls,
    ) ||
    !sameStringSet(
      getRepoRelays(candidate.announcement).map(normalizeUrl),
      candidate.relayUrls.map(normalizeUrl),
    ) ||
    !verifyEvent(candidate.announcement) ||
    !verifyEvent(candidate.state)
  ) {
    return undefined;
  }

  return {
    pubkey: candidate.pubkey,
    identifier: candidate.identifier,
    commitHash: candidate.commitHash,
    cloneUrls: candidate.cloneUrls,
    relayUrls: candidate.relayUrls.map(normalizeUrl),
    packfile,
    announcement: candidate.announcement,
    state: candidate.state,
    createdAt: candidate.createdAt,
  };
}

function readTransactions(): PublicRepositoryCreationTransaction[] {
  const persisted = storage()?.getItem(STORAGE_KEY);
  if (!persisted) return [];
  try {
    const parsed: unknown = JSON.parse(persisted);
    if (!Array.isArray(parsed)) return [];
    return parsed
      .map((value) => decodeTransaction(value, Date.now()))
      .filter((value): value is PublicRepositoryCreationTransaction => !!value);
  } catch {
    storage()?.removeItem(STORAGE_KEY);
    return [];
  }
}

function writeTransactions(
  transactions: PublicRepositoryCreationTransaction[],
): void {
  const stored: StoredPublicRepositoryCreationTransaction[] = transactions
    .slice(0, MAX_STORED_TRANSACTIONS)
    .map(({ packfile, ...transaction }) => ({
      ...transaction,
      packfileBase64: encodeBytes(packfile),
    }));
  try {
    if (stored.length === 0) storage()?.removeItem(STORAGE_KEY);
    else storage()?.setItem(STORAGE_KEY, JSON.stringify(stored));
  } catch {
    // The in-memory hook transaction still supports retry in this session.
  }
}

export function getPublicRepositoryCreationTransaction(
  pubkey: string,
  identifier: string,
): PublicRepositoryCreationTransaction | undefined {
  return readTransactions().find(
    (transaction) =>
      transactionKey(transaction.pubkey, transaction.identifier) ===
      transactionKey(pubkey, identifier),
  );
}

export function savePublicRepositoryCreationTransaction(
  transaction: PublicRepositoryCreationTransaction,
): void {
  const key = transactionKey(transaction.pubkey, transaction.identifier);
  writeTransactions([
    transaction,
    ...readTransactions().filter(
      (existing) =>
        transactionKey(existing.pubkey, existing.identifier) !== key,
    ),
  ]);
}

export function clearPublicRepositoryCreationTransaction(
  pubkey: string,
  identifier: string,
  stateId: string,
): void {
  writeTransactions(
    readTransactions().filter(
      (transaction) =>
        transactionKey(transaction.pubkey, transaction.identifier) !==
          transactionKey(pubkey, identifier) ||
        transaction.state.id !== stateId,
    ),
  );
}
