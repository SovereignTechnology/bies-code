/**
 * useCreateRepo — orchestration hook for the repo creation flow.
 *
 * Coordinates the full sequence:
 *   1. Confirm the new coordinates are absent on their required frontiers
 *   2. Build git objects (blob → tree → commit → packfile)
 *   3. Sign kind:30617 (announcement) and kind:30618 (state) events
 *   4. Obtain pre-push event acceptance from the Grasp relay + publish the
 *      announcement to outbox/index relays
 *   5. Push the packfile to the Grasp git HTTP endpoint
 *
 * Exposes step-by-step progress state for the UI.
 */

import { useCallback, useRef, useState } from "react";
import { useActiveAccount } from "applesauce-react/hooks";
import { nip19 } from "nostr-tools";
import type { NostrEvent } from "nostr-tools";
import { createInitialCommit } from "@/lib/create-repo";
import { RepoAnnouncementFactory } from "@/factories/RepoAnnouncementFactory";
import { RepoStateFactory } from "@/factories/RepoStateFactory";
import { eventStore, pool } from "@/services/nostr";
import { outboxStore } from "@/services/outbox";
import { privateGitRelayList$ } from "@/services/privateGitRelays";
import {
  installPrivateRepositoryRelays,
  markPrivateRelayEvent,
} from "@/services/privateRepositoryScope";

import { pushToGitServer, ZERO_HASH, type RefUpdate } from "@/lib/git-push";
import {
  fetchGraspServerInformation,
  graspRepositoryCloneUrl,
  type GraspServer,
} from "@/lib/grasp";
import { useProfile } from "@/hooks/useProfile";
import {
  createGitHttpAuthorizationProvider,
  gitAuthorizationHeaders,
} from "@/lib/git-http-auth";
import { verifyPrivateGraspService } from "@/lib/private-grasp";
import { resilientRequest } from "@/lib/resilientSubscription";
import { onlyEvents } from "applesauce-relay";
import { firstValueFrom, timeout, toArray } from "rxjs";
import { repoCoordinate } from "@/lib/nip34";
import { assertNewPublicRepositoryCoordinatesAvailable } from "@/hooks/useRepositoryReplaceablePreflight";
import { normalizeUrl } from "@/lib/url";
import {
  clearPublicRepositoryCreationTransaction,
  getPublicRepositoryCreationTransaction,
  savePublicRepositoryCreationTransaction,
  type PublicRepositoryCreationTransaction,
} from "@/services/publicRepositoryCreation";

// ---------------------------------------------------------------------------
// Types
// ---------------------------------------------------------------------------

/** Progress step for the UI. */
export type CreateRepoStep =
  | "idle"
  | "checking-relays"
  | "building-commit"
  | "signing-events"
  | "publishing-announcement"
  | "publishing-state"
  | "pushing"
  | "done"
  | "error";

/** Full state exposed to the dialog. */
export interface CreateRepoState {
  step: CreateRepoStep;
  error?: string;
  /** Timestamp (ms) when the repository events received pre-push acceptance. */
  publishedAt?: number;
  /** The Grasp clone URL on success */
  cloneUrl?: string;
  /** The commit hash on success */
  commitHash?: string;
  /** The repo identifier (d-tag) on success */
  identifier?: string;
}

/** Input from the dialog form. */
export interface CreateRepoFormInput {
  /** Human-readable repo name */
  name: string;
  /** Optional description */
  description: string;
  /** The validated d-tag identifier */
  identifier: string;
  /** The selected Grasp servers to publish to */
  graspServers: GraspServer[];
  /** Create only on one GRASP-08 service from the encrypted kind-10318 list. */
  private?: boolean;
}

interface PrivateCreateRetry {
  generation: number;
  pubkey: string;
  relayUrl: string;
  cloneUrl: string;
  identifier: string;
  commitHash: string;
  packfile: Uint8Array;
  announcement: NostrEvent;
  state: NostrEvent;
}

// ---------------------------------------------------------------------------
// Hook
// ---------------------------------------------------------------------------

