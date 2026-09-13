# Local issue and comment drafts

Issue creation and discussion reply composers save edits synchronously to this
browser's local storage. No draft events are signed, published, or fetched, and
no Nostr draft specification is used.

Draft keys include a format version and the active account's public key. Logged
out writing has its own anonymous namespace; logging in does not transfer it to
another account. Issue drafts use the repository route coordinate, including its
author and identifier. Discussion comments use the immediate parent event ID, so
top-level comments and replies to different comments remain independent.

Returning to the repository's issues page reopens an unfinished issue form.
Returning to a discussion opens saved reply composers beneath their parents.
Closing a composer or cancelling an issue form keeps its draft. Delete all text
(both title and description for issues), or choose **Discard draft**, to remove
it. Issue labels and uploaded attachment metadata survive alongside the text.
Preview mode, authentication choices, and pending operations are not persisted.

Successful posting clears only the submitted draft version. Failed posting keeps
it; a successful comment followed by a failed status change still clears the
posted comment. A late completion cannot clear another account's draft or a newer
edit. Other tabs receive changes through browser storage events. If storage is
unavailable or full, editing continues in memory with a visible warning rather
than a false saved indicator. In-memory fallback cannot survive a reload.

Drafts are specific to this browser and origin. Clearing site data removes them.

Code-review drafts additionally include the root and parent event IDs, file,
commit, line range, and diff side. Returning to **Files Changed** shows unfinished
code comments under the corresponding file header, including collapsed files.
Different lines and revisions keep separate drafts. Replies to existing code
comments use the same parent-event drafts as the conversation view and reopen
beneath their parent. Resolved threads with unfinished replies remain expanded
so their drafts are not hidden.
