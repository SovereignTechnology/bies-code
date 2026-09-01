/**
 * useGitPool — the single React hook for git-grasp-pool.
 *
 * Subscribes to a GitGraspPool for the given clone URLs and returns the
 * reactive PoolState plus the pool instance for imperative operations
 * (getTree, getBlob, getSingleCommit, etc.).
 *
 * Multiple components calling this hook with the same clone URLs share one
 * pool instance via the registry. The pool's fetch is triggered on first
 * subscribe and kept alive for the component's lifetime.
 *
 * State event integration:
 *   Pass knownHeadCommit + stateRefs + stateCreatedAt from the Nostr state
 *   event (kind:30618). The hook builds a BehaviorSubject internally and
 *   pushes updates into it whenever those values change — the pool reacts
 *   to the observable and schedules re-fetches as needed.
 */

import { useState, useEffect, useRef, useMemo } from "react";
import { BehaviorSubject } from "rxjs";
import { getOrCreatePool } from "@/lib/git-grasp-pool";
import type {
  GitGraspPool,
  PoolState,
  StateEventInput,
  StateEvent,
} from "@/lib/git-grasp-pool";
import type { RepoStateRef } from "@/lib/nip34";
import { useAccount } from "@/hooks/useAccount";
import {
  getOrCreateGitHttpAuthorizationProvider,
  privateGitServiceRelayUrl,
  type GitHttpAuthorizationProvider,
} from "@/lib/git-http-auth";
import { classifyPrivateGitServiceRelay } from "@/lib/grasp";
import { verifyPrivateGraspEndpointCached } from "@/lib/private-grasp";
import { privateGitRelayList$ } from "@/services/privateGitRelays";
import { isTrustedPrivateRepositoryRelay } from "@/services/privateRepositoryScope";
import { use$ } from "@/hooks/use$";

// ---------------------------------------------------------------------------
// Options
// ---------------------------------------------------------------------------

export interface UseGitPoolOptions {
  /** Authenticate Git HTTP and isolate caches for this account/repository. */
  private?: boolean;
  /** Full ref name that the state event declares as HEAD. */
  headRef?: string;
  /**
   * HEAD commit declared by the Nostr state event (kind:30618).
   * undefined = still loading from relays; omit when no state event exists.
   */
  knownHeadCommit?: string;
  /** All refs declared by the state event. */
  stateRefs?: RepoStateRef[];
  /** created_at of the state event (seconds). */
  stateCreatedAt?: number;
  /**
   * Keep retrying an empty Git endpoint while GRASP provisions this repo.
   * Intended for newly published repository announcements.
   */
  expectRepositoryProvisioning?: boolean;
}

// ---------------------------------------------------------------------------
// Initial state helper
// ---------------------------------------------------------------------------

function makeInitialState(
  hasUrls: boolean,
  error: string | null = null,
): PoolState {
  return {
    urls: {},
    winnerUrl: null,
    health: "idle",
    loading: hasUrls,
    pulling: false,
    latestCommit: null,
    readmeContent: null,
    readmeFilename: null,
    defaultBranch: null,
    warning: null,
    authoritativeRefs: {},
    authoritativeHead: null,
    viewSource: "authoritative",
    effectiveRefs: {},
    error,
    lastCheckedAt: null,
    crossRefDiscrepancies: [],
    retryAt: null,
  };
}

// ---------------------------------------------------------------------------
// Hook
// ---------------------------------------------------------------------------

export interface UseGitPoolResult {
  /** Reactive snapshot of the pool state — updates as data arrives. */
  poolState: PoolState;
  /**
   * The pool instance for imperative operations (getTree, getBlob, etc.).
   * Stable reference — safe to use in useEffect dependency arrays.
   * null only when cloneUrls is empty.
   */
  pool: GitGraspPool | null;
  /** Why an authenticated private Git pool could not be opened. */
  privateAccessError?: string;
}

interface KeyedPoolState {
  key: string;
  state: PoolState;
}

interface VerifiedPrivateGitAccess {
  key: string;
  cloneUrls: string[];
  authorizationProvider?: GitHttpAuthorizationProvider;
  error?: string;
}

