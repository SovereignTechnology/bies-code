import { useState, useCallback, useEffect, useId, useMemo } from "react";
import { useActiveAccount } from "applesauce-react/hooks";
import { useSeoMeta } from "@unhead/react";
import { useNotifications } from "@/hooks/useNotifications";
import { Button } from "@/components/ui/button";
import { Badge } from "@/components/ui/badge";
import {
  Select,
  SelectContent,
  SelectItem,
  SelectTrigger,
  SelectValue,
} from "@/components/ui/select";
import { ToggleGroup, ToggleGroupItem } from "@/components/ui/toggle-group";
import { UserAvatar, UserName } from "@/components/UserAvatar";
import { cn } from "@/lib/utils";
import {
  Bell,
  Archive,
  ArchiveRestore,
  Inbox,
  MailOpen,
  List,
  Check,
  ChevronLeft,
  ChevronRight,
  ChevronsLeft,
  ChevronsRight,
  Loader2,
  Eye,
  EyeOff,
  ChevronDown,
} from "lucide-react";
import {
  NotificationRow,
  NotificationActivityRow,
  NotificationSkeleton,
  type ViewTab,
} from "@/components/NotificationRow";
import { useNotificationPageEssentials } from "@/hooks/useNotificationPageEssentials";
import {
  getNotificationActorPubkey,
  getUnreadInboxEventIds,
} from "@/lib/notifications";
import type {
  NotificationItem,
  ThreadNotificationItem,
} from "@/lib/notifications";
import type { NostrEvent } from "nostr-tools";
import { getZapAmount } from "applesauce-common/helpers";
import { useRelativeTime } from "@/hooks/useRelativeTime";
import { NotificationSwipeSurface } from "@/components/NotificationSwipeSurface";

const ITEMS_PER_PAGE = 10;
const USER_ACTIVITY_PAGE_SIZE = 10;

type GroupingMode = "root" | "user" | "activity";

interface UserNotificationGroup {
  pubkey: string;
  eventIds: string[];
  unreadEventIds: string[];
  rootCount: number;
  latestActivity: number;
  activities: Array<{ item: NotificationItem; event: NostrEvent }>;
}

type ActivityDisplayEntry =
  | { type: "item"; item: NotificationItem; key?: string }
  | { type: "activity"; item: ThreadNotificationItem; event: NostrEvent };

type NotificationDisplayEntry =
  | ActivityDisplayEntry
  | { type: "user"; group: UserNotificationGroup };

