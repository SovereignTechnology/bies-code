/**
 * Notification action implementations.
 *
 * Pure functions that mutate the NotificationReadState via updateReadState().
 * They read current events synchronously from the EventStore — no stale refs,
 * no React dependency — so they are testable without rendering components.
 */

import { getZapEventPointer } from "applesauce-common/helpers";
import {
  buildNotificationFilters,
  buildThreadEventMap,
  buildRepoStarFilter,
  buildRepoZapFilter,
  getNotificationRootId,
  isNotificationEventFromSelf,
  isEventRead,
  isEventArchived,
  advanceReadCutoff,
  advanceArchivedCutoff,
  REPO_STARS_PREFIX,
  REPO_ZAPS_PREFIX,
  REACTION_KIND,
  ZAP_RECEIPT_KIND,
  type NotificationReadState,
} from "@/lib/notifications";
import { eventStore } from "@/services/nostr";
import type { NostrEvent } from "nostr-tools";
import type { NotificationStoreEntry } from "./notificationStore";
import { updateReadState } from "./notificationStore";

// ---------------------------------------------------------------------------
// Helpers
// ---------------------------------------------------------------------------

/** True if rootId is a synthetic social rootId (not a Nostr event ID) */
function isSocialRootId(rootId: string): boolean {
  return (
    rootId.startsWith(REPO_STARS_PREFIX) || rootId.startsWith(REPO_ZAPS_PREFIX)
  );
}

/**
 * Get all notification events (thread + social) for cutoff advancement.
 * Used by mark-all actions that need the full event set.
 */
function getAllNotificationEvents(entry: NotificationStoreEntry): NostrEvent[] {
  const coords = entry.repoCoords$.getValue();
  const thread = eventStore.getByFilters(
    buildNotificationFilters(entry.pubkey),
  ) as NostrEvent[];
  const stars =
    coords.length > 0
      ? (eventStore.getByFilters([buildRepoStarFilter(coords)]) as NostrEvent[])
      : [];
  const repoZaps =
    coords.length > 0
      ? (eventStore.getByFilters([buildRepoZapFilter(coords)]) as NostrEvent[])
      : [];
  return [...thread, ...stars, ...repoZaps];
}

/** Include zap targets before indexing their locally available parent chains. */
function buildNotificationThreadEventMap(
  events: NostrEvent[],
): Map<string, NostrEvent> {
  const zappedTargetIds = [
    ...new Set(
      events
        .filter((event) => event.kind === ZAP_RECEIPT_KIND)
        .flatMap((event) => {
          const target = getZapEventPointer(event);
          return target ? [target.id] : [];
        }),
    ),
  ];
  const zappedTargets =
    zappedTargetIds.length > 0
      ? (eventStore.getByFilters([{ ids: zappedTargetIds }]) as NostrEvent[])
      : [];
  return buildThreadEventMap(
    [...events, ...zappedTargets],
    (id) => (eventStore.getByFilters([{ ids: [id] }]) as NostrEvent[])[0],
  );
}

// ---------------------------------------------------------------------------
// Actions
// ---------------------------------------------------------------------------

/**
 * Extract the events belonging to a rootId from an already-fetched allEvents
 * array, avoiding redundant EventStore queries.
 */
function filterEventsForRootId(
  allEvents: NostrEvent[],
  rootId: string,
  selfPubkey: string,
): NostrEvent[] {
  if (isSocialRootId(rootId)) {
    // Strip prefix to get the raw coord (same length stripping for both prefixes)
    const isZap = rootId.startsWith(REPO_ZAPS_PREFIX);
    const prefix = isZap ? REPO_ZAPS_PREFIX : REPO_STARS_PREFIX;
    const coord = rootId.slice(prefix.length);
    // Filter by kind to avoid accidentally matching thread events (e.g. status
    // changes, PRs) that also carry an #a tag pointing to the same repo coord.
    const expectedKind = isZap ? ZAP_RECEIPT_KIND : REACTION_KIND;
    return allEvents.filter(
      (ev) =>
        ev.kind === expectedKind &&
        !isNotificationEventFromSelf(ev, selfPubkey) &&
        ev.tags.some(([t, v]) => t === "a" && v === coord),
    );
  }
  const threadEvents = buildNotificationThreadEventMap(allEvents);
  return allEvents.filter(
    (ev) =>
      !isNotificationEventFromSelf(ev, selfPubkey) &&
      getNotificationRootId(ev, threadEvents) === rootId,
  );
}

