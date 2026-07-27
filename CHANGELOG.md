# Changelog

## [Unreleased]

- Fix maintainership invitation acceptance by using a compact banner and a shared modal for choosing GRASP servers and lead maintainers, then showing sync progress after acceptance. Repositories with conflicting existing state remain blocked until their refs can be safely combined.
- Keep invitation syncing moving by telling GRASP where to find the existing repository, retrying servers while they create the new copy, and discarding cached refs as each server catches up. Persist operation progress across navigation without treating the locally signed announcement as accepted repository state, deliver it only to the selected GRASP servers, and show acceptance as successful once the first server has synchronized.
- Align recursive repository authorization with ngit and GRASP, add compact existing-repository links for invited maintainers, consolidate repository-join warnings, and separate work sent only to those repositories from accepted repository and social-proof counts.
- Fix CI workflow duration counters so running checks update every second.
- Show referenced work items and cross-repository comment mentions in discussions.
- Preserve percent-encoded repository identifiers and the current relay hint in repository sub-page links.
- Resolve repository relay hints for localhost, including plaintext `ws://` local relays.
- Add Android NIP-55 login with Amber.
- Fix notifications: add an ungrouped activity mode with one row per notification, and correct grouping, unread state, and actor displays for stars, zaps, and nested comment threads.
- Fix post-merge local file explorer state: resolve refs newly announced in the signed repository state before git servers update their advertised refs.

## [3.0.3]

- Visualize CI workflow queue, execution, and conclusion timing.

## [3.0.2]

- Fix Zapstore publishing by restoring the persistent bunker signing client key.

## [3.0.1]

- Show platform-aware release metadata alongside the build commit in the footer.
- Keep the ref selector in sync with live repository state events.
- Prevent duplicate CI workflow and job results from appearing in the checks display.
- Publish Android releases automatically to Zapstore.

## [3.0.0]

- Initial version.
