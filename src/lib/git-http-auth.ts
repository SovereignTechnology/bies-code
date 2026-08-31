import type { ISigner } from "applesauce-signers";
import { nip98, verifyEvent } from "nostr-tools";
import { graspServiceAddressToRelayUrl } from "@/lib/grasp";
import { graspCloneUrlServiceAddress } from "@/lib/nip34";

/** Supplies repository-root GRASP-08/Buzz credentials to Smart HTTP calls. */
export interface GitHttpAuthorizationProvider {
  /** Separates authenticated pools and their in-memory caches by account. */
  readonly accessScope: string;
  getAuthorization(repoUrl: string, signal?: AbortSignal): Promise<string>;
}

interface CachedCredential {
  authorization: string;
  expiresAt: number;
}

// GRASP-08 accepts a NIP-98 event for 60 seconds. Reserve five seconds for
// transport and clock skew, and derive expiry from the timestamp the signer
// actually returned (remote signers can take a noticeable amount of time).
const CREDENTIAL_EXPIRY_MARGIN_MS = 5_000;

function abortError(signal: AbortSignal): Error {
  return signal.reason instanceof Error
    ? signal.reason
    : new DOMException("Aborted", "AbortError");
}

function throwIfAborted(signal?: AbortSignal): void {
  if (signal?.aborted) throw abortError(signal);
}

function waitForAuthorization(
  credential: Promise<string>,
  signal?: AbortSignal,
): Promise<string> {
  if (!signal) return credential;
  throwIfAborted(signal);
  return new Promise((resolve, reject) => {
    const onAbort = () => reject(abortError(signal));
    signal.addEventListener("abort", onAbort, { once: true });
    credential.then(
      (authorization) => {
        signal.removeEventListener("abort", onAbort);
        if (signal.aborted) reject(abortError(signal));
        else resolve(authorization);
      },
      (error) => {
        signal.removeEventListener("abort", onAbort);
        reject(error);
      },
    );
  });
}

/** Return the exact repository root used by GRASP-08 and Buzz NIP-98 checks. */
export function canonicalGitRepositoryUrl(repoUrl: string): string {
  const url = new URL(repoUrl);
  if (url.protocol !== "http:" && url.protocol !== "https:") {
    throw new Error("Private Git servers must use HTTP or HTTPS");
  }
  url.username = "";
  url.password = "";
  url.search = "";
  url.hash = "";
  // Inputs are announced repository roots. Do not guess from endpoint-looking
  // suffixes: `git-upload-pack` and `info/refs` are valid repository names.
  url.pathname = url.pathname.replace(/\/+$/, "");
  return url.toString().replace(/\/$/, "");
}

/**
 * Derive the private service relay that must independently advertise support
 * before credentials can be attached to an announced Git root.
 */
export function privateGitServiceRelayUrl(
  repositoryUrl: string,
): string | undefined {
  const graspService = graspCloneUrlServiceAddress(repositoryUrl);
  if (graspService) return graspServiceAddressToRelayUrl(graspService);

  try {
    const root = new URL(canonicalGitRepositoryUrl(repositoryUrl));
    const segments = root.pathname.split("/").filter(Boolean);
    // Buzz repository roots are /git/<hex-owner>/<channel-or-repo-id> and do
    // not have a .git suffix. Restrict this fallback to that exact shape so a
    // trusted relay origin cannot bless arbitrary sibling HTTP paths.
    if (
      segments.length !== 3 ||
      segments[0] !== "git" ||
      !/^[0-9a-f]{64}$/i.test(segments[1]) ||
      !segments[2]
    ) {
      return undefined;
    }
    root.protocol = root.protocol === "https:" ? "wss:" : "ws:";
    root.pathname = "";
    return root.toString().replace(/\/$/, "");
  } catch {
    return undefined;
  }
}

/**
 * Build an account-scoped reusable credential provider.
 *
 * GRASP-08 and Buzz deliberately require one repository-root token whose
 * NIP-98 `method` tag is GET for every Smart HTTP request, including POSTs.
 */
export function createGitHttpAuthorizationProvider(
  pubkey: string,
  signer: ISigner,
  repositoryUrls: readonly string[],
  sessionScope?: string,
): GitHttpAuthorizationProvider {
  const cache = new Map<string, CachedCredential>();
  const inFlight = new Map<string, Promise<string>>();
  const canonicalRoots = repositoryUrls.map(canonicalGitRepositoryUrl);
  const allowedRoots = new Set(canonicalRoots);
  if (allowedRoots.size === 0) {
    throw new Error(
      "Private Git authorization requires at least one allowed repository root",
    );
  }

  return {
    accessScope: `private:${pubkey}:${sessionScope ?? "ephemeral"}:${canonicalRoots.sort().join("|")}`,
    async getAuthorization(
      repoUrl: string,
      signal?: AbortSignal,
    ): Promise<string> {
      throwIfAborted(signal);
      const canonicalUrl = canonicalGitRepositoryUrl(repoUrl);
      if (!allowedRoots.has(canonicalUrl)) {
        throw new Error(
          "Refusing to attach private Git authorization to an unverified repository root",
        );
      }
      const cached = cache.get(canonicalUrl);
      if (cached && cached.expiresAt > Date.now()) {
        throwIfAborted(signal);
        return cached.authorization;
      }

      const pending = inFlight.get(canonicalUrl);
      if (pending) return waitForAuthorization(pending, signal);

      let signedCreatedAt: number | undefined;
      const credential = nip98
        .getToken(
          canonicalUrl,
          "GET",
          async (template) => {
            throwIfAborted(signal);
            const event = await signer.signEvent(template);
            throwIfAborted(signal);
            const urls = event.tags.filter(([name]) => name === "u");
            const methods = event.tags.filter(([name]) => name === "method");
            if (
              !verifyEvent(event) ||
              event.pubkey !== pubkey ||
              event.kind !== 27_235 ||
              event.content !== "" ||
              urls.length !== 1 ||
              urls[0].length !== 2 ||
              urls[0][1] !== canonicalUrl ||
              methods.length !== 1 ||
              methods[0].length !== 2 ||
              methods[0][1] !== "GET" ||
              Math.abs(event.created_at - Math.floor(Date.now() / 1_000)) > 60
            ) {
              throw new Error(
                "The signer returned an invalid private Git authorization event",
              );
            }
            signedCreatedAt = event.created_at;
            return event;
          },
          true,
        )
        .then((authorization) => {
          throwIfAborted(signal);
          if (signedCreatedAt !== undefined) {
            const expiresAt = Math.min(
              (signedCreatedAt + 60) * 1_000 - CREDENTIAL_EXPIRY_MARGIN_MS,
              Date.now() + 60_000 - CREDENTIAL_EXPIRY_MARGIN_MS,
            );
            if (expiresAt > Date.now()) {
              cache.set(canonicalUrl, { authorization, expiresAt });
            }
          }
          return authorization;
        })
        .finally(() => inFlight.delete(canonicalUrl));

      inFlight.set(canonicalUrl, credential);
      return waitForAuthorization(credential, signal);
    },
  };
}

export async function gitAuthorizationHeaders(
  provider: GitHttpAuthorizationProvider | undefined,
  repoUrl: string,
  signal?: AbortSignal,
): Promise<Record<string, string> | undefined> {
  throwIfAborted(signal);
  if (!provider) return undefined;
  const authorization = await provider.getAuthorization(repoUrl, signal);
  throwIfAborted(signal);
  return { Authorization: authorization };
}