function filterEventsById(
  allEvents: NostrEvent[],
  eventIds: string[],
  selfPubkey: string,
): NostrEvent[] {
  const eventIdSet = new Set(eventIds);
  return allEvents.filter(
    (event) =>
      !isNotificationEventFromSelf(event, selfPubkey) &&
      eventIdSet.has(event.id),
  );
}

export function actionMarkAsRead(
  entry: NotificationStoreEntry,
  rootId: string,
): void {
  updateReadState(entry, (prev) => {
    const allEvents = getAllNotificationEvents(entry);
    const rootEvents = filterEventsForRootId(allEvents, rootId, entry.pubkey);
    const readIdSet = new Set(prev.ri);
    const newlyReadIds = rootEvents
      .filter((ev) => !isEventRead(ev, prev, readIdSet))
      .map((ev) => ev.id);

    if (newlyReadIds.length === 0) return prev;

    const updated = { ...prev, ri: [...prev.ri, ...newlyReadIds] };
    const cutoff = advanceReadCutoff(allEvents, updated, entry.pubkey);
    return { ...updated, ...cutoff };
  });
}

/** Mark a selected set of notification events as read in one state update. */
export function actionMarkEventsAsRead(
  entry: NotificationStoreEntry,
  eventIds: string[],
): void {
  updateReadState(entry, (prev) => {
    const allEvents = getAllNotificationEvents(entry);
    const selectedEvents = filterEventsById(allEvents, eventIds, entry.pubkey);
    const readIdSet = new Set(prev.ri);
    const newlyReadIds = selectedEvents
      .filter((event) => !isEventRead(event, prev, readIdSet))
      .map((event) => event.id);

    if (newlyReadIds.length === 0) return prev;

    const updated = {
      ...prev,
      ri: [...new Set([...prev.ri, ...newlyReadIds])],
    };
    const cutoff = advanceReadCutoff(allEvents, updated, entry.pubkey);
    return { ...updated, ...cutoff };
  });
}

/** Mark one notification event as read without changing its sibling activity. */
export function actionMarkEventAsRead(
  entry: NotificationStoreEntry,
  eventId: string,
): void {
  updateReadState(entry, (prev) => {
    const allEvents = getAllNotificationEvents(entry);
    const event = allEvents.find(
      (candidate) =>
        candidate.id === eventId &&
        !isNotificationEventFromSelf(candidate, entry.pubkey),
    );
    if (!event || isEventRead(event, prev, new Set(prev.ri))) return prev;

    const updated = { ...prev, ri: [...prev.ri, eventId] };
    const cutoff = advanceReadCutoff(allEvents, updated, entry.pubkey);
    return { ...updated, ...cutoff };
  });
}

export function actionMarkAsUnread(
  entry: NotificationStoreEntry,
  rootId: string,
): void {
  updateReadState(entry, (prev) => {
    const allEvents = getAllNotificationEvents(entry);
    const rootEvents = filterEventsForRootId(allEvents, rootId, entry.pubkey);
    if (rootEvents.length === 0) return prev;

    const rootEventIds = new Set(rootEvents.map((ev) => ev.id));
    let newRi = prev.ri.filter((id) => !rootEventIds.has(id));

    const oldestInRoot = Math.min(...rootEvents.map((ev) => ev.created_at));
    let newRb = prev.rb;

    if (oldestInRoot <= prev.rb) {
      newRb = oldestInRoot - 1;
      const reMarkIds = allEvents
        .filter(
          (ev) =>
            !isNotificationEventFromSelf(ev, entry.pubkey) &&
            ev.created_at > newRb &&
            ev.created_at <= prev.rb &&
            !rootEventIds.has(ev.id) &&
            !newRi.includes(ev.id),
        )
        .map((ev) => ev.id);
      newRi = [...newRi, ...reMarkIds];
    }

    const updated = { ...prev, rb: newRb, ri: newRi };
    const cutoff = advanceReadCutoff(allEvents, updated, entry.pubkey);
    return { ...updated, ...cutoff };
  });
}

