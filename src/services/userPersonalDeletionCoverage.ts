import type { RelaySubscriptionCoverage } from "@/lib/relaySubscriptionCoverage";
import { Subject, type Observable, type Subscription } from "rxjs";

export interface ActiveUserPersonalDeletionCoverage {
  pubkey: string;
  candidateIds: ReadonlyMap<number, string>;
  coverage: RelaySubscriptionCoverage;
}

/**
 * Owns the active account's one batched personal-deletion query.
 *
 * Candidate IDs are part of the lease identity: an EOSE for yesterday's exact
 * pointers cannot prove that today's replacement has no exact deletion.
 */
export class UserPersonalDeletionCoverageOwner {
  private active: ActiveUserPersonalDeletionCoverage | undefined;
  private activeChanges: Subscription | undefined;
  private readonly changes = new Subject<void>();

  readonly changes$: Observable<void> = this.changes.asObservable();

  activate(
    pubkey: string,
    candidateIds: ReadonlyMap<number, string>,
    coverage: RelaySubscriptionCoverage,
  ): () => void {
    this.activeChanges?.unsubscribe();
    this.active?.coverage.stop();
    this.active = {
      pubkey,
      candidateIds: new Map(candidateIds),
      coverage,
    };
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

  get(pubkey: string): ActiveUserPersonalDeletionCoverage | undefined {
    return this.active?.pubkey === pubkey ? this.active : undefined;
  }
}

export const userPersonalDeletionCoverage =
  new UserPersonalDeletionCoverageOwner();
