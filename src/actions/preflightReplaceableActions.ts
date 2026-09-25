/**
 * Replaceable actions that consume state already resolved by preflight.
 *
 * These deliberately do not read EventStore models. A missing replaceable
 * model normally invokes the store's fallback loader, but the robust writer
 * has already established relay coverage and checked IndexedDB before calling
 * these actions. Reading again would add latency and a redundant relay REQ.
 * Contact relay arrays are retained for Action API parity. Mailbox actions use
 * the relay argument to carry the frozen old outboxes into GitWorkshop's
 * global runner, while the signed event supplies the proposed frontier.
 */

import type { Action } from "applesauce-actions";
import { ContactsFactory } from "applesauce-common/factories";
import { MailboxesFactory } from "applesauce-core/factories";
import {
  getOutboxes,
  isMailboxesEvent,
  type ProfilePointer,
} from "applesauce-core/helpers";
import type { NostrEvent } from "nostr-tools";

function knownContactsFactory(event: NostrEvent | undefined): ContactsFactory {
  return event ? ContactsFactory.modify(event) : ContactsFactory.create();
}

/** Add a contact to the exact kind:3 event resolved by preflight. */
export function FollowUserFromPreflight(
  event: NostrEvent | undefined,
  outboxes: string[],
  pointer: string | ProfilePointer,
): Action {
  return async ({ publish, signer }) => {
    const signed = await knownContactsFactory(event)
      .addContact(pointer)
      .sign(signer);
    await publish(signed, outboxes);
  };
}

/** Remove a contact from the exact kind:3 event resolved by preflight. */
export function UnfollowUserFromPreflight(
  event: NostrEvent | undefined,
  outboxes: string[],
  pointer: string | ProfilePointer,
): Action {
  return async ({ publish, signer }) => {
    const signed = await knownContactsFactory(event)
      .removeContact(pointer)
      .sign(signer);
    await publish(signed, outboxes);
  };
}

function knownMailboxes(event: NostrEvent | undefined): {
  factory: MailboxesFactory;
  oldOutboxes: string[] | undefined;
} {
  if (event === undefined) {
    return { factory: MailboxesFactory.create(), oldOutboxes: undefined };
  }
  if (!isMailboxesEvent(event)) {
    throw new Error("Preflight event is not a NIP-65 relay list");
  }
  return {
    factory: MailboxesFactory.modify(event),
    oldOutboxes: getOutboxes(event),
  };
}

/** Add inbox relays to the exact kind:10002 event resolved by preflight. */
export function AddInboxRelayFromPreflight(
  event: NostrEvent | undefined,
  relay: string | string[],
): Action {
  const relays = Array.isArray(relay) ? relay : [relay];
  return async ({ publish, signer }) => {
    const { factory, oldOutboxes } = knownMailboxes(event);
    let next = factory;
    for (const url of relays) next = next.addInbox(url);
    const signed = await next.sign(signer);
    await publish(signed, oldOutboxes);
  };
}

/** Remove inbox relays from the exact kind:10002 event resolved by preflight. */
export function RemoveInboxRelayFromPreflight(
  event: NostrEvent | undefined,
  relay: string | string[],
): Action {
  const relays = Array.isArray(relay) ? relay : [relay];
  return async ({ publish, signer }) => {
    const { factory, oldOutboxes } = knownMailboxes(event);
    if (oldOutboxes === undefined) return;
    let next = factory;
    for (const url of relays) next = next.removeInbox(url);
    const signed = await next.sign(signer);
    await publish(signed, oldOutboxes);
  };
}

/** Add outbox relays to the exact kind:10002 event resolved by preflight. */
export function AddOutboxRelayFromPreflight(
  event: NostrEvent | undefined,
  relay: string | string[],
): Action {
  const relays = Array.isArray(relay) ? relay : [relay];
  return async ({ publish, signer }) => {
    const { factory, oldOutboxes } = knownMailboxes(event);
    let next = factory;
    for (const url of relays) next = next.addOutbox(url);
    const signed = await next.sign(signer);
    await publish(signed, oldOutboxes);
  };
}

/** Remove outbox relays from the exact kind:10002 event resolved by preflight. */
export function RemoveOutboxRelayFromPreflight(
  event: NostrEvent | undefined,
  relay: string | string[],
): Action {
  const relays = Array.isArray(relay) ? relay : [relay];
  return async ({ publish, signer }) => {
    const { factory, oldOutboxes } = knownMailboxes(event);
    if (oldOutboxes === undefined) return;
    let next = factory;
    for (const url of relays) next = next.removeOutbox(url);
    const signed = await next.sign(signer);
    await publish(signed, oldOutboxes);
  };
}