/** Mark a selected set of notification events as unread in one state update. */
export function actionMarkEventsAsUnread(
  entry: NotificationStoreEntry,
  eventIds: string[],
): void {
  updateReadState(entry, (prev) => {
    const allEvents = getAllNotificationEvents(entry);
    const selectedEvents = filterEventsById(allEvents, eventIds, entry.pubkey);
    if (selectedEvents.length === 0) return prev;

    const selectedIds = new Set(selectedEvents.map((event) => event.id));
    let newRi = prev.ri.filter((id) => !selectedIds.has(id));
    const oldestSelectedAt = Math.min(
      ...selectedEvents.map((event) => event.created_at),
    );
    let newRb = prev.rb;

    if (oldestSelectedAt <= prev.rb) {
      newRb = oldestSelectedAt - 1;
      const reMarkIds = allEvents
        .filter(
          (event) =>
            !isNotificationEventFromSelf(event, entry.pubkey) &&
            event.created_at > newRb &&
            event.created_at <= prev.rb &&
            !selectedIds.has(event.id) &&
            !newRi.includes(event.id),
        )
        .map((event) => event.id);
      newRi = [...newRi, ...reMarkIds];
    }

    const updated = { ...prev, rb: newRb, ri: newRi };
    const cutoff = advanceReadCutoff(allEvents, updated, entry.pubkey);
    return { ...updated, ...cutoff };
  });
}

export function actionMarkAsArchived(
  entry: NotificationStoreEntry,
  rootId: string,
): void {
  updateReadState(entry, (prev) => {
    const allEvents = getAllNotificationEvents(entry);
    const rootEvents = filterEventsForRootId(allEvents, rootId, entry.pubkey);
    const archivedIdSet = new Set(prev.ai);

    const newlyArchivedIds = rootEvents
      .filter((ev) => !isEventArchived(ev, prev, archivedIdSet))
      .map((ev) => ev.id);

    if (newlyArchivedIds.length === 0) return prev;

    let updated = { ...prev, ai: [...prev.ai, ...newlyArchivedIds] };
    const archivedCutoff = advanceArchivedCutoff(
      allEvents,
      updated,
      entry.pubkey,
    );
    updated = { ...updated, ...archivedCutoff };

    // Archived items are always read too
    const readIdSet = new Set(updated.ri);
    const newlyReadIds = rootEvents
      .filter((ev) => !isEventRead(ev, updated, readIdSet))
      .map((ev) => ev.id);
    if (newlyReadIds.length > 0) {
      updated = { ...updated, ri: [...updated.ri, ...newlyReadIds] };
      const readCutoff = advanceReadCutoff(allEvents, updated, entry.pubkey);
      updated = { ...updated, ...readCutoff };
    }

    return updated;
  });
}

