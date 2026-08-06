# Changelog

## [Unreleased]

### Fixes

- Resolve repository searches through ranked, validated user profiles across multiple NIP-50 relays.

### Features

- Group notifications by user with expandable activity, bulk read/archive actions for each actor, and a dedicated unread inbox filter.
- Add GitHub-style repository release and application pages for viewing, filtering, creating, editing, and linking existing NIP-82 applications and releases, with explicit publisher ownership, lightbox galleries for application and discussion images, application media and metadata, immediate cancellable Blossom uploads, guided platform, format, compatibility, and provenance metadata, event sharing, and repository-aware application, release, and asset permalinks.

### Changes

- Bound release-history discovery to 180 entries per application and progressively render release cards in batches of 20.

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
