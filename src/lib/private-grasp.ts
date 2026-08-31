import type { ISigner } from "applesauce-signers";
import { AuthRequiredError, Relay } from "applesauce-relay";
import { filter, firstValueFrom, take, timeout } from "rxjs";

import {
  gitAuthorizationHeaders,
  type GitHttpAuthorizationProvider,
} from "@/lib/git-http-auth";

const RELAY_PREFLIGHT_TIMEOUT_MS = 10_000;

function boundedSignal(signal?: AbortSignal): AbortSignal {
  const timeoutSignal = AbortSignal.timeout(RELAY_PREFLIGHT_TIMEOUT_MS);
  return signal ? AbortSignal.any([signal, timeoutSignal]) : timeoutSignal;
}

/** Prove anonymous denial and account membership at one private Git root. */
export async function verifyPrivateGraspEndpoint(
  repoUrl: string,
  authorizationProvider: GitHttpAuthorizationProvider,
  signal?: AbortSignal,
): Promise<void> {
  const requestSignal = boundedSignal(signal);
  const anonymous = await fetch(repoUrl, {
    method: "GET",
    redirect: "error",
    signal: requestSignal,
  });
  const challenge = anonymous.headers.get("WWW-Authenticate");
  const anonymousBody = await anonymous.arrayBuffer();
  if (
    anonymous.status !== 401 ||
    anonymousBody.byteLength !== 0 ||
    !challenge ||
    !/^Nostr(?:\s|$)/i.test(challenge) ||
    !/(?:^|[,\s])method="GET"(?:[,\s]|$)/.test(challenge)
  ) {
    throw new Error(
      `${repoUrl} did not return the required empty GRASP-08 Nostr GET challenge`,
    );
  }

  const headers = await gitAuthorizationHeaders(
    authorizationProvider,
    repoUrl,
    requestSignal,
  );
  const authenticated = await fetch(repoUrl, {
    method: "GET",
    headers,
    redirect: "error",
    signal: requestSignal,
  });
  if (authenticated.status !== 200 && authenticated.status !== 404) {
    throw new Error(
      `${repoUrl} did not accept this account as a private GRASP member (authenticated GET returned ${authenticated.status})`,
    );
  }
}

/** Prove the paired relay rejects anonymous reads and accepts NIP-42. */
export async function verifyPrivateGraspRelay(
  relayUrl: string,
  signer: ISigner,
  signal?: AbortSignal,
): Promise<void> {
  if (signal?.aborted) throw new DOMException("Aborted", "AbortError");
  const relay = new Relay(relayUrl, {
    eventTimeout: RELAY_PREFLIGHT_TIMEOUT_MS,
    requestReconnect: 0,
  });
  const onAbort = () => relay.close();
  signal?.addEventListener("abort", onAbort, { once: true });

  try {
    let rejectedAnonymously = false;
    try {
      await firstValueFrom(
        relay
          .req(
            { kinds: [30_617], limit: 1 },
            { waitForAuth: false, reconnect: false },
          )
          .pipe(
            filter((message) => message.type !== "OPEN"),
            take(1),
            timeout(RELAY_PREFLIGHT_TIMEOUT_MS),
          ),
      );
    } catch (error) {
      rejectedAnonymously =
        error instanceof AuthRequiredError ||
        (error instanceof Error && /^auth-required:/i.test(error.message));
      if (!rejectedAnonymously) throw error;
    }
    if (!rejectedAnonymously || !relay.challenge) {
      throw new Error(
        `${relayUrl} did not reject an anonymous repository request with a NIP-42 challenge`,
      );
    }

    const auth = await relay.authenticate(signer);
    if (!auth.ok || !relay.authentication) {
      throw new Error(
        `${relayUrl} did not accept this account's NIP-42 authentication`,
      );
    }
    await firstValueFrom(
      relay
        .req(
          { kinds: [30_617], limit: 1 },
          { waitForAuth: false, reconnect: false },
        )
        .pipe(
          filter(
            (message) => message.type === "EVENT" || message.type === "EOSE",
          ),
          take(1),
          timeout(RELAY_PREFLIGHT_TIMEOUT_MS),
        ),
    );
  } finally {
    signal?.removeEventListener("abort", onAbort);
    relay.close();
  }
}

export async function verifyPrivateGraspService(
  repoUrl: string,
  relayUrl: string,
  authorizationProvider: GitHttpAuthorizationProvider,
  signer: ISigner,
  signal?: AbortSignal,
): Promise<void> {
  await Promise.all([
    verifyPrivateGraspEndpoint(repoUrl, authorizationProvider, signal),
    verifyPrivateGraspRelay(relayUrl, signer, signal),
  ]);
}