/** Archive a selected set of notification events and mark them as read. */
export function actionMarkEventsAsArchived(
  entry: NotificationStoreEntry,
  eventIds: string[],
): void {
  updateReadState(entry, (prev) => {
    const allEvents = getAllNotificationEvents(entry);
    const selectedEvents = filterEventsById(allEvents, eventIds, entry.pubkey);
    const archivedIdSet = new Set(prev.ai);
    const newlyArchivedIds = selectedEvents
      .filter((event) => !isEventArchived(event, prev, archivedIdSet))
      .map((event) => event.id);

    if (newlyArchivedIds.length === 0) return prev;

    let updated = {
      ...prev,
      ai: [...new Set([...prev.ai, ...newlyArchivedIds])],
    };
    updated = {
      ...updated,
      ...advanceArchivedCutoff(allEvents, updated, entry.pubkey),
    };

    const readIdSet = new Set(updated.ri);
    const newlyReadIds = selectedEvents
      .filter((event) => !isEventRead(event, updated, readIdSet))
      .map((event) => event.id);
    if (newlyReadIds.length > 0) {
      updated = {
        ...updated,
        ri: [...new Set([...updated.ri, ...newlyReadIds])],
      };
      updated = {
        ...updated,
        ...advanceReadCutoff(allEvents, updated, entry.pubkey),
      };
    }

    return updated;
  });
}

/** Archive one notification event without archiving its sibling activity. */
export function actionMarkEventAsArchived(
  entry: NotificationStoreEntry,
  eventId: string,
): void {
  updateReadState(entry, (prev) => {
    const allEvents = getAllNotificationEvents(entry);
    const event = allEvents.find(
      (candidate) =>
        candidate.id === eventId &&
        !isNotificationEventFromSelf(candidate, entry.pubkey),
    );
    if (!event || isEventArchived(event, prev, new Set(prev.ai))) return prev;

    let updated = { ...prev, ai: [...prev.ai, eventId] };
    const archivedCutoff = advanceArchivedCutoff(
      allEvents,
      updated,
      entry.pubkey,
    );
    updated = { ...updated, ...archivedCutoff };

    if (!isEventRead(event, updated, new Set(updated.ri))) {
      updated = { ...updated, ri: [...updated.ri, eventId] };
      const readCutoff = advanceReadCutoff(allEvents, updated, entry.pubkey);
      updated = { ...updated, ...readCutoff };
    }

    return updated;
  });
}

/** Restore one notification event without restoring its sibling activity. */
export function actionMarkEventAsUnarchived(
  entry: NotificationStoreEntry,
  eventId: string,
): void {
  let archiveCutoffLowered = false;
  updateReadState(entry, (prev) => {
    const allEvents = getAllNotificationEvents(entry);
    const event = allEvents.find(
      (candidate) =>
        candidate.id === eventId &&
        !isNotificationEventFromSelf(candidate, entry.pubkey),
    );
    if (!event || !isEventArchived(event, prev, new Set(prev.ai))) return prev;

    let newAi = prev.ai.filter((id) => id !== eventId);
    let newAb = prev.ab;

    if (event.created_at <= prev.ab) {
      newAb = event.created_at - 1;
      archiveCutoffLowered = true;
      const reMarkIds = allEvents
        .filter(
          (candidate) =>
            !isNotificationEventFromSelf(candidate, entry.pubkey) &&
            candidate.created_at > newAb &&
            candidate.created_at <= prev.ab &&
            candidate.id !== eventId &&
            !newAi.includes(candidate.id),
        )
        .map((candidate) => candidate.id);
      newAi = [...newAi, ...reMarkIds];
    }

    const updated = { ...prev, ab: newAb, ai: newAi };
    const cutoff = advanceArchivedCutoff(allEvents, updated, entry.pubkey);
    return { ...updated, ...cutoff };
  });
  if (archiveCutoffLowered) entry.historyLoader?.recheckArchiveCutoff();
}

