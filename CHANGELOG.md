# Changelog

## [Unreleased]

### Fixes

- Stop showing inferred stacked-PR relationships once the shared base commit is reachable from the PR's target branch, including fast-forwarded parents.
- Show the repo Actions tab's coordinator-trust shields and repository-attribution warnings on pull request checks as well.
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

- Keep repository Actions focused with a compact coordinator summary, filter activity by coordinator relationship, include offline coordinators with request or workflow history in the directory, move service details and coordinator-filtered runs onto dedicated pages, and distinguish coordinators requested now, requested previously, or unassociated without rewriting each run's frozen request provenance.
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
