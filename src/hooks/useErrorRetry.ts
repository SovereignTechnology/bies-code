import { useCallback, useEffect, useRef, useState } from "react";

/** Automatic retries are opt-in and only for reads known not to sign. */
export type ErrorRetryPolicy =
  | { mode: "manual" }
  | {
      mode: "read";
      requiresSigning: false;
      context: "connection" | "availability";
      /** Minimum server-requested delay, when available. */
      retryAfterMs?: number;
    };

const DELAYS = {
  connection: [5_000, 15_000, 30_000],
  availability: [15_000, 30_000, 60_000],
} as const;

export interface ErrorRetryState {
  retry: () => void;
  retrying: boolean;
  secondsRemaining: number | null;
  automatic: boolean;
  exhausted: boolean;
  waiting: boolean;
  paused: boolean;
  pause: () => void;
}

/** Keep this hook mounted in the operation owner, including while loading. */
export function useErrorRetry({
  resourceKey,
  failed,
  busy,
  onRetry,
  policy = { mode: "manual" },
}: {
  resourceKey: unknown;
  failed: boolean;
  busy: boolean;
  onRetry: (signal: AbortSignal) => void | Promise<unknown>;
  policy?: ErrorRetryPolicy;
}): ErrorRetryState {
  const latest = useRef({ resourceKey, failed, busy, onRetry, policy });
  latest.current = { resourceKey, failed, busy, onRetry, policy };
  const [attempts, setAttempts] = useState(0);
  const [retrying, setRetrying] = useState(false);
  const [paused, setPaused] = useState(false);
  const [deadline, setDeadline] = useState<number | null>(null);
  const [now, setNow] = useState(Date.now);
  const [available, setAvailable] = useState(
    () =>
      typeof document === "undefined" ||
      (document.visibilityState !== "hidden" && navigator.onLine),
  );
  const running = useRef(false);
  const controller = useRef<AbortController | null>(null);
  const generation = useRef(0);
  const mounted = useRef(false);

  useEffect(() => {
    mounted.current = true;
    return () => {
      mounted.current = false;
      controller.current?.abort();
    };
  }, []);

  useEffect(() => {
    generation.current++;
    controller.current?.abort();
    running.current = false;
    setAttempts(0);
    setPaused(false);
    setRetrying(false);
    setDeadline(null);
  }, [resourceKey]);

  useEffect(() => {
    if (!failed && !busy && !retrying && !running.current) {
      setAttempts(0);
      setPaused(false);
    }
  }, [failed, busy, retrying]);

  useEffect(() => {
    const update = () =>
      setAvailable(document.visibilityState !== "hidden" && navigator.onLine);
    document.addEventListener("visibilitychange", update);
    window.addEventListener("online", update);
    window.addEventListener("offline", update);
    return () => {
      document.removeEventListener("visibilitychange", update);
      window.removeEventListener("online", update);
      window.removeEventListener("offline", update);
    };
  }, []);

  const invoke = useCallback((automatic: boolean) => {
    const current = latest.current;
    if (running.current || current.busy || !current.failed) return;
    // Recheck the policy at execution time, including account changes.
    if (
      automatic &&
      (current.policy.mode !== "read" ||
        current.policy.requiresSigning !== false ||
        document.visibilityState === "hidden" ||
        !navigator.onLine)
    )
      return;
    const token = generation.current;
    const abort = new AbortController();
    controller.current = abort;
    running.current = true;
    setRetrying(true);
    setDeadline(null);
    if (automatic) setAttempts((count) => count + 1);
    // The owner renders the operation's error. Always contain rejected retry
    // promises here so button/timer callbacks cannot create unhandled errors.
    Promise.resolve()
      .then(() => {
        if (mounted.current && token === generation.current)
          return current.onRetry(abort.signal);
      })
      .catch(() => undefined)
      .finally(() => {
        if (!mounted.current || token !== generation.current) return;
        running.current = false;
        setRetrying(false);
      });
  }, []);

  const automatic = policy.mode === "read" && policy.requiresSigning === false;
  const context = policy.mode === "read" ? policy.context : "connection";
  const retryAfterMs = policy.mode === "read" ? (policy.retryAfterMs ?? 0) : 0;
  const exhausted = attempts >= DELAYS[context].length;

  useEffect(() => {
    setDeadline(null);
    if (
      !failed ||
      busy ||
      retrying ||
      !automatic ||
      exhausted ||
      paused ||
      !available
    )
      return;
    const delay = Math.max(DELAYS[context][attempts], retryAfterMs);
    const at = Date.now() + delay;
    const key = resourceKey;
    setNow(Date.now());
    setDeadline(at);
    const timer = setTimeout(() => {
      if (latest.current.resourceKey === key) invoke(true);
    }, delay);
    const ticker = setInterval(() => setNow(Date.now()), 1000);
    return () => {
      clearTimeout(timer);
      clearInterval(ticker);
    };
  }, [
    resourceKey,
    failed,
    busy,
    retrying,
    automatic,
    exhausted,
    paused,
    available,
    context,
    retryAfterMs,
    attempts,
    invoke,
  ]);

  return {
    retry: useCallback(() => invoke(false), [invoke]),
    retrying: retrying || busy,
    secondsRemaining:
      deadline === null
        ? null
        : Math.max(0, Math.ceil((deadline - now) / 1000)),
    automatic,
    exhausted,
    waiting: automatic && !available,
    paused,
    pause: useCallback(() => setPaused(true), []),
  };
}