export function useCreateRepo() {
  const account = useActiveAccount();
  const pubkey = account?.pubkey;
  const npub = pubkey ? nip19.npubEncode(pubkey) : undefined;
  const profile = useProfile(pubkey);

  const [state, setState] = useState<CreateRepoState>({ step: "idle" });
  const abortRef = useRef<AbortController | null>(null);
  const privateRetryRef = useRef<PrivateCreateRetry>();
  const publicRetryRef = useRef<PublicRepositoryCreationTransaction>();

  const reset = useCallback(() => {
    abortRef.current?.abort();
    abortRef.current = null;
    privateRetryRef.current = undefined;
    publicRetryRef.current = undefined;
    setState({ step: "idle" });
  }, []);

  const execute = useCallback(
    async (input: CreateRepoFormInput) => {
      if (!account || !pubkey || !npub) {
        setState({ step: "error", error: "Not logged in" });
        return;
      }

      const abort = new AbortController();
      abortRef.current = abort;

      try {
        if (input.private && input.graspServers.length !== 1) {
          throw new Error("Select exactly one private GRASP-08 service");
        }

        // Resolve the proposed frontier before any signing or Git work. A
        // public repository has no warm page owner yet, so its collision
        // check is the one legitimate focused announcement/state request.
        const encodedIdentifier = encodeURIComponent(input.identifier);
        const cloneUrls = input.graspServers.map((server) =>
          graspRepositoryCloneUrl(
            server.serviceAddress,
            npub,
            encodedIdentifier,
          ),
        );
        const relayUrls = input.graspServers.map((server) => server.wsUrl);
        setState({ step: "checking-relays" });
        const retainedPublicTransaction = !input.private
          ? getPublicRepositoryCreationTransaction(pubkey, input.identifier)
          : undefined;
        const resumablePublicTransaction =
          retainedPublicTransaction &&
          sameStringSet(retainedPublicTransaction.cloneUrls, cloneUrls) &&
          sameStringSet(
            retainedPublicTransaction.relayUrls.map(normalizeUrl),
            relayUrls.map(normalizeUrl),
          )
            ? retainedPublicTransaction
            : undefined;
        if (!input.private) {
          await assertNewPublicRepositoryCoordinatesAvailable(
            pubkey,
            input.identifier,
            cloneUrls,
            relayUrls,
            resumablePublicTransaction
              ? {
                  announcementId: resumablePublicTransaction.announcement.id,
                  stateId: resumablePublicTransaction.state.id,
                }
              : undefined,
          );
        }
        if (abort.signal.aborted) return;

        // A retained transaction is only a recovery token. The focused check
        // above must first rediscover either no collision or its exact signed
        // state before a reload is allowed to resume side effects.
        if (resumablePublicTransaction) {
          publicRetryRef.current = resumablePublicTransaction;
          const publishedAt = await completePublicCreationTransaction(
            resumablePublicTransaction,
            abort.signal,
            (step, acceptedAt) =>
              setState({
                step,
                publishedAt: acceptedAt,
                commitHash: resumablePublicTransaction.commitHash,
                identifier: resumablePublicTransaction.identifier,
              }),
          );
          clearPublicRepositoryCreationTransaction(
            pubkey,
            input.identifier,
            resumablePublicTransaction.state.id,
          );
          setState({
            step: "done",
            cloneUrl: resumablePublicTransaction.cloneUrls[0],
            commitHash: resumablePublicTransaction.commitHash,
            identifier: resumablePublicTransaction.identifier,
            publishedAt,
          });
          return;
        }

        // ── Step 1: Build git objects ──────────────────────────────────
        setState({ step: "building-commit" });

        const authorName =
          profile?.displayName ?? profile?.name ?? npub.slice(0, 16);

        const { commitHash, packfile } = await createInitialCommit({
          repoName: input.name,
          description: input.description || undefined,
          authorName,
          npub,
        });

        if (abort.signal.aborted) return;

        // ── Step 2: Sign Nostr events ─────────────────────────────────
        setState({ step: "signing-events" });

        const privateList = privateGitRelayList$.getValue();
        if (
          input.private &&
          (privateList.status !== "ready" ||
            privateList.pubkey !== pubkey ||
            !relayUrls.every((relay) => privateList.relayUrls.includes(relay)))
        ) {
          throw new Error(
            "The selected private service is no longer in your encrypted list",
          );
        }

        let privateAuthorization:
          | ReturnType<typeof createGitHttpAuthorizationProvider>
          | undefined;
        if (input.private) {
          const server = input.graspServers[0];
          const document = await fetchGraspServerInformation(
            server.serviceAddress,
            AbortSignal.any([abort.signal, AbortSignal.timeout(8_000)]),
          );
          if (
            !(document.supported_grasps ?? []).some(
              (grasp) => grasp.trim().toUpperCase() === "GRASP-08",
            )
          ) {
            throw new Error(
              `${server.serviceAddress} does not advertise GRASP-08 creation support`,
            );
          }
          privateAuthorization = createGitHttpAuthorizationProvider(
            pubkey,
            account.signer,
            cloneUrls,
            String(privateList.generation),
          );
          await verifyPrivateGraspService(
            cloneUrls[0],
            relayUrls[0],
            privateAuthorization,
            account.signer,
            abort.signal,
          );
          const existing = await firstValueFrom(
            resilientRequest(
              pool,
              [relayUrls[0]],
              [
                {
                  kinds: [30_617],
                  authors: [pubkey],
                  "#d": [input.identifier],
                },
              ],
              { retryCount: 1, paginate: false },
            ).pipe(onlyEvents(), toArray(), timeout(10_000)),
          );
          if (existing.length > 0) {
            throw new Error(
              "This private repository identifier already exists on the selected service",
            );
          }
        }

        // Build + sign both events using typed factories
        const signedAnnouncement = await RepoAnnouncementFactory.create(
          input.identifier,
          input.name,
          input.description,
          cloneUrls,
          relayUrls,
          commitHash,
          !!input.private,
        ).sign(account.signer);

        const signedState = await RepoStateFactory.create(
          input.identifier,
          commitHash,
          "main",
        ).sign(account.signer);

        if (abort.signal.aborted) return;

        if (input.private) {
          const currentList = privateGitRelayList$.getValue();
          if (
            currentList.generation !== privateList.generation ||
            currentList.pubkey !== pubkey ||
            !currentList.relayUrls.includes(relayUrls[0])
          ) {
            throw new Error(
              "The private service list changed while the repository was being created",
            );
          }
          privateRetryRef.current = {
            generation: privateList.generation,
            pubkey,
            relayUrl: relayUrls[0],
            cloneUrl: cloneUrls[0],
            identifier: input.identifier,
            commitHash,
            packfile,
            announcement: signedAnnouncement,
            state: signedState,
          };
        } else {
          const transaction: PublicRepositoryCreationTransaction = {
            pubkey,
            identifier: input.identifier,
            commitHash,
            cloneUrls,
            relayUrls,
            packfile,
            announcement: signedAnnouncement,
            state: signedState,
            createdAt: Date.now(),
          };
          publicRetryRef.current = transaction;
          savePublicRepositoryCreationTransaction(transaction);
          const publishedAt = await completePublicCreationTransaction(
            transaction,
            abort.signal,
            (step, acceptedAt) =>
              setState({
                step,
                publishedAt: acceptedAt,
                commitHash,
                identifier: input.identifier,
              }),
          );
          clearPublicRepositoryCreationTransaction(
            pubkey,
            input.identifier,
            signedState.id,
          );
          setState({
            step: "done",
            cloneUrl: cloneUrls[0],
            commitHash,
            identifier: input.identifier,
            publishedAt,
          });
          return;
        }

        // ── Step 3: Publish announcement ──────────────────────────────
        setState({
          step: "publishing-announcement",
          ...(input.private
            ? {
                publishedAt: Date.now(),
                commitHash,
                identifier: input.identifier,
              }
            : {}),
        });

        // Publish to Grasp relays directly and await pre-push acceptance.
        // A purgatory response means staging; a plain OK may already be public.
        const graspRelayUrls = input.graspServers.map((s) => s.wsUrl);

        await publishToGraspRelays(
          signedAnnouncement,
          graspRelayUrls,
          abort.signal,
        );

        if (!input.private) {
          // Public repositories remain discoverable through the normal index.
          await outboxStore.publish(signedAnnouncement, [
            `outbox:${pubkey}`,
            "git-index",
            "fallback-relays",
          ]);
        }

        if (input.private) markPrivateRelayEvent(signedAnnouncement);
        eventStore.add(signedAnnouncement);

        if (abort.signal.aborted) return;

        // ── Step 4: Publish state ─────────────────────────────────────
        setState((previous) => ({
          ...previous,
          step: "publishing-state",
        }));

        await publishToGraspRelays(signedState, graspRelayUrls, abort.signal);

        if (input.private) {
          markPrivateRelayEvent(signedState);
          eventStore.add(signedState);
        }

        const publishedAt = Date.now();

        if (abort.signal.aborted) return;

        // ── Step 5: Push packfile to ALL Grasp servers ─────────────────
        setState({
          step: "pushing",
          publishedAt,
          commitHash,
          identifier: input.identifier,
        });

        const refUpdates: RefUpdate[] = [
          {
            oldHash: ZERO_HASH,
            newHash: commitHash,
            refName: "refs/heads/main",
          },
        ];

        // Push to every Grasp server in parallel. Each server that accepted the
        // state needs the corresponding Git data whether it staged or
        // immediately broadcast that event.
        const pushResults = await Promise.allSettled(
          cloneUrls.map((url) =>
            pushToGitServer(
              url,
              refUpdates,
              packfile,
              abort.signal,
              privateAuthorization
                ? (repoUrl) =>
                    gitAuthorizationHeaders(
                      privateAuthorization,
                      repoUrl,
                      abort.signal,
                    )
                : undefined,
            ),
          ),
        );

        // Collect errors — at least one server must succeed
        const errors: string[] = [];
        let anySuccess = false;

        for (let i = 0; i < pushResults.length; i++) {
          const result = pushResults[i];
          const url = cloneUrls[i];

          if (result.status === "rejected") {
            errors.push(
              `${url}: ${result.reason instanceof Error ? result.reason.message : String(result.reason)}`,
            );
            continue;
          }

          const pushResult = result.value;
          if (!pushResult.unpackOk) {
            errors.push(
              `${url}: ${
                pushResult.serverError
                  ? `server rejected push: ${pushResult.serverError}`
                  : `unpack failed${pushResult.unpackStatus ? `: ${pushResult.unpackStatus}` : ""}`
              }`,
            );
            continue;
          }

          const failedRefs = pushResult.refResults.filter((r) => !r.ok);
          if (failedRefs.length > 0) {
            const reasons = failedRefs
              .map((r) => `${r.refName}: ${r.reason ?? "unknown"}`)
              .join(", ");
            errors.push(`${url}: ${reasons}`);
            continue;
          }

          anySuccess = true;
        }

        if (!anySuccess) {
          throw new Error(
            `Git push failed on all servers:\n${errors.join("\n")}`,
          );
        }

        if (!input.private) {
          // Purgatory-capable GRASP relays may withhold the state from reads;
          // other implementations may already expose it. Broadcast only after
          // Git data exists, never by querying for an echo between relay
          // acknowledgement and the push.
          await outboxStore.publish(signedState, [
            `outbox:${pubkey}`,
            repoCoordinate(pubkey, input.identifier),
            "fallback-relays",
          ]);
        }

        // Use the first clone URL as the canonical one for display
        const primaryCloneUrl = cloneUrls[0];
        if (input.private) {
          const coordinate = repoCoordinate(pubkey, input.identifier);
          installPrivateRepositoryRelays([coordinate], relayUrls);
        }

        // ── Done ──────────────────────────────────────────────────────
        setState({
          step: "done",
          cloneUrl: primaryCloneUrl,
          commitHash,
          identifier: input.identifier,
          publishedAt,
        });
      } catch (err) {
        if (abort.signal.aborted) return;

        const message =
          err instanceof Error ? err.message : "An unknown error occurred";
        setState((prev) => ({
          ...prev,
          step: "error",
          error: message,
        }));
      }
    },
    [account, pubkey, npub, profile],
  );

  /**
   * Retry just the push step. Only valid when the previous attempt failed
   * after the events received pre-push relay acceptance. They may be staged in
   * purgatory or already visible, depending on the GRASP implementation.
   */
  const retryPush = useCallback(
    async (input: CreateRepoFormInput, commitHash: string) => {
      if (!account || !pubkey) {
        setState((prev) => ({
          ...prev,
          step: "error",
          error: "Not logged in",
        }));
        return;
      }

      const abort = new AbortController();
      abortRef.current = abort;

      try {
        if (input.private) {
          const transaction = privateRetryRef.current;
          const list = privateGitRelayList$.getValue();
          if (
            !transaction ||
            transaction.commitHash !== commitHash ||
            transaction.pubkey !== pubkey ||
            list.generation !== transaction.generation ||
            list.pubkey !== pubkey ||
            !list.relayUrls.includes(transaction.relayUrl)
          ) {
            throw new Error(
              "The private creation session changed; start the repository creation again",
            );
          }
          setState((prev) => ({
            ...prev,
            step: "publishing-announcement",
            error: undefined,
          }));
          const authorization = createGitHttpAuthorizationProvider(
            pubkey,
            account.signer,
            [transaction.cloneUrl],
            String(transaction.generation),
          );
          await verifyPrivateGraspService(
            transaction.cloneUrl,
            transaction.relayUrl,
            authorization,
            account.signer,
            abort.signal,
          );
          await publishToGraspRelays(
            transaction.announcement,
            [transaction.relayUrl],
            abort.signal,
          );
          setState((prev) => ({ ...prev, step: "publishing-state" }));
          await publishToGraspRelays(
            transaction.state,
            [transaction.relayUrl],
            abort.signal,
          );
          setState((prev) => ({
            ...prev,
            step: "pushing",
            publishedAt: Date.now(),
          }));
          const pushResult = await pushToGitServer(
            transaction.cloneUrl,
            [
              {
                oldHash: ZERO_HASH,
                newHash: transaction.commitHash,
                refName: "refs/heads/main",
              },
            ],
            transaction.packfile,
            abort.signal,
            (repoUrl) =>
              gitAuthorizationHeaders(authorization, repoUrl, abort.signal),
          );
          if (
            !pushResult.unpackOk ||
            pushResult.refResults.some((result) => !result.ok)
          ) {
            throw new Error(
              pushResult.serverError ??
                pushResult.unpackStatus ??
                "The private Git server rejected the retry",
            );
          }
          installPrivateRepositoryRelays(
            [repoCoordinate(pubkey, transaction.identifier)],
            [transaction.relayUrl],
          );
          setState({
            step: "done",
            cloneUrl: transaction.cloneUrl,
            commitHash: transaction.commitHash,
            identifier: transaction.identifier,
            publishedAt: Date.now(),
          });
          return;
        }
        const transaction = publicRetryRef.current;
        if (
          !transaction ||
          transaction.pubkey !== pubkey ||
          transaction.identifier !== input.identifier ||
          transaction.commitHash !== commitHash
        ) {
          throw new Error(
            "The repository creation session changed; start creation again",
          );
        }
        const publishedAt = await completePublicCreationTransaction(
          transaction,
          abort.signal,
          (step, acceptedAt) =>
            setState({
              step,
              publishedAt: acceptedAt,
              commitHash: transaction.commitHash,
              identifier: transaction.identifier,
            }),
        );
        clearPublicRepositoryCreationTransaction(
          transaction.pubkey,
          transaction.identifier,
          transaction.state.id,
        );

        setState({
          step: "done",
          cloneUrl: transaction.cloneUrls[0],
          commitHash: transaction.commitHash,
          identifier: transaction.identifier,
          publishedAt,
        });
      } catch (err) {
        if (abort.signal.aborted) return;
        const message =
          err instanceof Error ? err.message : "An unknown error occurred";
        setState((prev) => ({ ...prev, step: "error", error: message }));
      }
    },
    [account, pubkey],
  );

  return {
    state,
    execute,
    retryPush,
    reset,
  };
}