export default function NotificationsPage() {
  const activeAccount = useActiveAccount();
  const { items, unreadCount, actions, history } = useNotifications();
  const [currentView, setCurrentView] = useState<ViewTab>("inbox");
  const [currentPage, setCurrentPage] = useState(1);
  const [groupingMode, setGroupingMode] = useState<GroupingMode>("root");

  useSeoMeta({
    title:
      unreadCount > 0
        ? `(${unreadCount}) Notifications - ngit`
        : "Notifications - ngit",
    description: "Your notification inbox",
    ogImage: "/og-image.png",
    ogImageWidth: 1200,
    ogImageHeight: 630,
    twitterCard: "summary_large_image",
  });

  // Filter items by current view
  const filteredItems = useMemo(() => {
    if (!items) return undefined;
    if (currentView === "all") return items;

    return items.flatMap((item) => {
      const archivedIds = new Set(item.archivedEventIds);
      const unreadInboxIds = new Set(getUnreadInboxEventIds(item));
      const visibleEvents = item.events.filter((event) => {
        switch (currentView) {
          case "inbox":
            return !archivedIds.has(event.id);
          case "unread":
            return unreadInboxIds.has(event.id);
          case "archived":
            return archivedIds.has(event.id);
        }
      });

      return visibleEvents.length > 0
        ? [notificationItemWithEvents(item, visibleEvents)]
        : [];
    });
  }, [items, currentView]);

  const displayEntries = useMemo<NotificationDisplayEntry[] | undefined>(() => {
    if (!items || !filteredItems) return undefined;
    if (groupingMode === "root") {
      return filteredItems.map((item) => ({ type: "item", item }));
    }

    if (groupingMode === "user") {
      const groups = new Map<
        string,
        {
          eventIds: Set<string>;
          unreadEventIds: Set<string>;
          rootIds: Set<string>;
          latestActivity: number;
          activities: Map<
            string,
            { item: NotificationItem; event: NostrEvent }
          >;
        }
      >();

      for (const item of items) {
        const archivedIds = new Set(item.archivedEventIds);
        const unreadIds = new Set(item.unreadEventIds);

        for (const event of item.events) {
          const isArchived = archivedIds.has(event.id);
          const isVisible =
            currentView === "all" ||
            (currentView === "inbox" && !isArchived) ||
            (currentView === "unread" &&
              !isArchived &&
              unreadIds.has(event.id)) ||
            (currentView === "archived" && isArchived);
          if (!isVisible) continue;

          const actorPubkey = getNotificationActorPubkey(event);
          const group = groups.get(actorPubkey) ?? {
            eventIds: new Set<string>(),
            unreadEventIds: new Set<string>(),
            rootIds: new Set<string>(),
            latestActivity: 0,
            activities: new Map(),
          };
          group.eventIds.add(event.id);
          if (unreadIds.has(event.id)) group.unreadEventIds.add(event.id);
          group.rootIds.add(item.rootId);
          group.activities.set(event.id, { item, event });
          group.latestActivity = Math.max(
            group.latestActivity,
            event.created_at,
          );
          groups.set(actorPubkey, group);
        }
      }

      return [...groups.entries()]
        .map(([pubkey, group]) => ({
          type: "user" as const,
          group: {
            pubkey,
            eventIds: [...group.eventIds],
            unreadEventIds: [...group.unreadEventIds],
            rootCount: group.rootIds.size,
            latestActivity: group.latestActivity,
            activities: [...group.activities.values()].sort(
              (a, b) => a.event.created_at - b.event.created_at,
            ),
          },
        }))
        .sort((a, b) => b.group.latestActivity - a.group.latestActivity);
    }

    const entries = items.flatMap<ActivityDisplayEntry>((item) => {
      const archivedIds = new Set(item.archivedEventIds);
      const events = item.events.filter((event) => {
        const isArchived = archivedIds.has(event.id);
        return currentView === "inbox"
          ? !isArchived
          : currentView === "unread"
            ? !isArchived && item.unreadEventIds.includes(event.id)
            : currentView === "archived"
              ? isArchived
              : true;
      });

      // Repository stars remain repository-level notifications, but only the
      // events belonging to the active inbox filter are shown in that row.
      if (item.kind === "repo-star") {
        return events.length > 0
          ? [
              {
                type: "item",
                item: notificationItemWithEvents(item, events),
              },
            ]
          : [];
      }

      if (item.kind === "repo-zap") {
        return events.map((event) => ({
          type: "item",
          key: event.id,
          item: singleEventItem(item, event),
        }));
      }

      return events.map((event) => ({ type: "activity", item, event }));
    });

    // Grouped items are ordered by their latest activity. Once expanded, each
    // activity needs its own global ordering before pagination.
    return entries.sort((a, b) => {
      const aTime =
        a.type === "activity" ? a.event.created_at : a.item.latestActivity;
      const bTime =
        b.type === "activity" ? b.event.created_at : b.item.latestActivity;
      return bTime - aTime;
    });
  }, [currentView, filteredItems, groupingMode, items]);

  // Pagination — reset currentPage when the list shrinks past it (#10)
  const totalPages = displayEntries
    ? Math.max(1, Math.ceil(displayEntries.length / ITEMS_PER_PAGE))
    : 1;
  const safePage = Math.min(currentPage, totalPages);
  useEffect(() => {
    if (currentPage > totalPages) setCurrentPage(totalPages);
  }, [currentPage, totalPages]);
  const pageEntries = displayEntries?.slice(
    (safePage - 1) * ITEMS_PER_PAGE,
    safePage * ITEMS_PER_PAGE,
  );

  const resolvedMap = useNotificationPageEssentials(
    pageEntries?.flatMap((entry) =>
      entry.type === "user" ? [] : [entry.item],
    ) ?? [],
  );

  const unreadInboxEventIds = useMemo(
    () =>
      items?.flatMap((item) => {
        return getUnreadInboxEventIds(item);
      }) ?? [],
    [items],
  );

  // Reset page when switching tabs
  const handleTabChange = useCallback((tab: ViewTab) => {
    setCurrentView(tab);
    setCurrentPage(1);
  }, []);

  const handleGroupingModeChange = useCallback((mode: GroupingMode) => {
    setGroupingMode(mode);
    setCurrentPage(1);
  }, []);

  if (!activeAccount) {
    return (
      <div className="container max-w-screen-xl px-4 md:px-8 py-16">
        <div className="flex flex-col items-center justify-center gap-4 text-center">
          <Bell className="h-12 w-12 text-muted-foreground/40" />
          <p className="text-muted-foreground">
            Sign in to see your notifications
          </p>
        </div>
      </div>
    );
  }

  return (
    <div className="container max-w-screen-xl px-4 md:px-8 py-6">
      {/* Header */}
      <div className="mb-4 flex flex-col gap-3 sm:flex-row sm:items-center sm:justify-between">
        <h1 className="text-xl font-semibold tracking-tight">Notifications</h1>

        {/* Tabs */}
        <div className="hidden w-fit max-w-full items-center gap-1 rounded-lg border border-border/60 bg-muted/30 p-0.5 sm:flex">
          <TabButton
            active={currentView === "inbox"}
            onClick={() => handleTabChange("inbox")}
            icon={Inbox}
            label="Inbox"
          />
          <TabButton
            active={currentView === "unread"}
            onClick={() => handleTabChange("unread")}
            icon={MailOpen}
            label="Unread"
            badge={unreadCount > 0 ? unreadCount : undefined}
          />
          <TabButton
            active={currentView === "archived"}
            onClick={() => handleTabChange("archived")}
            icon={Archive}
            label="Archived"
          />
          <TabButton
            active={currentView === "all"}
            onClick={() => handleTabChange("all")}
            icon={List}
            label="All"
          />
        </div>
      </div>

      {/* Compact mobile filters */}
      <div className="mb-3 rounded-xl border border-border/60 bg-muted/20 p-2 sm:hidden">
        <div className="grid grid-cols-2 gap-2">
          <div className="space-y-1">
            <span className="px-1 text-[11px] font-medium text-muted-foreground">
              View
            </span>
            <Select
              value={currentView}
              onValueChange={(value) => handleTabChange(value as ViewTab)}
            >
              <SelectTrigger
                className="h-9 bg-background px-2.5"
                aria-label="Notification view"
              >
                <SelectValue />
              </SelectTrigger>
              <SelectContent>
                <SelectItem value="inbox">Inbox</SelectItem>
                <SelectItem value="unread">
                  Unread{unreadCount > 0 ? ` (${unreadCount})` : ""}
                </SelectItem>
                <SelectItem value="archived">Archived</SelectItem>
                <SelectItem value="all">All</SelectItem>
              </SelectContent>
            </Select>
          </div>

          <div className="space-y-1">
            <span className="px-1 text-[11px] font-medium text-muted-foreground">
              Group by
            </span>
            <Select
              value={groupingMode}
              onValueChange={(value) =>
                handleGroupingModeChange(value as GroupingMode)
              }
            >
              <SelectTrigger
                className="h-9 bg-background px-2.5"
                aria-label="Notification grouping"
              >
                <SelectValue />
              </SelectTrigger>
              <SelectContent>
                <SelectItem value="root">Item</SelectItem>
                <SelectItem value="user">User</SelectItem>
                <SelectItem value="activity">Activity</SelectItem>
              </SelectContent>
            </Select>
          </div>
        </div>

        {(currentView === "inbox" || currentView === "unread") &&
          displayEntries &&
          displayEntries.length > 0 && (
            <div className="mt-2 grid grid-cols-2 gap-1 border-t border-border/60 pt-2">
              <Button
                variant="ghost"
                size="sm"
                className="h-9 justify-center px-2 text-xs text-muted-foreground hover:text-foreground"
                onClick={
                  currentView === "unread"
                    ? () => actions.markEventsAsRead(unreadInboxEventIds)
                    : actions.markAllAsRead
                }
              >
                <Check className="mr-1 h-3.5 w-3.5" />
                Mark all read
              </Button>
              <Button
                variant="ghost"
                size="sm"
                className="h-9 justify-center px-2 text-xs text-muted-foreground hover:text-foreground"
                onClick={
                  currentView === "unread"
                    ? () => actions.markEventsAsArchived(unreadInboxEventIds)
                    : actions.markAllAsArchived
                }
              >
                <Archive className="mr-1 h-3.5 w-3.5" />
                Archive all
              </Button>
            </div>
          )}
      </div>

      {/* View and bulk actions bar */}
      <div className="mb-2 hidden min-h-9 flex-wrap items-center justify-between gap-3 sm:flex">
        <div className="flex items-center gap-2">
          <span className="text-xs text-muted-foreground">Group by</span>
          <ToggleGroup
            type="single"
            value={groupingMode}
            onValueChange={(value) => {
              if (value) handleGroupingModeChange(value as GroupingMode);
            }}
            variant="outline"
            size="sm"
            aria-label="Notification grouping"
            className="gap-0"
          >
            <ToggleGroupItem
              value="root"
              aria-label="Group notifications by root item"
              className="h-7 rounded-r-none px-2 text-xs"
            >
              Item
            </ToggleGroupItem>
            <ToggleGroupItem
              value="user"
              aria-label="Group notifications by user"
              className="-ml-px h-7 rounded-none px-2 text-xs"
            >
              User
            </ToggleGroupItem>
            <ToggleGroupItem
              value="activity"
              aria-label="Show individual notification activity"
              className="-ml-px h-7 rounded-l-none px-2 text-xs"
            >
              Activity
            </ToggleGroupItem>
          </ToggleGroup>
        </div>
        {(currentView === "inbox" || currentView === "unread") &&
          displayEntries &&
          displayEntries.length > 0 && (
            <div className="ml-auto flex items-center gap-2">
              <Button
                variant="ghost"
                size="sm"
                className="h-7 text-xs text-muted-foreground hover:text-foreground"
                onClick={
                  currentView === "unread"
                    ? () => actions.markEventsAsRead(unreadInboxEventIds)
                    : actions.markAllAsRead
                }
              >
                <Check className="h-3 w-3 mr-1" />
                Mark all read
              </Button>
              <Button
                variant="ghost"
                size="sm"
                className="h-7 text-xs text-muted-foreground hover:text-foreground"
                onClick={
                  currentView === "unread"
                    ? () => actions.markEventsAsArchived(unreadInboxEventIds)
                    : actions.markAllAsArchived
                }
              >
                <Archive className="h-3 w-3 mr-1" />
                Archive all
              </Button>
            </div>
          )}
      </div>

      {/* Notification list */}
      <div className="rounded-lg border border-border/60 bg-card overflow-hidden">
        {!displayEntries || (displayEntries.length === 0 && history.loading) ? (
          // Loading skeleton — also shown when list is empty but still fetching
          // to avoid a flash of the empty state before the first page arrives
          <ul className="divide-y divide-border/40">
            {Array.from({ length: 2 }).map((_, i) => (
              <NotificationSkeleton key={i} />
            ))}
          </ul>
        ) : displayEntries.length === 0 ? (
          // Empty state
          <div className="py-16 px-8 text-center">
            <div className="max-w-sm mx-auto space-y-3">
              {currentView === "inbox" ? (
                <>
                  <Inbox className="h-10 w-10 mx-auto text-muted-foreground/30" />
                  <p className="text-muted-foreground text-sm">
                    Your inbox is empty. Notifications appear when someone
                    interacts with your repositories.
                  </p>
                </>
              ) : currentView === "unread" ? (
                <>
                  <MailOpen className="h-10 w-10 mx-auto text-muted-foreground/30" />
                  <p className="text-muted-foreground text-sm">
                    You have no unread notifications.
                  </p>
                </>
              ) : currentView === "archived" ? (
                <>
                  <Archive className="h-10 w-10 mx-auto text-muted-foreground/30" />
                  <p className="text-muted-foreground text-sm">
                    No archived notifications.
                  </p>
                </>
              ) : (
                <>
                  <Bell className="h-10 w-10 mx-auto text-muted-foreground/30" />
                  <p className="text-muted-foreground text-sm">
                    No notifications yet.
                  </p>
                </>
              )}
            </div>
          </div>
        ) : (
          <ul className="divide-y divide-border/40">
            {pageEntries?.map((entry) =>
              entry.type === "user" ? (
                <NotificationUserGroupRow
                  key={entry.group.pubkey}
                  group={entry.group}
                  actions={actions}
                  currentView={currentView}
                />
              ) : entry.type === "item" ? (
                <NotificationRow
                  key={entry.key ?? entry.item.rootId}
                  item={entry.item}
                  actions={actions}
                  currentView={currentView}
                  resolvedMap={resolvedMap}
                  eventScoped={currentView !== "all"}
                />
              ) : (
                <NotificationActivityRow
                  key={entry.event.id}
                  item={entry.item}
                  event={entry.event}
                  actions={actions}
                  currentView={currentView}
                  resolvedMap={resolvedMap}
                />
              ),
            )}
          </ul>
        )}
      </div>

      {/* History load-more / spinner */}
      {/* On the inbox/unread tabs, hide load more once we've fetched all
          non-archived events (reachedArchive). On archived/all tabs always
          show it so the user can page through archived history. */}
      {(history.loading ||
        (history.hasMore &&
          !(
            (currentView === "inbox" || currentView === "unread") &&
            history.reachedArchive
          ))) && (
        <div className="flex justify-center mt-3">
          {history.loading ? (
            <div className="flex items-center gap-2 text-sm text-muted-foreground py-2">
              <Loader2 className="h-4 w-4 animate-spin" />
              Loading older notifications…
            </div>
          ) : (
            <Button
              variant="ghost"
              size="sm"
              className="text-muted-foreground hover:text-foreground"
              onClick={history.loadMore}
            >
              Load more
            </Button>
          )}
        </div>
      )}

      {/* Pagination */}
      {totalPages > 1 && (
        <div className="flex items-center justify-center gap-1 mt-4">
          <Button
            variant="ghost"
            size="icon"
            className="h-7 w-7"
            disabled={safePage === 1}
            onClick={() => setCurrentPage(1)}
          >
            <ChevronsLeft className="h-3.5 w-3.5" />
          </Button>
          <Button
            variant="ghost"
            size="icon"
            className="h-7 w-7"
            disabled={safePage === 1}
            onClick={() => setCurrentPage((p) => Math.max(1, p - 1))}
          >
            <ChevronLeft className="h-3.5 w-3.5" />
          </Button>

          {Array.from({ length: totalPages }, (_, i) => i + 1)
            .filter(
              (p) =>
                p === safePage ||
                (p >= Math.max(1, safePage - 2) &&
                  p <= Math.min(totalPages, safePage + 2)),
            )
            .map((p) => (
              <Button
                key={p}
                variant={p === safePage ? "default" : "ghost"}
                size="sm"
                className="h-7 w-7 p-0 text-xs"
                onClick={() => setCurrentPage(p)}
              >
                {p}
              </Button>
            ))}

          <Button
            variant="ghost"
            size="icon"
            className="h-7 w-7"
            disabled={safePage === totalPages}
            onClick={() => setCurrentPage((p) => Math.min(totalPages, p + 1))}
          >
            <ChevronRight className="h-3.5 w-3.5" />
          </Button>
          <Button
            variant="ghost"
            size="icon"
            className="h-7 w-7"
            disabled={safePage === totalPages}
            onClick={() => setCurrentPage(totalPages)}
          >
            <ChevronsRight className="h-3.5 w-3.5" />
          </Button>
        </div>
      )}
    </div>
  );
}

