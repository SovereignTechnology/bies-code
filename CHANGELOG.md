# Changelog

## [Unreleased]

### Added

- Search and filter repository workflow runs by workflow, trigger, status, branch, requester and coordinator, with responsive rows and expandable run details.

### Fixed

- Keep issue dialogs and typing focus stable when unrelated private repository events arrive.

- Advance relay connection backoff after WebSocket errors without a close event, preventing unreachable relays from retrying every second indefinitely.

- Redirect user profiles to their coordinator page when a validated coordinator advertisement is discovered.

- Report relay rate-limit cooldowns during merge preflight recovery instead of misleading timeouts, and restart the check deadline when the catch-up query resumes.

- Restart stalled repository preflight queries when manually rechecking a merge, without replacing covered queries or automatically signing another merge.

- Show individual GRASP state-publication responses when a merge stops before pushing, distinguishing relay rejections from missing acknowledgments and timeouts.

## [4.1.0] - 2026-09-13

**Local drafts & easier recovery**

### Added

- Save issue and comment drafts locally per account across refreshes and browser restarts. Restore unfinished replies beside their parent and code-review drafts under their file. Closing the issue modal keeps its draft; Discard or deleting all text clears it.

- Add visible retry actions and bounded automatic recovery for public Git read
  errors, with context-specific countdowns, pause controls, and offline/background
  handling. Signing-capable reads and actions remain manual.

### Changed

- Fetch coordinator profile advertisements through the shared page subscription.

- Restore the MIT license text and update the bundled ngit workflow guidance.

### Fixed

- Prevent attachment uploads from restoring discarded drafts or overwriting newer text after a composer closes, clears, or switches accounts.

- Link original pull-request commits to their contextual details page.

- Show a coordinator profile link only when the coordinator advertises its profile.

- Show expandable annotated tag messages on the tags page, including release notes and changelogs.

- Accept `nprofile` repository URLs and use their embedded relay hints for discovery.

- Open expanded workflow details on the commit page when selecting CI status from repository, commit history, branch and tag rows.

- Surface clipboard and QR rendering failures with manual retry, and provide file reselection beside login file errors; only show copy success after the clipboard write completes.

- Make action errors explicitly recoverable across account, collaboration, settings, upload and release flows; preserve partial successes and keep signing/payment recovery manual.

- Complete recovery controls across Git comparisons, refs, README/media, patch verification, release metadata and discovery diagnostics; preserve manual signing/payment flows.

- Add recovery controls to exhausted event searches, identity lookups, Namecoin resolution and relay metadata errors instead of stranding users or showing a misleading not-found page.

- Recover PR history and merge-base failures without a page reload; keep base lookup running across ordinary renders and provide bounded retry controls.

- Keep concurrent Git mirror fetches independent so one server’s failure cannot suppress a request to another server.

- Report Git fetch and parsing failures without incorrectly claiming a commit is missing; cancelled requests no longer leave misleading server status.

## [4.0.0]

### Release overview

