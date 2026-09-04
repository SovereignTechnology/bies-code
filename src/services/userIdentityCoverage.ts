import { normalizeUrl } from "@/lib/url";
import type { RelaySubscriptionCoverage } from "@/lib/relaySubscriptionCoverage";
import { Subject, type Observable, type Subscription } from "rxjs";

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
  private activeChanges: Subscription | undefined;
  private readonly changes = new Subject<void>();

  /** Emits when the active lease changes or accepts a lifecycle transition. */
  readonly changes$: Observable<void> = this.changes.asObservable();

  activate(pubkey: string, coverage: RelaySubscriptionCoverage): () => void {
    this.activeChanges?.unsubscribe();
    this.active?.coverage.stop();
    this.active = { pubkey, coverage };
    this.activeChanges = coverage.changes$.subscribe(() => this.changes.next());
    this.changes.next();

    return () => {
      if (this.active?.coverage === coverage) {
        this.activeChanges?.unsubscribe();
        this.activeChanges = undefined;
        this.active = undefined;
        coverage.stop();
        this.changes.next();
      } else {
        coverage.stop();
      }
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
