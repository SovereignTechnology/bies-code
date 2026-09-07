import { ActionRunner } from "applesauce-actions";
import { getOutboxes } from "applesauce-core/helpers";
import type { NostrEvent } from "nostr-tools";
import { bestEffortRelayGroupId, fixedRelayGroupId } from "./outbox";
import { eventStore, publish } from "./nostr";
import { accounts } from "./accounts";

/**
 * Publish function passed to the ActionRunner.
 *
 * Category publication routing lives in nostr.publish() so direct writers and
 * ActionRunner-based writers receive the same durable outbox policy. NIP-65
 * edits additionally freeze their old and proposed outbox frontiers here. The
 * old frontier is attempted as best-effort because a dead relay is commonly
 * the reason for the edit; the proposed frontier remains required.
 */
function runnerPublish(
  event: NostrEvent,
  actionRelays?: string[],
): Promise<void> {
  if (event.kind !== 10002) return publish(event);

  const oldFrontier = fixedRelayGroupId(actionRelays ?? []);
  const frozenGroups = [
    oldFrontier ? bestEffortRelayGroupId(oldFrontier) : undefined,
    fixedRelayGroupId(getOutboxes(event)),
  ].filter((group): group is string => group !== undefined);
  return publish(event, frozenGroups);
}

/**
 * Global ActionRunner instance for executing pre-built Nostr actions.
 * Examples: UpdateProfile, CreateNote, etc.
 *
 * In Applesauce v6 the ActionRunner takes the signer directly — the
 * `EventFactory` singleton is gone, and actions instantiate typed factories
 * (e.g. `IssueFactory`, `ProfileFactory`) per-call.
 *
 * Relay-hint resolution (`getEventRelayHint` / `getPubkeyRelayHint`) now
 * lives in `src/factories/hints.ts` and is passed per-call into tag
 * operations such as `addProfilePointerTag(pubkey, getPubkeyRelayHint)`.
 *
 * Uses `accounts.signer` — a ProxySigner that automatically tracks the
 * active account, so switching accounts is reflected immediately without
 * recreating the runner.
 *
 * Usage:
 * ```ts
 * import { runner } from '@/services/actions';
 *
 * await runner.run(UpdateProfile, { name: 'Alice' });
 * ```
 */
export const runner = new ActionRunner(
  eventStore,
  accounts.signer,
  runnerPublish,
);