/**
 * Subscribe to a GitGraspPool for the given clone URLs.
 *
 * Returns reactive PoolState and the pool instance for imperative git ops.
 * Multiple hook instances with the same clone URLs share one pool.
 */
export function useGitPool(
  cloneUrls: string[],
  options: UseGitPoolOptions = {},
): UseGitPoolResult {
  const {
    knownHeadCommit,
    headRef,
    stateRefs,
    stateCreatedAt,
    expectRepositoryProvisioning,
  } = options;
  const account = useAccount();
  const privateRelayList = use$(privateGitRelayList$);
  const cloneUrlsKey = cloneUrls.join(",");
  const privateAccessKey = options.private
    ? `${privateRelayList.generation}:${account?.pubkey ?? "logged-out"}:${cloneUrlsKey}`
    : "public";
  const [verifiedPrivateAccess, setVerifiedPrivateAccess] =
    useState<VerifiedPrivateGitAccess>();

  useEffect(() => {
    if (!options.private) {
      setVerifiedPrivateAccess(undefined);
      return;
    }
    if (!account) {
      setVerifiedPrivateAccess({
        key: privateAccessKey,
        cloneUrls: [],
        error: "Log in to access this private repository's Git data.",
      });
      return;
    }
    if (cloneUrls.length === 0) {
      setVerifiedPrivateAccess({
        key: privateAccessKey,
        cloneUrls: [],
        error: "This private repository does not announce a Git server.",
      });
      return;
    }

    const controller = new AbortController();
    void (async () => {
      try {
        const classifications = await Promise.allSettled(
          cloneUrls.map(async (cloneUrl) => {
            const relayUrl = privateGitServiceRelayUrl(cloneUrl);
            return relayUrl &&
              isTrustedPrivateRepositoryRelay(relayUrl) &&
              (await classifyPrivateGitServiceRelay(relayUrl))
              ? cloneUrl
              : undefined;
          }),
        );
        const classifiedRoots = classifications.flatMap((result) =>
          result.status === "fulfilled" && result.value ? [result.value] : [],
        );
        if (controller.signal.aborted) return;
        if (classifiedRoots.length === 0) {
          setVerifiedPrivateAccess({
            key: privateAccessKey,
            cloneUrls: [],
            error:
              "No announced Git server could be verified as an admitted GRASP-08 or Buzz private service.",
          });
          return;
        }

        const candidateProvider = getOrCreateGitHttpAuthorizationProvider(
          account.pubkey,
          account.signer,
          classifiedRoots,
          String(privateRelayList.generation),
        );
        const challenges = await Promise.allSettled(
          classifiedRoots.map(async (cloneUrl) => {
            await verifyPrivateGraspEndpointCached(
              cloneUrl,
              candidateProvider,
              controller.signal,
            );
            return cloneUrl;
          }),
        );
        const acceptedRoots = challenges.flatMap((result) =>
          result.status === "fulfilled" ? [result.value] : [],
        );
        if (controller.signal.aborted) return;
        if (acceptedRoots.length === 0) {
          const firstFailure = challenges.find(
            (result) => result.status === "rejected",
          );
          const reason =
            firstFailure?.status === "rejected" &&
            firstFailure.reason instanceof Error
              ? ` ${firstFailure.reason.message}`
              : "";
          setVerifiedPrivateAccess({
            key: privateAccessKey,
            cloneUrls: [],
            error: `This account was not accepted by any announced private Git server.${reason}`,
          });
          return;
        }
        setVerifiedPrivateAccess({
          key: privateAccessKey,
          cloneUrls: acceptedRoots,
          authorizationProvider: getOrCreateGitHttpAuthorizationProvider(
            account.pubkey,
            account.signer,
            acceptedRoots,
            String(privateRelayList.generation),
          ),
        });
      } catch (error) {
        if (controller.signal.aborted) return;
        setVerifiedPrivateAccess({
          key: privateAccessKey,
          cloneUrls: [],
          error:
            error instanceof Error
              ? error.message
              : "Private Git access verification failed.",
        });
      }
    })();

    return () => controller.abort();
    // The structural key deliberately owns all account, session, and URL
    // transitions. cloneUrls is reconstructed by repository casts.
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [privateAccessKey, options.private]);

  const activePrivateAccess =
    verifiedPrivateAccess?.key === privateAccessKey
      ? verifiedPrivateAccess
      : undefined;
  const authorizationProvider = activePrivateAccess?.authorizationProvider;
  const privateAccessError = activePrivateAccess?.error;
  const effectiveCloneUrls = options.private
    ? (activePrivateAccess?.cloneUrls ?? [])
    : cloneUrls;
  const urlsKey = `${authorizationProvider?.accessScope ?? "public"}:${effectiveCloneUrls.join(",")}:${privateAccessError ?? ""}`;

  // Stable key for the state event so we can detect changes without
  // deep-comparing the refs array on every render.
  const refsKey = stateRefs
    ? stateRefs
        .map((r) => `${r.name}:${r.commitId}`)
        .sort()
        .join(",")
    : "";

  // Build the StateEvent value from options.
  // undefined = still loading (no head commit yet)
  // null = confirmed no state event (not used here — callers just omit options)
  const currentStateEvent = useMemo<StateEventInput>(() => {
    if (!knownHeadCommit) return undefined;
    const refs = stateRefs ?? [];
    if (refs.length === 0) return undefined;
    return {
      headRef,
      headCommitId: knownHeadCommit,
      refs: refs.map((r) => ({ name: r.name, commitId: r.commitId })),
      createdAt: stateCreatedAt ?? 0,
    } satisfies StateEvent;
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [knownHeadCommit, headRef, refsKey, stateCreatedAt]);

  // The BehaviorSubject lives for the lifetime of the subscription (tied to
  // urlsKey). We push new state event values into it whenever they change.
  const stateSubjectRef = useRef<BehaviorSubject<StateEventInput> | null>(null);

  // Push state event updates synchronously (before effects run) so the pool
  // sees the latest value as soon as it changes.
  const stateEventKey = `${headRef ?? ""}|${knownHeadCommit ?? ""}|${refsKey}|${stateCreatedAt ?? ""}`;
  const prevStateEventKey = useRef<string>("");
  if (stateEventKey !== prevStateEventKey.current) {
    prevStateEventKey.current = stateEventKey;
    stateSubjectRef.current?.next(currentStateEvent);
  }

  const [poolSnapshot, setPoolSnapshot] = useState<KeyedPoolState>(() => ({
    key: urlsKey,
    state: makeInitialState(
      effectiveCloneUrls.length > 0,
      privateAccessError ?? null,
    ),
  }));

  // Stable pool ref — updated inside the effect, read by callers.
  const poolRef = useRef<GitGraspPool | null>(null);
  const poolKeyRef = useRef<string | null>(null);

  useEffect(() => {
    if (effectiveCloneUrls.length === 0) {
      setPoolSnapshot({
        key: urlsKey,
        state: makeInitialState(false, privateAccessError ?? null),
      });
      stateSubjectRef.current = null;
      poolRef.current = null;
      poolKeyRef.current = null;
      return;
    }

    // Fresh subject seeded with the current state event value.
    const subject = new BehaviorSubject<StateEventInput>(currentStateEvent);
    stateSubjectRef.current = subject;

    const pool = getOrCreatePool({
      cloneUrls: effectiveCloneUrls,
      stateEvent$: subject.asObservable(),
      expectRepositoryProvisioning,
      authorizationProvider,
    });
    poolRef.current = pool;
    poolKeyRef.current = urlsKey;

    // pool.subscribe() triggers the initial fetch and delivers current state
    // immediately, then calls back on every subsequent update.
    const unsubscribe = pool.subscribe((newState) => {
      setPoolSnapshot({ key: urlsKey, state: newState });
    });

    return () => {
      unsubscribe();
      if (
        authorizationProvider &&
        pool.subscriberCount === 0 &&
        !pool.isDisposed
      ) {
        pool.dispose();
      }
      stateSubjectRef.current = null;
      // Don't complete the subject — the pool may still be alive for other
      // subscribers. Just drop our reference.
    };
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [urlsKey, expectRepositoryProvisioning]);

  const poolState =
    poolSnapshot.key === urlsKey
      ? poolSnapshot.state
      : makeInitialState(
          effectiveCloneUrls.length > 0,
          privateAccessError ?? null,
        );
  const pool = poolKeyRef.current === urlsKey ? poolRef.current : null;

  return { poolState, pool, privateAccessError };
}
