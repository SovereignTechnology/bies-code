# Changelog

## [Unreleased]

### Changed

- Make reciprocal NIP-34 membership the repository authority boundary, add indexed `M`/`m`/`o` role and `defer` resolution, separate discovery from confirmed maintainer/member coordinates, and temporarily disable legacy browser membership writes while preserving membership tags through metadata edits.
- Resolve repository leads from the selected coordinate's signed `M` pointer path or legacy vote result, refresh the complete current announcement closure before redirecting, preserve the full URL, and leave unresolved or tied routes unchanged.
- Remount account-authored repository settings when the active account changes so unsaved metadata cannot cross signer scopes.
- Match ngit's duplicate active role-target handling while retaining a repository-health warning for malformed announcements.
- Resolve repository discovery through a deterministic reciprocal-component index, so browse, search, profile, pinned, followed, starred, and NIP-19 results show one card per active repository regardless of relay arrival order and keep same-identifier invitations separate.

### Fixes

- Recognize open stacked pull requests before warning about an incorrect merge base, wait for the parent to land before enabling merge actions, and keep inferred stack titles current after authorized renames.
- Keep unavailable repository code pages settled on their error state instead of repeatedly flashing loading placeholders and polling Git servers for stale Nostr state.
- Reconcile issue and pull-request descendants across repository and mailbox relays, and persist verified deletion tombstones before cache hydration so split-relay deletions remain authoritative after reloads.
- Preserve non-root GRASP service paths across server preferences, repository creation and editing, maintainer invitations, relay matching, and percent-encoded `nostr://` relay hints.
- Complete repository-relay issue and pull-request thread loading across every `e`, `E`, and `q` descendant so reactions, revisions, and deletion requests are not lost at batch or delivery-order boundaries.
- Parse Git packfiles in bounded typed-array chunks so large pull requests no longer freeze Chrome while preparing merge objects.
- Continue the merge flow as soon as one Grasp server accepts the push instead of waiting for the slowest server; remaining servers keep syncing in the background with live delivery status.
- Explain stale PR merge bases as already-merged stack parents when the computed commit belongs to a resolved PR.
- Keep the pull request merge check alive while switching between the Conversation, Commits and Files Changed tabs instead of restarting it on every return.
- Prefetch the git objects a merge push needs while the pull request page is idle, so confirming a merge no longer waits on branch-object downloads.
- Discover coordinator repository status on readiness-targeted repository relays when no NIP-65 outbox is available, and route coordinator identity links in CI surfaces to the coordinator profile.
- Stop the Android app from repeatedly re-opening a cold-start gitworkshop.dev link, which blocked navigating away from the opened page and caused visible flashing.
- Stop showing inferred stacked-PR relationships once the shared base commit is reachable from the PR's target branch, including fast-forwarded parents.
- Show the repo Actions tab's CI trust-context labels and repository-attribution warnings on pull request checks as well.
- Keep repository tabs, inline diff comment threads, Git and relay status popovers, and profile and branch loading placeholders within phone-sized viewports.
- Make file diffs swipeable on mobile with a compact contextual line-number gutter and hunk headers that remain visible while scrolling.
- Keep composer edit controls visible while previewing, show live attachment-upload progress, and disable conflicting actions until uploads finish.
- Give cover-note markdown the full card width on mobile instead of reserving action-button space beside the entire note.
- Restore social preview images and complete the homepage's Open Graph URL and description metadata.
- Keep embedded issue and pull request previews mounted across reactive updates, and preserve full hexadecimal-looking identifiers until Git verifies them as commits.
- Load direct links to historical commits reliably across initial Git discovery races, while rejecting malformed commit IDs before contacting a server.
- Exclude legacy repository mentions from issue and pull request attribution so work filed elsewhere no longer appears in mentioned repositories.
- Resolve repository searches through ranked, validated user profiles across multiple NIP-50 relays.
- Route repository discovery, search results, notifications, and item permalinks through the lead maintainer so multi-maintainer repositories open at their canonical paths.
- Start release discovery from repository and Zapstore relays without waiting for publisher outbox discovery to finish.

### Features

- Give GRASP relays a dedicated service view for access policy, hosted
  collaboration totals, protocol metadata, and repository search, linked to
  but kept distinct from the matching CI coordinator profile.
- Classify CI coordinators and providers with settled maintainer-directed,
  operationally associated, socially corroborated, or no-known-context
  evidence across Actions, pull requests, commits, refs, coordinator pages,
  and provider profiles, with concise popovers, request-signer attribution,
  recent signed provider-job history, and incomplete-query handling.
- Publish pull request web builds as credential-free NIP-5A previews under a
  fresh identity per run and expose their URL as a public CI job output.
- Show a prominent, caution-labelled nsite preview link on pull requests when
  a successful CI job publishes an `nsite` or `nsite_*` public output.
- Keep the latest nsite preview above the pull request description, link each
  historical preview from its push and check run, and make web-valued public
  CI outputs clickable.
