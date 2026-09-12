# Error recovery

Recoverable error views offer a visible **Retry now** button beside the error.
Keep the explanation and useful source diagnostics visible; do not replace them
with a toast. Buttons show pending work and prevent overlapping attempts.

Use `useErrorRetry` in the component that owns the operation, and render its
`ErrorRetryAction` in the error view. The owner must stay mounted while loading;
putting the hook inside a conditionally mounted error view resets its budget.
Use a stable resource key that changes with the repository/account/pool and
requested ref, commit, or search. Callback identity is not a resource key.

## Automatic retries

Automatic retries are explicitly opt-in for reads known not to require signing:

| Context                                                                                | Delays after successive failures |
| -------------------------------------------------------------------------------------- | -------------------------------- |
| Connection or transport failure                                                        | 5, 15, 30 seconds                |
| Data may still be propagating                                                          | 15, 30, 60 seconds               |
| Signing, authentication, mutations, invalid input, unsupported protocol, local parsing | Manual only                      |

The policy defaults to manual. A read policy requires `requiresSigning: false`.
Never infer this from an operation's name or the fact that a repository is public.
Private Git reads can sign HTTP authorization; relay reads can initiate AUTH.
Those paths must remain manual unless their entire retry path is known to avoid
signing. Publishing, payments, uploads, merges, account actions, and signature
requests must never be connected to an automatic retry callback.

Each failure episode allows three automatic attempts. A successful operation or
resource change resets the budget; another failure does not. Manual retry stays
available after exhaustion and does not silently reset the automatic budget.
Users can pause automation. Timers stop while offline, hidden, busy, or unmounted;
returning online/visible begins a fresh context-specific pause rather than an
immediate burst. Honor a known server minimum delay with `retryAfterMs`.

A countdown explains the next retry without an every-second screen-reader live
announcement. Cancellation is not an error. The hook supplies an AbortSignal to
retry callbacks; check it after awaits before changing the view or starting more
work. The operation owner continues to render any resulting error. Do not allow
an exception from a button or timer callback to become an unhandled rejection.

The UI budget is separate from existing transport reconnect/backoff machinery.
Do not schedule another UI attempt while that operation is busy. For Git,
`pool.retryReads()` cancels the pending pool backoff, re-enables failed endpoints,
refreshes advertised refs, and preserves successful object caches. It never
changes refs or publishes events. Gate automation with
`pool.requiresSigningForReads`, then retry the owning view after recovery.
Concurrent recovery requests await the same pool fetch. Reads for a known commit
or file use `pool.retryReads({ refreshRefs: false })`: re-enable failed endpoints
and retry the object without invalidating refs or restarting pool backoff. If
refs are unavailable or the entire pool failed, discovery still runs. Branch/tag
lookups and explicit server re-probes retain the default ref refresh.

## Current adoption

- Code explorer: connection delays for fetch/connectivity failures, longer
  availability delays for missing refs/empty mirrors, manual for unclassified
  errors and authenticated pools.
- Commit detail, diff, repository/PR history and PR base lookup: availability delays for public reads;
  authenticated pools remain manual.
- Event search: shared manual retry supplied by the search hook or page owner;
  deleted/vanished events are not retried as errors.
- Identity, Namecoin and NIP-11 metadata: bounded connection retries for unsigned public reads; DNS retries bypass cached failures for that attempt only; subsequent identities use the cache normally.
- Patch parsing: manual retry, because the same invalid patch is deterministic.
- Existing form submission, signing and application-error-boundary actions stay
  manual. Incompatible protocol and deliberate absence/deletion are not transient
  failures and should explain the corrective action rather than loop.

Apply this pattern to new recovery UI rather than adding local timers or an
icon-only retry button. When adopting another existing surface, first identify
its operation owner, cancellation path, signing behavior, and existing retries.

Keep diagnostics with their owning operation instead of adding a timer to each
badge. Retry controls embedded in linked content must prevent link navigation
when activated.
