import { defer, timer, ReplaySubject, share, type Observable } from "rxjs";

/**
 * How long a keyed shared observable stays connected to its source after the
 * last consumer unsubscribes. This bridges React dependency churn (a hook
 * unsubscribing and immediately resubscribing when a key input changes) and
 * quick navigation between pages that mount the same query, so the underlying
 * relay subscriptions are reused instead of being torn down and reopened.
 */
export const KEYED_SHARE_LINGER_MS = 60_000;

/**
 * Return a per-key shared observable, creating it from `factory` on first use.
 *
 * The shared observable replays the latest value to late subscribers and keeps
 * the source alive for KEYED_SHARE_LINGER_MS after the last unsubscribe. Once
 * the linger elapses the source is disconnected; the next subscriber re-runs
 * `factory` from scratch (fresh relay queries), so cached results are
 * refreshed rather than trusted forever.
 *
 * Cache entries persist for the session: keys are bounded by the
 * repositories, identities, and accounts a user actually visits.
 */
export function keyedShared<T>(
  cache: Map<string, Observable<T>>,
  key: string,
  factory: () => Observable<T>,
): Observable<T> {
  const existing = cache.get(key);
  if (existing) return existing;
  const shared = defer(factory).pipe(
    share({
      connector: () => new ReplaySubject<T>(1),
      resetOnRefCountZero: () => timer(KEYED_SHARE_LINGER_MS),
    }),
  );
  cache.set(key, shared);
  return shared;
}