- Preserve the PR, triggering commit, and merge commit when a merged change resolves an issue, and show that provenance in the issue timeline.
- Add coordinator-centric CI service profiles with signed capability details, current and historical outbox-backed repository activity, readiness targets, NIP-65 relay posture, and NIP-05/NIP-11 GRASP identity checks, linked from repository coordinator pages.
- Let maintainers bind CI repository secrets to a NIP-46 decryption bunker, audit which values the coordinator reports as sealed at rest, keep relay-delivered changes pending until coordinator status reports them, and safely replace or remove the binding from the secret controls.
- Discover live CI coordinators before the first workflow run, distinguish active and request-ready service, let maintainers request or stop standing CI, submit atomic NIP-44-encrypted repository secret updates, audit value-free secret inventories, and inspect maintainer-request, provider, allocation, artifact, and output provenance on workflow results.
- Honor the optional NIP-34 pull-request target branch, including branch context and filtering in the UI plus target-aware comparisons and safe non-default-branch merges.
- Replace cramped phone notification-row buttons with theme-aligned swipe cues: swipe left to toggle read state and right to archive or restore. Touch tablets retain persistent icon-only controls, while precise pointers reveal full actions on hover or focus.
- Show inferred pull request stacks from repository-local Git topology, including historical updates, linked stack navigation, and clear ambiguity handling.
- Add a GitHub-style repository compare page with progressive commit-graph loading and batched file-diff retrieval between branches, tags, or commit IDs.
- Resolve `.bit`, `d/`, and `id/` Namecoin identifiers in repository searches and direct repository URLs through an opt-in, lazily loaded client-side resolver.
- Show every recursive maintainer on repository about pages, including the lead maintainer and links to each maintainer's announcement.
- Group notifications by user with expandable activity, bulk read, unread, archive, and restore actions for each actor, and a dedicated unread inbox filter.
- Add NIP-82 repository releases with guided version, channel, platform, format, compatibility, and provenance metadata, immediate cancellable Blossom uploads, and the latest release on repository overviews.
- Add repository software application pages and management, including creation, editing, filtering, linking existing Zapstore applications, explicit source migration, and publisher ownership enforcement.
- Add raw-event and sharing controls with repository-aware application, release, and asset permalinks.
- Open application and discussion images in accessible keyboard and touch lightbox galleries.

### Changes

- Keep repository Actions focused with a compact coordinator summary, filter activity by coordinator relationship, show live coordinators only when they are acting on or explicitly targeting the repository, include offline coordinators with request or workflow history in the directory, move service details and coordinator-filtered runs onto dedicated pages, and distinguish coordinators requested now, requested previously, or unassociated without rewriting each run's frozen request provenance.
- Clarify coordinator service details with a single maintainer-trust summary, contextual Request/Stop controls, history only when present, amber offline and unrecognised states, complete secret names, and maintainer-only Nostr secret-inbox warnings.
- Search issues and pull requests by full event ID, `nevent`, or short hexadecimal prefix, and reveal ID matches even when the active facets would otherwise hide them.
- Write notification-state key envelopes with a purpose-specific field while continuing to read existing legacy envelopes.
- Vendor NIP-82, published to Nostr by Fran (author of franzap) on April 11, 2026, document repository association and general-purpose release assets, and retain its established application ID tag for compatibility.
- Bound release-history and asset-metadata discovery to 30 releases per application, progressively render release cards in batches of 20, and check exact release coordinates before publishing to prevent older versions from being replaced.

## [3.1.1]

### Fixes

- Prioritize repository participants, Git follows, and social follows in user autocomplete, including cached trusted profiles, explicit relationship badges, and loading feedback.
- Open Amber through Android's native NIP-55 bridge in the APK so login and signing requests are delivered as valid signer intents.
- Tag new issues with every recursive maintainer coordinate, keeping the selected maintainer first for compatibility, and defer notification until every referenced maintainer's relays resolve.
- Preserve relay URL paths in repository links so issue and pull request notifications resolve the correct repository identifier.

### Features

### Changes

- Centralize authoritative and user-selected Git ref resolution in the shared Git pool so code, commits, branches, tags, and ref selectors use one per-ref source decision.

## [3.1.0]

### Fixes

- Fix repository follow state and follower counts to track only the selected maintainer's announcement.
- Fix maintainership invitation acceptance by using a compact banner and modal for choosing GRASP servers and lead maintainers, preserving existing non-GRASP clone URLs, and allowing every safe state ordering. Only a newer owner state that would replace or remove the invitee's refs is deferred to ngit CLI until interactive ref combining is available.
- Fix CI workflow duration counters so running checks update every second.
- Preserve percent-encoded repository identifiers and the current relay hint in repository sub-page links.
- Resolve repository relay hints for localhost, including plaintext `ws://` local relays.
- Fix notifications: add an ungrouped activity mode with one row per notification, and correct grouping, unread state, and actor displays for stars, zaps, and nested comment threads.
- Fix post-merge local file explorer state: resolve refs newly announced in the signed repository state before git servers update their advertised refs.

### Features

- Add combined comment-and-resolve/close actions for issue authors and maintainers, with comment-and-close available on pull requests.
- Add lead-maintainer coordination to repository settings, including explicit no-lead mode, graph-aware removal warnings, safe restoration of the current maintainer listing when changing modes, and routing each recursive maintainer through their own repository announcement before editing.
- Show referenced work items and cross-repository comment mentions in discussions.
- Add Android NIP-55 login with Amber.

### Changes

- Keep invitation delivery and GRASP Git syncing moving independently in the background across navigation. Retry incomplete relay delivery with bounded backoff, wait for the signed announcement to be received before caching it, and show acceptance as successful once the first selected Git endpoint has synchronized while the remaining endpoints continue.
- Align recursive repository authorization with ngit and GRASP, add compact existing-repository links for invited maintainers, consolidate repository-join warnings, and separate work sent only to those repositories from accepted repository and social-proof counts.

## [3.0.3]

### Features

- Visualize CI workflow queue, execution, and conclusion timing.

## [3.0.2]

### Fixes

- Fix Zapstore publishing by restoring the persistent bunker signing client key.

## [3.0.1]

### Fixes

- Keep the ref selector in sync with live repository state events.
- Prevent duplicate CI workflow and job results from appearing in the checks display.

### Features

- Show platform-aware release metadata alongside the build commit in the footer.
- Publish Android releases automatically to Zapstore.

## [3.0.0]

### Features

- Initial version.