export function actionMarkAsUnarchived(
  entry: NotificationStoreEntry,
  rootId: string,
): void {
  let archiveCutoffLowered = false;
  updateReadState(entry, (prev) => {
    const allEvents = getAllNotificationEvents(entry);
    const rootEvents = filterEventsForRootId(allEvents, rootId, entry.pubkey);
    if (rootEvents.length === 0) return prev;

    const rootEventIds = new Set(rootEvents.map((ev) => ev.id));
    let newAi = prev.ai.filter((id) => !rootEventIds.has(id));

    const oldestInRoot = Math.min(...rootEvents.map((ev) => ev.created_at));
    let newAb = prev.ab;

    if (oldestInRoot <= prev.ab) {
      newAb = oldestInRoot - 1;
      archiveCutoffLowered = true;
      const reMarkIds = allEvents
        .filter(
          (ev) =>
            !isNotificationEventFromSelf(ev, entry.pubkey) &&
            ev.created_at > newAb &&
            ev.created_at <= prev.ab &&
            !rootEventIds.has(ev.id) &&
            !newAi.includes(ev.id),
        )
        .map((ev) => ev.id);
      newAi = [...newAi, ...reMarkIds];
    }

    const updated = { ...prev, ab: newAb, ai: newAi };
    const cutoff = advanceArchivedCutoff(allEvents, updated, entry.pubkey);
    return { ...updated, ...cutoff };
  });
  if (archiveCutoffLowered) entry.historyLoader?.recheckArchiveCutoff();
}

/** Restore a selected set of notification events to the inbox. */
export function actionMarkEventsAsUnarchived(
  entry: NotificationStoreEntry,
  eventIds: string[],
): void {
  let archiveCutoffLowered = false;
  updateReadState(entry, (prev) => {
    const allEvents = getAllNotificationEvents(entry);
    const selectedEvents = filterEventsById(allEvents, eventIds, entry.pubkey);
    const archivedIdSet = new Set(prev.ai);
    const archivedEvents = selectedEvents.filter((event) =>
      isEventArchived(event, prev, archivedIdSet),
    );
    if (archivedEvents.length === 0) return prev;

    const selectedIds = new Set(archivedEvents.map((event) => event.id));
    let newAi = prev.ai.filter((id) => !selectedIds.has(id));
    const oldestSelectedAt = Math.min(
      ...archivedEvents.map((event) => event.created_at),
    );
    let newAb = prev.ab;

    if (oldestSelectedAt <= prev.ab) {
      newAb = oldestSelectedAt - 1;
      archiveCutoffLowered = true;
      const reMarkIds = allEvents
        .filter(
          (event) =>
            !isNotificationEventFromSelf(event, entry.pubkey) &&
            event.created_at > newAb &&
            event.created_at <= prev.ab &&
            !selectedIds.has(event.id) &&
            !newAi.includes(event.id),
        )
        .map((event) => event.id);
      newAi = [...newAi, ...reMarkIds];
    }

    const updated = { ...prev, ab: newAb, ai: newAi };
    const cutoff = advanceArchivedCutoff(allEvents, updated, entry.pubkey);
    return { ...updated, ...cutoff };
  });
  if (archiveCutoffLowered) entry.historyLoader?.recheckArchiveCutoff();
}

export function actionMarkAllAsRead(entry: NotificationStoreEntry): void {
  updateReadState(entry, (prev) => {
    const events = getAllNotificationEvents(entry);
    const self = entry.pubkey;
    const tenDaysAgo = Math.floor(Date.now() / 1000) - 60 * 60 * 24 * 10;
    const newRi = events
      .filter(
        (ev) =>
          !isNotificationEventFromSelf(ev, self) && ev.created_at > tenDaysAgo,
      )
      .map((ev) => ev.id);
    return { ...prev, rb: tenDaysAgo, ri: newRi };
  });
}

export function actionMarkAllAsArchived(entry: NotificationStoreEntry): void {
  updateReadState(entry, (_prev) => {
    const events = getAllNotificationEvents(entry);
    const self = entry.pubkey;
    const tenDaysAgo = Math.floor(Date.now() / 1000) - 60 * 60 * 24 * 10;
    const allIds = events
      .filter((ev) => !isNotificationEventFromSelf(ev, self))
      .map((ev) => ev.id);
    return { rb: tenDaysAgo, ri: allIds, ab: tenDaysAgo, ai: allIds };
  });
}

// Re-export the state type so callers only need one import
export type { NotificationReadState };
