import type { ISigner } from "applesauce-signers";
import { CIRepositorySecretUpdateFactory } from "@/factories/CIRepositorySecretUpdateFactory";
import type { CIRepositorySecretMutation } from "@/factories/CIRepositorySecretUpdateFactory";
import type { CICoordinatorAdvertisement } from "@/casts/CICoordinator";
import { getEventRelayHint } from "@/factories/hints";
import { gitIndexRelays } from "@/services/settings";
import { pool } from "@/services/nostr";

export interface SubmitCIRepositorySecretsOptions extends CIRepositorySecretMutation {
  signer: ISigner;
  author: string;
  repositoryCoordinate: string;
  repositoryRelayHint?: string;
  advertisement: CICoordinatorAdvertisement;
}

export interface SubmitCIRepositorySecretsResult {
  eventId: string;
  author: string;
  createdAt: number;
  setNames: string[];
  removeNames: string[];
  acceptedRelays: string[];
  attemptedRelays: string[];
}

export interface CIPendingSecretChange {
  eventId: string;
  author: string;
  createdAt: number;
  baselineStatusId: string | undefined;
  name: string;
  operation: "set" | "remove";
}

/**
 * Encrypt, sign, and deliver one ephemeral secret mutation directly to every
 * inbox in the coordinator's exact live Advertisement. The event is not added
 * to the general EventStore or durable outbox.
 */
export async function submitCIRepositorySecrets({
  signer,
  author,
  repositoryCoordinate,
  repositoryRelayHint,
  advertisement,
  set,
  remove,
}: SubmitCIRepositorySecretsOptions): Promise<SubmitCIRepositorySecretsResult> {
  const recipient = advertisement.secretsRecipient;
  if (!recipient || recipient.relays.length === 0) {
    throw new Error("This coordinator is not accepting encrypted secrets.");
  }

  const now = Math.floor(Date.now() / 1000);
  const createdAt = Math.max(now, advertisement.event.created_at);
  if (createdAt >= advertisement.expiration) {
    throw new Error(
      "The coordinator's secret recipient has expired. Wait for its next advertisement.",
    );
  }

  const advertisementRelayHint =
    (await getEventRelayHint(advertisement.event.id)) ??
    gitIndexRelays.getValue()[0];
  if (!advertisementRelayHint) {
    throw new Error(
      "No relay hint is available for the coordinator advertisement.",
    );
  }

  const signed = await CIRepositorySecretUpdateFactory.create({
    author,
    repositoryCoordinate,
    repositoryRelayHint,
    coordinatorPubkey: advertisement.pubkey,
    advertisementId: advertisement.event.id,
    advertisementRelayHint,
    recipientPubkey: recipient.pubkey,
    createdAt,
    set,
    remove,
  }).sign(signer);

  if (signed.pubkey !== author) {
    throw new Error(
      "The active signer does not match the repository maintainer.",
    );
  }

  const responses = await pool.publish(recipient.relays, signed, {
    timeout: 15_000,
    retries: 1,
    reconnect: 1,
  });
  const acceptedRelays = responses
    .filter((response) => response.ok)
    .map((response) => response.from);
  if (acceptedRelays.length === 0) {
    const reason = responses
      .map((response) => response.message)
      .filter((message): message is string => !!message)
      .join("; ");
    throw new Error(
      reason
        ? `No secret inbox accepted the update: ${reason}`
        : "No secret inbox accepted the encrypted update.",
    );
  }

  return {
    eventId: signed.id,
    author,
    createdAt,
    setNames: Object.keys(set),
    removeNames: [...new Set(remove)],
    acceptedRelays,
    attemptedRelays: recipient.relays,
  };
}
