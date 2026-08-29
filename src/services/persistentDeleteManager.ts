import { DeleteManager, type DeleteEventNotification } from "applesauce-core";
import type { NostrEvent } from "nostr-tools";
import { BehaviorSubject } from "rxjs";

export interface PersistentDeleteManagerOptions {
  /** Load previously accepted kind-5 events from durable storage. */
  load: () => Promise<NostrEvent[]>;
  /** Persist a newly accepted kind-5 event. */
  save: (event: NostrEvent) => Promise<unknown>;
  /** Verify a kind-5 event before it can affect deletion state. */
  verify: (event: NostrEvent) => boolean;
  /** Report cache failures without disabling in-memory deletion handling. */
  onError?: (operation: "load" | "save", error: unknown) => void;
}

/**
 * Applesauce's DeleteManager with durable, verified kind-5 tombstones.
 *
 * EventStore deliberately treats deletion events as transient state: kind 5
 * is sent to DeleteManager but never emitted on EventStore.insert$. This
 * wrapper stores those events separately and can hydrate them before cached
 * originals are loaded into the EventStore on the next application start.
 */
export class PersistentDeleteManager extends DeleteManager {
  private hydration: Promise<void> | undefined;
  private readonly pendingWrites = new Set<Promise<void>>();
  private readonly evidenceById = new Map<string, NostrEvent>();
  private readonly evidenceSubject = new BehaviorSubject<NostrEvent[]>([]);
  readonly evidence$ = this.evidenceSubject.asObservable();

  constructor(private readonly options: PersistentDeleteManagerOptions) {
    super();
  }

  private isValidDeletion(event: NostrEvent): boolean {
    if (event.kind !== 5) return false;

    try {
      return this.options.verify(event);
    } catch {
      return false;
    }
  }

  private retainEvidence(event: NostrEvent, emit = true): void {
    if (this.evidenceById.has(event.id)) return;
    this.evidenceById.set(event.id, event);
    if (emit) this.evidenceSubject.next([...this.evidenceById.values()]);
  }

  /** Restore tombstone state without writing the same events back to cache. */
  hydrate(): Promise<void> {
    if (!this.hydration) {
      this.hydration = this.options
        .load()
        .then((events) => {
          for (const event of events) {
            if (!this.isValidDeletion(event)) continue;
            const notifications = super.add(event);
            if (notifications.length > 0) this.retainEvidence(event, false);
          }
          this.evidenceSubject.next([...this.evidenceById.values()]);
        })
        .catch((error: unknown) => {
          this.options.onError?.("load", error);
        });
    }

    return this.hydration;
  }

  override add(deleteEvent: NostrEvent): DeleteEventNotification[] {
    if (!this.isValidDeletion(deleteEvent)) return [];

    const notifications = super.add(deleteEvent);
    if (notifications.length === 0) return notifications;
    this.retainEvidence(deleteEvent);

    let write: Promise<void>;
    try {
      // Invoke save immediately so the IndexedDB transaction is queued in the
      // same turn as the in-memory deletion.
      write = Promise.resolve(this.options.save(deleteEvent))
        .then(() => undefined)
        .catch((error: unknown) => {
          this.options.onError?.("save", error);
        });
    } catch (error: unknown) {
      this.options.onError?.("save", error);
      return notifications;
    }

    this.pendingWrites.add(write);
    void write.finally(() => this.pendingWrites.delete(write));

    return notifications;
  }

  /** Wait for writes already queued by add(); useful before controlled exits. */
  async flush(): Promise<void> {
    await Promise.all([...this.pendingWrites]);
  }
}
