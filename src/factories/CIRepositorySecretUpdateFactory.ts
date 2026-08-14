import { blankEventTemplate, EventFactory } from "applesauce-core/factories";
import type { KnownEventTemplate } from "applesauce-core/helpers/event";
import { generateSecretKey, getPublicKey, nip44 } from "nostr-tools";
import { CI_REPOSITORY_SECRET_UPDATE_KIND } from "@/lib/ci";

type CIRepositorySecretUpdateTemplate = KnownEventTemplate<
  typeof CI_REPOSITORY_SECRET_UPDATE_KIND
>;

export const CI_SECRET_NAME_PATTERN = /^[A-Z_][A-Z0-9_]*$/;
export const CI_SECRET_VALUE_MAX_BYTES = 16_384;
export const CI_SECRET_UPDATE_MAX_NAMES = 100;
export const CI_SECRET_UPDATE_MAX_PLAINTEXT_BYTES = 65_535;
const CI_SECRET_RESERVED_NAMES = new Set([
  "PATH",
  "HOME",
  "CI",
  "DOCKER_HOST",
  "XDG_CONFIG_HOME",
  "XDG_CACHE_HOME",
]);
const CI_SECRET_RESERVED_PREFIXES = [
  "GITHUB_",
  "NGIT_CI_",
  "RUNNER_",
  "ACTIONS_",
];

export function isCISecretNameReserved(name: string): boolean {
  const normalized = name.toUpperCase();
  return (
    CI_SECRET_RESERVED_NAMES.has(normalized) ||
    CI_SECRET_RESERVED_PREFIXES.some((prefix) => normalized.startsWith(prefix))
  );
}

export interface CIRepositorySecretMutation {
  set: Record<string, string>;
  remove: string[];
}

export interface CIRepositorySecretUpdateOptions extends CIRepositorySecretMutation {
  author: string;
  repositoryCoordinate: string;
  repositoryRelayHint?: string;
  coordinatorPubkey: string;
  advertisementId: string;
  advertisementRelayHint: string;
  recipientPubkey: string;
  createdAt?: number;
}

function utf8Length(value: string): number {
  return new TextEncoder().encode(value).length;
}

function validateMutation({ set, remove }: CIRepositorySecretMutation): void {
  const setNames = Object.keys(set);
  const removeNames = [...new Set(remove)];
  const allNames = [...setNames, ...removeNames];

  if (allNames.length === 0) {
    throw new Error("Add or remove at least one secret.");
  }
  if (allNames.length > CI_SECRET_UPDATE_MAX_NAMES) {
    throw new Error(
      `A secret update can contain at most ${CI_SECRET_UPDATE_MAX_NAMES} names.`,
    );
  }

  const seen = new Set<string>();
  for (const name of allNames) {
    if (!CI_SECRET_NAME_PATTERN.test(name)) {
      throw new Error(
        `${name || "Secret name"} must use uppercase letters, numbers, and underscores.`,
      );
    }
    if (isCISecretNameReserved(name)) {
      throw new Error(`${name} is reserved by the CI runtime.`);
    }
    if (seen.has(name)) {
      throw new Error(`${name} cannot be set and removed in the same update.`);
    }
    seen.add(name);
  }

  for (const [name, value] of Object.entries(set)) {
    const valueBytes = utf8Length(value);
    if (valueBytes === 0)
      throw new Error(`${name} cannot have an empty value.`);
    if (valueBytes > CI_SECRET_VALUE_MAX_BYTES) {
      throw new Error(`${name} exceeds the 16 KiB value limit.`);
    }
  }
}

/**
 * Build one ephemeral kind:29846 update using a fresh encryption key which is
 * erased as soon as the NIP-44 ciphertext has been produced.
 */
export class CIRepositorySecretUpdateFactory extends EventFactory<
  typeof CI_REPOSITORY_SECRET_UPDATE_KIND,
  CIRepositorySecretUpdateTemplate
> {
  static create(
    options: CIRepositorySecretUpdateOptions,
  ): CIRepositorySecretUpdateFactory {
    validateMutation(options);

    const createdAt = options.createdAt ?? Math.floor(Date.now() / 1000);
    const plaintext = JSON.stringify({
      author: options.author,
      created_at: createdAt,
      set: options.set,
      remove: [...new Set(options.remove)],
    });
    if (utf8Length(plaintext) > CI_SECRET_UPDATE_MAX_PLAINTEXT_BYTES) {
      throw new Error(
        "The encrypted secret update exceeds the 65,535 byte limit.",
      );
    }

    const senderSecret = generateSecretKey();
    let senderPubkey: string;
    let ciphertext: string;
    try {
      senderPubkey = getPublicKey(senderSecret);
      const conversationKey = nip44.v2.utils.getConversationKey(
        senderSecret,
        options.recipientPubkey,
      );
      try {
        ciphertext = nip44.v2.encrypt(plaintext, conversationKey);
      } finally {
        conversationKey.fill(0);
      }
    } finally {
      senderSecret.fill(0);
    }

    const repositoryTag = options.repositoryRelayHint
      ? ["a", options.repositoryCoordinate, options.repositoryRelayHint]
      : ["a", options.repositoryCoordinate];

    return new CIRepositorySecretUpdateFactory((resolve) =>
      resolve(blankEventTemplate(CI_REPOSITORY_SECRET_UPDATE_KIND)),
    )
      .created(createdAt)
      .content(ciphertext)
      .modifyPublicTags(() => [
        repositoryTag,
        ["p", options.coordinatorPubkey],
        [
          "e",
          options.advertisementId,
          options.advertisementRelayHint,
          "secrets-key",
        ],
        ["sender", senderPubkey],
        ["recipient", options.recipientPubkey],
        ["encryption", "nip44-v2"],
      ]);
  }
}
