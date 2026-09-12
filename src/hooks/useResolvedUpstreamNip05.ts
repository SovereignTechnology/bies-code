import { useMemo } from "react";
import { repoCoordinate, type RepoUpstream } from "@/lib/nip34";
import type { PendingNip05Upstream } from "@/lib/repoUpstreamInput";
import { useDnsIdentity } from "@/hooks/useDnsIdentity";
import type { ErrorRetryState } from "@/hooks/useErrorRetry";

export type UpstreamNip05Status = "idle" | "loading" | "not-found" | "error";

export function useResolvedUpstreamNip05(
  pending: PendingNip05Upstream | undefined,
): {
  status: UpstreamNip05Status;
  resolvedUpstream: RepoUpstream | undefined;
  recovery: ErrorRetryState;
} {
  const identity = useDnsIdentity(pending?.nip05);
  const pubkey = identity.status === "found" ? identity.pubkey : undefined;
  const resolvedUpstream = useMemo(
    () =>
      pending && pubkey
        ? {
            repository: repoCoordinate(pubkey, pending.repoId),
            relayHint: pending.relayHint,
            authorPubkey: pubkey,
            gitUrl: pending.gitUrl,
          }
        : undefined,
    [pending, pubkey],
  );
  return {
    status: !pending || identity.status === "found" ? "idle" : identity.status,
    resolvedUpstream,
    recovery: identity.recovery,
  };
}