function NotificationUserGroupRow({
  group,
  actions,
  currentView,
}: {
  group: UserNotificationGroup;
  actions: ReturnType<typeof useNotifications>["actions"];
  currentView: ViewTab;
}) {
  const [expanded, setExpanded] = useState(false);
  const [visibleActivityCount, setVisibleActivityCount] = useState(
    USER_ACTIVITY_PAGE_SIZE,
  );
  const activityListId = useId();
  const visibleActivities = useMemo(
    () => group.activities.slice(0, visibleActivityCount),
    [group.activities, visibleActivityCount],
  );
  const activityItems = useMemo(
    () =>
      expanded
        ? [
            ...new Map(
              visibleActivities.map(({ item }) => [item.rootId, item]),
            ).values(),
          ]
        : [],
    [expanded, visibleActivities],
  );
  const resolvedMap = useNotificationPageEssentials(activityItems);
  const lastActive = useRelativeTime(group.latestActivity);
  const isUnread = group.unreadEventIds.length > 0;
  const notificationLabel =
    group.eventIds.length === 1 ? "notification" : "notifications";
  const itemLabel = group.rootCount === 1 ? "item" : "items";

  const restoreFromArchive = currentView === "archived";

  return (
    <li className="min-w-0">
      <NotificationSwipeSurface
        unread={isUnread}
        onToggleRead={() =>
          isUnread
            ? actions.markEventsAsRead(group.eventIds)
            : actions.markEventsAsUnread(group.eventIds)
        }
        archiveAction={{
          mode: restoreFromArchive ? "restore" : "archive",
          onTrigger: () =>
            restoreFromArchive
              ? actions.markEventsAsUnarchived(group.eventIds)
              : actions.markEventsAsArchived(group.eventIds),
        }}
      >
        <div className="flex min-w-0 items-center gap-2 px-2 py-2">
          <button
            type="button"
            className="flex min-w-0 flex-1 items-center gap-2 rounded-md p-1 text-left transition-colors hover:bg-accent/40 focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-ring"
            aria-expanded={expanded}
            aria-controls={activityListId}
            onClick={() => {
              setExpanded((value) => !value);
              if (expanded) setVisibleActivityCount(USER_ACTIVITY_PAGE_SIZE);
            }}
          >
            <span
              className={cn(
                "flex h-10 w-4 shrink-0 flex-col items-center",
                isUnread ? "justify-between py-0.5" : "justify-center",
              )}
            >
              {isUnread && (
                <span className="h-2 w-2 shrink-0 rounded-full bg-pink-500" />
              )}
              {expanded ? (
                <ChevronDown className="h-4 w-4 shrink-0 text-muted-foreground" />
              ) : (
                <ChevronRight className="h-4 w-4 shrink-0 text-muted-foreground" />
              )}
            </span>
            <UserAvatar pubkey={group.pubkey} size="md" noHoverCard />
            <span className="min-w-0 flex-1">
              <UserName
                pubkey={group.pubkey}
                className={cn(
                  "block truncate text-sm",
                  isUnread
                    ? "font-medium text-foreground"
                    : "text-foreground/80",
                )}
                noHoverCard
              />
              <span className="mt-0.5 block text-xs text-muted-foreground">
                {group.eventIds.length} {notificationLabel} across{" "}
                {group.rootCount} {itemLabel} · active {lastActive}
              </span>
            </span>
          </button>

          <div className="notification-row-actions notification-row-actions--large shrink-0 items-center gap-1">
            <Button
              variant="ghost"
              size="sm"
              className="h-8 px-2 text-xs"
              onClick={() =>
                isUnread
                  ? actions.markEventsAsRead(group.eventIds)
                  : actions.markEventsAsUnread(group.eventIds)
              }
              title={isUnread ? "Mark group as read" : "Mark group as unread"}
              aria-label={
                isUnread ? "Mark group as read" : "Mark group as unread"
              }
            >
              {isUnread ? (
                <Eye className="h-3.5 w-3.5 sm:mr-1" />
              ) : (
                <EyeOff className="h-3.5 w-3.5 sm:mr-1" />
              )}
              <span className="hidden sm:inline">
                {isUnread ? "Read" : "Unread"}
              </span>
              <span className="sr-only sm:hidden">
                {isUnread ? "Mark group as read" : "Mark group as unread"}
              </span>
            </Button>
            {(currentView === "inbox" || currentView === "unread") && (
              <Button
                variant="ghost"
                size="sm"
                className="h-8 px-2 text-xs"
                onClick={() => actions.markEventsAsArchived(group.eventIds)}
                title="Archive group"
                aria-label="Archive group"
              >
                <Archive className="h-3.5 w-3.5 sm:mr-1" />
                <span className="hidden sm:inline">Archive</span>
                <span className="sr-only sm:hidden">Archive group</span>
              </Button>
            )}
            {currentView === "archived" && (
              <Button
                variant="ghost"
                size="sm"
                className="h-8 px-2 text-xs"
                onClick={() => actions.markEventsAsUnarchived(group.eventIds)}
                title="Move group to inbox"
                aria-label="Move group to inbox"
              >
                <ArchiveRestore className="h-3.5 w-3.5 sm:mr-1" />
                <span className="hidden sm:inline">Inbox</span>
                <span className="sr-only sm:hidden">Move group to inbox</span>
              </Button>
            )}
          </div>
        </div>
      </NotificationSwipeSurface>

      {expanded && (
        <ul
          id={activityListId}
          className="ml-4 divide-y divide-border/40 border-l border-t border-border/50 bg-background sm:ml-6"
        >
          {visibleActivities.map(({ item, event }) =>
            item.kind === "thread" ? (
              <NotificationActivityRow
                key={event.id}
                item={item}
                event={event}
                actions={actions}
                currentView={currentView}
                resolvedMap={resolvedMap}
                nested
              />
            ) : (
              <NotificationRow
                key={event.id}
                item={singleEventItem(item, event)}
                actions={actions}
                currentView={currentView}
                resolvedMap={resolvedMap}
                compact
              />
            ),
          )}
          {visibleActivityCount < group.activities.length && (
            <li className="flex justify-center px-3 py-2">
              <Button
                variant="ghost"
                size="sm"
                className="h-7 text-xs text-muted-foreground"
                onClick={() =>
                  setVisibleActivityCount((count) =>
                    Math.min(
                      group.activities.length,
                      count + USER_ACTIVITY_PAGE_SIZE,
                    ),
                  )
                }
              >
                Show{" "}
                {Math.min(
                  USER_ACTIVITY_PAGE_SIZE,
                  group.activities.length - visibleActivityCount,
                )}{" "}
                more
              </Button>
            </li>
          )}
        </ul>
      )}
    </li>
  );
}

