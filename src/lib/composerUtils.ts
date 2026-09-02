/**
 * Utility functions for the NostrComposer component.
 * Kept in a separate file so they can be imported without triggering
 * the react-refresh/only-export-components lint rule.
 */

const NSEC_RE = /nsec1[023456789acdefghjklmnpqrstuvwxyz]+/;

/**
 * Returns true if the given composer value contains a bare nsec1 key.
 * Use this to disable the submit button in parent forms.
 */
export function composerHasNsec(value: string): boolean {
  return NSEC_RE.test(value);
}