// ---------------------------------------------------------------------------
// Helpers
// ---------------------------------------------------------------------------

function sameStringSet(first: string[], second: string[]): boolean {
  const a = [...new Set(first)].sort();
  const b = [...new Set(second)].sort();
  return a.length === b.length && a.every((value, index) => value === b[index]);
}

async function completePublicCreationTransaction(
  transaction: PublicRepositoryCreationTransaction,
  signal: AbortSignal,
  onProgress: (step: CreateRepoStep, publishedAt?: number) => void,
): Promise<number> {
  // Re-arm both signed events. A purgatory server may have expired either one;
  // a non-purgatory server simply acknowledges its visible copies again.
  onProgress("publishing-announcement");
  await publishToGraspRelays(
    transaction.announcement,
    transaction.relayUrls,
    signal,
  );
  if (signal.aborted) throw new DOMException("Aborted", "AbortError");
  await outboxStore.publish(transaction.announcement, [
    `outbox:${transaction.pubkey}`,
    "git-index",
    "fallback-relays",
  ]);
  eventStore.add(transaction.announcement);

  onProgress("publishing-state");
  await publishToGraspRelays(transaction.state, transaction.relayUrls, signal);
  if (signal.aborted) throw new DOMException("Aborted", "AbortError");
  const publishedAt = Date.now();
  onProgress("pushing", publishedAt);

  const refUpdates: RefUpdate[] = [
    {
      oldHash: ZERO_HASH,
      newHash: transaction.commitHash,
      refName: "refs/heads/main",
    },
  ];
  const pushResults = await Promise.allSettled(
    transaction.cloneUrls.map((url) =>
      pushToGitServer(url, refUpdates, transaction.packfile, signal),
    ),
  );

  const errors: string[] = [];
  let anySuccess = false;
  for (let i = 0; i < pushResults.length; i++) {
    const result = pushResults[i];
    const url = transaction.cloneUrls[i];
    if (result.status === "rejected") {
      errors.push(
        `${url}: ${result.reason instanceof Error ? result.reason.message : String(result.reason)}`,
      );
      continue;
    }
    if (!result.value.unpackOk) {
      errors.push(
        `${url}: ${
          result.value.serverError
            ? `server rejected push: ${result.value.serverError}`
            : `unpack failed${result.value.unpackStatus ? `: ${result.value.unpackStatus}` : ""}`
        }`,
      );
      continue;
    }
    const failedRefs = result.value.refResults.filter(({ ok }) => !ok);
    if (failedRefs.length > 0) {
      errors.push(
        `${url}: ${failedRefs.map(({ reason }) => reason ?? "unknown").join(", ")}`,
      );
      continue;
    }
    anySuccess = true;
  }
  if (!anySuccess) {
    throw new Error(`Git push failed on all servers:\n${errors.join("\n")}`);
  }

  await outboxStore.publish(transaction.state, [
    `outbox:${transaction.pubkey}`,
    repoCoordinate(transaction.pubkey, transaction.identifier),
    "fallback-relays",
  ]);
  return publishedAt;
}

/**
 * Publish an event to Grasp relays and await at least one successful response.
 * Throws if all relays reject the event.
 */
async function publishToGraspRelays(
  event: NostrEvent,
  relayUrls: string[],
  signal: AbortSignal,
): Promise<void> {
  if (relayUrls.length === 0) {
    throw new Error("No Grasp relay URLs provided");
  }

  // Use the pool to publish and collect responses
  const responses = await pool.publish(relayUrls, event);

  // Check if aborted during publish
  if (signal.aborted) return;

  // Check if at least one relay accepted the event
  const accepted = responses.filter((r) => r.ok);
  if (accepted.length === 0) {
    const reasons = responses
      .map((r) => `${r.from}: ${r.message ?? "rejected"}`)
      .join("; ");
    throw new Error(`All Grasp relays rejected the event: ${reasons}`);
  }
}