GitWorkshop v4 is its biggest release yet. It brings CI, private repositories,
software releases, and a much richer code-review experience together in the
browser. Released in tandem with ngit v3, ngit-grasp v3, and the new ngit-ci
0.1, it carries the coordinated launch into a responsive interface while the
project's identity and policy stay with its maintainers. These are the changes
that define the release. [Read the full launch
story](https://ngit.dev/v3) to see how all four releases fit together; the
detailed entries below record every feature, compatibility change, and fix.

- **CI is here:** Follow a run from a maintainer's request to a signed result
  whose provenance anyone can inspect. Discover and control maintainer-selected
  coordinators, manage encrypted repository secrets, inspect every workflow,
  job, provider, artifact, and output, and open NIP-5A pull-request previews.
- **Private repositories without surrendering identity:** Private repositories
  become a practical browser workflow without turning the project into an
  account owned by its server. Discover, browse, and collaborate on GRASP-08
  repositories using an encrypted service list and scoped Nostr and Git
  authentication. Basic Buzz support brings Buzz repositories into the same
  discovery, code-browsing, and pull-request viewing interface.
- **Maintainers and repository authority:** Introduce an explicit lead,
  role history, and non-maintainer moderators, with clearer invitations,
  handovers, departures, roster changes, and historical authorization. These
  substantial improvements are backwards compatible for existing repositories
  and confirmed maintainer relationships. The one narrow breaking change is
  that an invited maintainer has no Git-state authority until they accept. That
  pending-invitation boundary is the SemVer reason for the v4 major version
  bump.
- **Pull requests built for serious review:** Target non-default branches,
  understand inferred pull-request stacks, compare repositories and refs,
  follow condensed commit graphs, trace issue-resolution provenance, and merge
  with stronger browser safety checks.
- **Software releases without the platform:** Think GitHub Releases without
  GitHub, made resilient through Blossom replication. Publish and browse signed
  NIP-82 applications, releases, and assets with Zapstore linking,
  compatibility metadata, and repository-aware permalinks.

#### Additional GitWorkshop highlights

- **Browser experience:** Reduce relay and Git work through settled,
  progressively enriched queries and on-demand object loading while expanding
  mobile collaboration, notification, diff, and review interfaces.
- **Richer Git browsing:** Follow repository, pull-request, patch, and push
  history through condensed commit graphs, collapse merged-in histories, and
  compare branches, tags, or commits with progressively loaded file diffs.
- **Faster large repositories:** Reuse shared repository and CI subscriptions,
  grow relay queries incrementally as new sources are discovered, and parse
  packfiles in bounded chunks so large pull requests do not freeze the browser.
- **Mobile collaboration:** Add swipeable file diffs and notification actions,
  compact relay settings, clearer loading states, and layouts that keep review
  and editing controls usable on phone-sized screens.
- **Notifications and discovery:** Group activity by person with bulk read and
  archive controls, improve repository and participant search, and optionally
  resolve `.bit`, `d/`, and `id/` Namecoin identifiers.

### Added

- Add a signer-reviewed advanced-repair danger zone that rewrites the raw
  `M`/`m`/`o` role records of the signer's own repository announcement for
  histories the guided repairs cannot fix, previewing record classification,
  health warnings, and the confirmed-membership delta before signing while
  carrying every non-membership tag byte-for-byte and regenerating the
  deprecated `maintainers` projection.

### Changed

- Share category-neutral replaceable-preflight mechanics for loader-free
  mailbox observation, bounded lifecycle waiting, and relay diagnostics while
  leaving each writer category's quorum policy local. The notification sync
  pause banner now offers a per-relay status breakdown, including user-index
  relays when mailbox discovery is the blocker.
- Warm each selected NIP-82 release coordinate while its dialog is open and
  require the same publisher-relay coverage before treating a version as new.
  Release publication now combines that exact evidence with the shared
  application/deletion lease and a bounded cache lookup, removing the duplicate
  action-time address-loader request; the limited recent-release feed remains
  display-only and cannot prove absence.
- Reuse one complete, page-owned publisher subscription for NIP-82 software
  applications and publisher-authored deletions. Application creation, editing,
  and repository linking now consume its EOSE-backed frozen winner plus a
  bounded cache lookup instead of relying on a limited list or an action-time
  request. Confidential repository routes query only their admitted repository
  relays and no longer expose software publication controls.
- Reuse each repository page's live announcement, state, and deletion query as
  the preflight for kind `30617` and `30618` replacements. Existing coordinates
  require one currently covered repository relay; mailbox and Git index relays
  enrich discovery without gating edits. New author coordinates additionally
  require one NIP-65 outbox EOSE, while new public repositories require both an
  author-outbox and proposed-repository-relay EOSE before signing. Repository
  settings, membership changes, public creation, and merges now consume frozen
  winners from this shared gate. GRASP state transitions retain their pre-push
  acceptance order: preflight, relay acknowledgement, Git push, then durable
  broad publication, with no post-signing echo query in between. A
  `purgatory:` response proves staging; a plain successful `OK`, including from
  Pyramid as of September 8, 2026, may mean the state is already visible.
  Confidential repositories obtain the same proof only from their admitted
  private repository relays and confine membership snapshots and delivery to
  that frontier rather than public enrichment or publication relays. Stable
  coordinate filters no longer restart when an event
  arrives; exact deletion pointers use one coalesced repository lease whose
  additions pause across the relay-acceptance-to-Git-push window. Public
  creation retries persist the original signed announcement, state, and
  packfile across reloads and re-arm purgatory before pushing, while a matching
  announcement without state is treated as a resumable attempt.
- Keep one account-owned warm subscription for the encrypted notification-key
  envelope and derived read/archive state. Cross-device writes now wait for
  current EOSE-backed coverage and decryption without an action-time relay
  request, while immediate local actions are replayed as deltas over the remote
  winner. Mailbox absence plus cached mailbox and envelope evidence must also be
  established before a new derived key can be created, and an explicit coverage
  retry replaces a warm owner that can no longer reach quorum. Both encrypted
  events use the same outbox/fallback frontier.
- Apply the warm personal-singleton preflight policy consistently to contact,
  mailbox, Git follow, pinned-repository, GRASP, Blossom, and encrypted private
  Git relay lists. One account-owned query now covers all category kinds;
  writers consume its frozen snapshot without a duplicate action-time read,
  while one coalesced deletion query supplies the additional NIP-09 evidence.
  Personal singletons publish durably to outboxes and user indexes; established
  user-index kinds remain required while newly routed application lists are
  best-effort there. GRASP lists retain Git-index publication, and mailbox
  changes preserve both old and proposed outbox frontiers. Ordinary settings
  writes rely on durable retry and the warm subscription rather than opening a
  post-write confirmation request.
- Render commit lists as a condensed commit graph: one fixed-height row per
  commit with colored topology rails, hollow merge dots, branch/tag badges on
  the repo commits page, dashed stubs where history is truncated, and a
  mirrored oldest-first layout for PR commit ranges. On the PR commits tab,
  history merged in from other branches (e.g. "merge master into feature" on
  a stacked PR) collapses behind an expandable count row instead of being
  presented as the branch's own commits.
- Extend the condensed commit graph to the remaining commit surfaces: the
  patch commits tab, original PR/patch body card, and push cards on the PR
  conversation timeline now render the same rail rows. Windows of commits fade
  into dashed stubs where history continues above or below (earlier ancestors,
  later pushes built on top), and commits force-pushed away pair the
  struck-through text with a faded hollow dot; fast-forwarded pushes keep their
  retained commits intact. Merged-in histories stay condensed behind the same
  expandable branch-labelled row in both full and inline PR commit views.
- Prepare tag-only NIP-82 and Zapstore release publication through ngit while
  retaining the existing zsp manifest as a manual first-release fallback.
- Publish the production NIP-5A site with ngit through a dedicated established
  CI signer connection, replacing the nsyte-specific signing bridge.
- Settle repository resolution once over a monotonic initial relay snapshot — one identifier-scoped announcement wave plus a bounded deletion follow-up, with relay failures counted so settlement is always finite. Maintainers, relays, and mailboxes discovered later enrich the page progressively instead of restarting settlement; canonical lead redirects now fire at the first fresh relay EOSE, while archived, deleted, and restarted lifecycle notices and the membership safety gates keep waiting for the full snapshot.
- Enable conservative repository membership changes only after complete relay, history, network Git-object, and relay-publication verification; pre-stabilization acceptance delivery jobs remain quarantined.
- Make reciprocal NIP-34 membership the repository authority boundary, add indexed `M`/`m`/`o` role and `defer` resolution, separate discovery from confirmed maintainer/member coordinates, retire legacy complete-roster browser writes, and preserve membership tags through metadata edits.
- Resolve repository leads from the selected coordinate's signed `M` pointer path or legacy vote result, apply redirects only after a bounded current-announcement refresh, preserve the full URL, and leave unresolved or tied routes unchanged.
- Remount account-authored repository settings when the active account changes so unsaved metadata cannot cross signer scopes.
- Match ngit's duplicate active role-target handling while retaining a repository-health warning for malformed announcements.
- Resolve repository discovery through a deterministic reciprocal-component index, progressively group browse, search, profile, pinned, followed, and starred cards without per-coordinate safety requests, keep same-identifier invitations separate, and match ngit's confirmed-member metadata, infrastructure, and privacy merging.
- Resolve replicated role history for collaboration events at their publication time, retain historical authorization after ordinary exits, require a new acceptance interval after reinvitation, and identify archived, deleted, and same-coordinate restarted repository lifecycles without restoring current authority.
- Support maintainer add, fresh invitation acceptance, direct relationship removal, maintainer leave, and moderator self-leave as exact operations; repository settings batch any number of lead-authored additions and removals with metadata into one Save replacement. Signed replacements are durably queued, require a designated relay acknowledgement and exact refetch before success, and fail closed with named errors for unsupported component, lead, history, identity, state, and concurrency cases.

### Fixes

- Replace the blanket “GitWorkshop does not yet support making this
  transition” suffix on maintainer changes with cause-specific recovery text,
  and classify unexpected failures separately instead of calling them relay
  coverage errors.
- Report a declined maintainer-change signature as a signer decision and state
  that no repository update was published, instead of mislabelling it as an
  incomplete relay view for an unsupported transition.
- Let a repository's lone confirmed owner send the first maintainer invitation
  even when an empty or self-only legacy `maintainers` tag leaves lead
  resolution at `none`. Guarded mutations now classify every preserved legacy
  relationship against the destination lead before generating history, so an
  existing relationship materialized as `M` retains its unknown start whether
  the lead is the publisher or another maintainer. Explicit lead selection,
  lead transfer, follow-lead, and indexed leadless roster changes remain
  unsupported in the browser.
- Keep passive NIP-44 decryption requests single-flight until the external
  signer responds, stop foreground resume from duplicating them, and require an
  explicit retry after private-service decryption fails. A declined or timed-out
  notification-key decrypt no longer rotates the key behind the user's back.
- Accept established NIP-46 `nbunksec` connections for CI secret sealing in
  addition to fresh `bunker://` pairing URLs, matching ngit-ci's maintainer
  binding flow.
- Require personal replaceable-event writes to count only relays whose active
  identity subscription has completed its current EOSE cycle, invalidating
  that warm coverage across reconnects, foreground catch-up, relay removal,
  and account-session replacement; in-flight connected checks now get a bounded
  chance to satisfy the existing relay threshold before the action reports an
  exact outbox/lookup status breakdown. Require a full baseline EOSE before
  cursor-based recovery, let silent requests recover after their settlement
  deadline, and preserve an absent target from the local cache. Reuse sufficient
  warm evidence directly instead of issuing a duplicate action-time request to
  the same relays, and pass that resolved state into contact and mailbox writers
  so their model fallback cannot quietly reopen one. Keep the identity query
  retrying for the account session and restart its live cycle when bounded
  foreground recovery is exhausted.
- Re-issue resilient one-shot requests after WebSocket recovery, applying the
  configured REQ retry delay after the socket opens; persistent subscriptions
  retain their previous retry/repeat budget and backoff semantics. Before the
  first full EOSE, all resilient consumers now retry the complete filter, and
  later recovery cursors clamp future-dated event timestamps to the current
  time.
- Re-resolve advanced repository repairs inside the guarded builder and refuse
  a replacement without its own relay hint when the role edit would make the
  resulting repository component private.
- Scope duplicate role-record health to its author so another maintainer's
  duplicated history no longer blocks unrelated membership operations; the
  affected author's own mutations stay fail-closed.
- Let the affected signer repair or accept through an invalid self-`defer`
  that sits beside its valid same-role successor by merging both into one
  clean multi-interval record; genuinely duplicated valid records remain a
  hard conflict and no longer render repair controls that cannot succeed.
- Scope invalid self-`defer` health to its signer, require a strictly later
  signed self-role to restore current authority, keep other maintainers and
  superseded roles operational, and offer explicit signer-approved repair or
  role-acceptance transitions without rewriting unrelated edits.
- Keep deleted, archived, and same-coordinate restarted repositories readable
  with signed actor/time lifecycle notices; preserve their final announcement
  for historical display, flag invalid self-`defer`, and keep membership writes
  fail-closed instead of replacing the repository with a terminal error page.
- Treat a self-`m` interval ending exactly when self-`M` begins as a continuous
  promotion to lead, so repaired repository announcements no longer appear as
  same-identifier restarts.
- Restore maintainer name autocomplete and resolve invitees' NIP-65 mailboxes
  before membership safety snapshots, without treating optional identity
  lookup relays as repository authorities.
- Load the dedicated Markdown chunk alongside the repository route and warm both after initial-page idle or repository-link intent, so pull-request descriptions, cover notes, READMEs, and release notes retain focused caching without waiting behind a late JavaScript placeholder.
- Keep relay-setting rows inside phone-sized cards by truncating long URLs,
  collapsing Remove to a trash icon, and hiding connection glyphs on mobile.
- Publish pull request nsite previews with ngit as root sites under disposable
  local accounts, and verify nsite.cloud can resolve them before exposing a CI
  URL.
- Disable event signature verification in the EventStore, removing roughly a third of main-thread CPU work on a cold repository load: relay-validated events are trusted on receipt, in line with wider nostr client practice, while locally persisted deletion tombstones remain fully verified. See `docs/signature-verification.md` for the rationale and the planned relay-trust spot-check model.
- Resolve item links that name several repositories (multi-pointer `nevent` routes) through one identifier-scoped announcement wave instead of sequential per-repository settlement stages, while keeping the component-ambiguity refusal gated on complete relay coverage.
- Restart repository issue and pull-request relay subscriptions only when role-history content actually changes, so announcement refetches and deletion-list emissions no longer re-request the repository's full item backlog from every relay.
- Grow repository issue and pull-request relay subscriptions additively when a maintainer confirms later: the new coordinate joins the live queries as one delta request per relay instead of restarting them and re-fetching every already-seen item's details, and an unchanged coordinate set costs no relay traffic at all.
- Keep the repository state query alive while the repository's relay and confirmed maintainer sets grow during resolution: a joining relay costs one state request on that relay only, a newly confirmed maintainer joins as one delta request per relay, and the state-settled gate behind membership actions and settings controls no longer flickers on growth.
- Fetch repository CI context (coordinator discovery, repository status, repo-wide activity) and per-identity provider/coordinator enrichment through shared keyed queries that persist across tab navigation, so pages reuse one live subscription set and a newly observed CI identity fetches only itself instead of restarting the whole trust pipeline.
- Keep cold repository discovery on structured loading states until both the base component list and the landing page's GRASP subset are observable, while bounding genuine empty results and labelling incomplete relay views honestly.
- Bound direct repository graph refreshes on failed relays, stabilize deletion-aware repository-model cache identity, preserve observed coordinates in progressive discovery links, and fast-path unambiguous single-coordinate item routes.
- Finish repository search component settling when unavailable graph relays reach a terminal error, so successful results no longer remain behind loading placeholders.
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
- Preserve repository discovery, search, notification, and item coordinates until the destination route can apply its guarded lead redirect.
- Start release discovery from repository and Zapstore relays without waiting for publisher outbox discovery to finish.

### Features

- Add an Accessible private repositories section to the signed-in homepage
  when private Git services are configured, showing how many services are
  queried and linking directly to their configuration.
- Add GRASP-08 and basic Buzz private-repository support with an editable
  NIP-44-encrypted service list, private-first repository discovery,
  account-scoped NIP-42/NIP-98 authentication, isolated Git caches, and strict
  repository-relay confinement for private collaboration events. Search the
  listed private services alongside public indexes and include their repositories
  in the dashboard and repository browser.
- Give GRASP relays a dedicated service view for access policy, hosted
  collaboration totals, protocol metadata, and repository search, linked to
  but kept distinct from the matching CI coordinator profile.
- Classify CI coordinators and providers with settled maintainer-directed,
  operationally associated, seen-in-your-network, or no-known-context
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
