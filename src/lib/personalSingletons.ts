/**
 * Active-account replaceable events governed by the personal-singleton
 * preflight policy in docs/replaceable-preflight.md.
 *
 * Keep this as the shared protocol list for warm reads, writer admission, and
 * publication routing. UI-only subscriptions for another user's public profile
 * may intentionally use a smaller projection.
 */
export const PERSONAL_SINGLETON_KINDS = [
  0, // profile metadata
  3, // contact / follow list
  10002, // NIP-65 relay list (mailboxes)
  10017, // NIP-51 Git authors follow list
  10018, // NIP-51 Git repositories follow list
  10063, // Blossom server list
  10317, // Grasp server list
  10318, // encrypted private Git relay list (GRASP-08)
  10617, // pinned Git repositories list
] as const;

/** Personal singletons whose candidates require NIP-09 deletion evidence. */
export const PERSONAL_SINGLETON_DELETION_KINDS = [
  10017, 10018, 10063, 10317, 10318, 10617,
] as const;

/** Coalesce candidate changes before replacing the shared deletion query. */
export const PERSONAL_DELETION_BATCH_WINDOW_MS = 1_000;

const personalSingletonKindSet = new Set<number>(PERSONAL_SINGLETON_KINDS);
const deletionKindSet = new Set<number>(PERSONAL_SINGLETON_DELETION_KINDS);

export function isPersonalSingletonKind(kind: number): boolean {
  return personalSingletonKindSet.has(kind);
}

export function personalSingletonNeedsDeletionEvidence(kind: number): boolean {
  return deletionKindSet.has(kind);
}
