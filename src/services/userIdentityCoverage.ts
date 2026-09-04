import { normalizeUrl } from "@/lib/url";
import type { RelaySubscriptionCoverage } from "@/lib/relaySubscriptionCoverage";

interface ActiveUserIdentityCoverage {
  pubkey: string;
  coverage: RelaySubscriptionCoverage;
}

/**
 * Holds only the active account subscription's coverage lease. This is a
 * single owner pointer, not a registry of filters or historical EOSE results.
 */
export class UserIdentityCoverageOwner {
  private active: ActiveUserIdentityCoverage | undefined;

  activate(pubkey: string, coverage: RelaySubscriptionCoverage): () => void {
    this.active?.coverage.stop();
    this.active = { pubkey, coverage };

    return () => {
      coverage.stop();
      if (this.active?.coverage === coverage) this.active = undefined;
    };
  }

  get(pubkey: string): RelaySubscriptionCoverage | undefined {
    return this.active?.pubkey === pubkey ? this.active.coverage : undefined;
  }

  coveredRelays(pubkey: string, relays: readonly string[]): string[] {
    const coverage = this.get(pubkey);
    if (!coverage) return [];
    return relays.filter((relay) => coverage.isCovered(normalizeUrl(relay)));
  }
}

/** Coverage owned by the current active-account identity subscription. */
export const userIdentityCoverage = new UserIdentityCoverageOwner();