function singleEventItem(
  item: NotificationItem,
  event: NostrEvent,
): NotificationItem {
  return notificationItemWithEvents(item, [event]);
}

function notificationItemWithEvents(
  item: NotificationItem,
  events: NostrEvent[],
): NotificationItem {
  const eventIds = new Set(events.map((event) => event.id));
  const unreadEventIds = item.unreadEventIds.filter((id) => eventIds.has(id));
  const archivedEventIds = item.archivedEventIds.filter((id) =>
    eventIds.has(id),
  );
  const latestActivity = Math.max(...events.map((event) => event.created_at));
  const state = {
    events,
    unread: unreadEventIds.length > 0,
    archived: archivedEventIds.length === events.length,
    archivedEventIds,
    latestActivity,
    unreadEventIds,
  };

  switch (item.kind) {
    case "thread":
      return { ...item, ...state };
    case "repo-star":
      return { ...item, ...state };
    case "repo-zap":
      return {
        ...item,
        ...state,
        totalSats: events.reduce(
          (total, event) =>
            total + Math.floor((getZapAmount(event) ?? 0) / 1000),
          0,
        ),
      };
  }
}

// ---------------------------------------------------------------------------
// Tab button
// ---------------------------------------------------------------------------

function TabButton({
  active,
  onClick,
  icon: Icon,
  label,
  badge,
}: {
  active: boolean;
  onClick: () => void;
  icon: React.ElementType;
  label: string;
  badge?: number;
}) {
  return (
    <button
      type="button"
      onClick={onClick}
      aria-current={active ? "page" : undefined}
      className={cn(
        "flex items-center justify-center gap-1.5 rounded-md px-2 py-1 text-xs font-medium transition-colors sm:px-3",
        active
          ? "bg-background text-foreground shadow-sm"
          : "text-muted-foreground hover:text-foreground",
      )}
    >
      <Icon className="h-3.5 w-3.5" />
      {label}
      {badge !== undefined && (
        <Badge
          variant="secondary"
          className="h-4 min-w-[16px] px-1 text-[10px] leading-none"
        >
          {badge}
        </Badge>
      )}
    </button>
  );
}
