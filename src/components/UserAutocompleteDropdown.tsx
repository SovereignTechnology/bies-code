import {
  useCallback,
  useEffect,
  useId,
  useMemo,
  useRef,
  useState,
} from "react";
import { nip19 } from "nostr-tools";

import { AvatarWithBadges, UserAvatar } from "@/components/UserAvatar";
import { useContactSearch } from "@/hooks/useContactSearch";
import { useIsFollowing } from "@/hooks/useIsFollowing";
import { useIsGitAuthorFollowing } from "@/hooks/useIsGitAuthorFollowing";
import { useProfile } from "@/hooks/useProfile";
import { useProfilesForPubkeys } from "@/hooks/useProfilesForPubkeys";
import { useUserDisplayName } from "@/hooks/useUserDisplayName";
import { cn } from "@/lib/utils";
import {
  Popover,
  PopoverAnchor,
  PopoverContent,
} from "@/components/ui/popover";

const EMPTY_PUBKEYS: string[] = [];

export interface UserAutocompleteDropdownProps {
  query: string;
  isOpen: boolean;
  /** Viewport rectangle spanning the caret line or owning input. */
  position: { top: number; left: number; height: number } | null;
  onSelectPubkey: (pubkey: string) => void;
  onClose: () => void;
  /** Element that should receive Arrow/Enter/Escape handling while open */
  keyboardTargetRef?: React.RefObject<HTMLElement | null>;
  /** Pubkeys to surface first in results (e.g. repo maintainers, thread participants) */
  priorityPubkeys?: string[];
  /** Pubkeys to hide from results (e.g. already selected users) */
  excludePubkeys?: string[];
  /** Stable id for the listbox, used by combobox inputs via aria-controls */
  listboxId?: string;
  /** Receives the active option id for aria-activedescendant on the owning input */
  onActiveDescendantChange?: (id: string | undefined) => void;
  /** Reports whether the debounced relay search is still in progress */
  onLoadingChange?: (isLoading: boolean) => void;
}

function getOptionId(listboxId: string, pubkey: string): string {
  return `${listboxId}-option-${pubkey}`;
}

export function UserAutocompleteDropdown({
  query,
  isOpen,
  position,
  onSelectPubkey,
  onClose,
  keyboardTargetRef,
  priorityPubkeys = EMPTY_PUBKEYS,
  excludePubkeys = EMPTY_PUBKEYS,
  listboxId: providedListboxId,
  onActiveDescendantChange,
  onLoadingChange,
}: UserAutocompleteDropdownProps) {
  const generatedListboxId = useId();
  const listboxId = providedListboxId ?? generatedListboxId;
  const [selectedIndex, setSelectedIndex] = useState(0);
  const listRef = useRef<HTMLDivElement>(null);
  const anchorRef = useMemo(
    () => ({
      current: {
        getBoundingClientRect: () =>
          new DOMRect(
            position?.left ?? 0,
            position?.top ?? 0,
            0,
            position?.height ?? 0,
          ),
      },
    }),
    [position?.left, position?.top, position?.height],
  );

  const { results: contacts, isSearching } = useContactSearch(
    isOpen ? query : "",
    priorityPubkeys,
    excludePubkeys,
    isOpen,
  );
  const excludeSet = useMemo(() => new Set(excludePubkeys), [excludePubkeys]);
  const filteredContacts = useMemo(
    () => contacts.filter((contact) => !excludeSet.has(contact.pubkey)),
    [contacts, excludeSet],
  );

  // Fetch profiles for the pubkeys currently visible in the dropdown.
  // This is intentionally targeted — only the rendered items, not the full
  // follow list. useProfilesForPubkeys fires a single batched REQ to the
  // lookup relays and updates UserAutocompleteItem reactively as profiles arrive.
  const renderedPubkeys = useMemo(
    () => filteredContacts.map((c) => c.pubkey),
    [filteredContacts],
  );
  useProfilesForPubkeys(renderedPubkeys);

  useEffect(() => {
    onLoadingChange?.(isOpen && isSearching);
  }, [isOpen, isSearching, onLoadingChange]);

  useEffect(() => {
    setSelectedIndex(0);
  }, [query, isOpen]);

  useEffect(() => {
    setSelectedIndex((index) =>
      filteredContacts.length === 0
        ? 0
        : Math.min(index, filteredContacts.length - 1),
    );
  }, [filteredContacts.length]);

  const selectedPubkey = filteredContacts[selectedIndex]?.pubkey;
  const activeDescendantId =
    isOpen && selectedPubkey
      ? getOptionId(listboxId, selectedPubkey)
      : undefined;

  useEffect(() => {
    onActiveDescendantChange?.(activeDescendantId);
  }, [activeDescendantId, onActiveDescendantChange]);

  // Dismiss on any scroll outside the dropdown list so the fixed dropdown
  // doesn't float away from its anchor. Scroll events originating inside the
  // list itself (from keyboard navigation scrollIntoView) are ignored.
  useEffect(() => {
    if (!isOpen) return;
    const handleScroll = (e: Event) => {
      if (listRef.current?.contains(e.target as Node)) return;
      onClose();
    };
    window.addEventListener("scroll", handleScroll, {
      capture: true,
      passive: true,
    });
    return () =>
      window.removeEventListener("scroll", handleScroll, { capture: true });
  }, [isOpen, onClose]);

  const selectContact = useCallback(
    (pubkey: string) => {
      onSelectPubkey(pubkey);
      onClose();
    },
    [onSelectPubkey, onClose],
  );

  // Handle keyboard navigation within the dropdown
  useEffect(() => {
    if (!isOpen || filteredContacts.length === 0) return;

    const target = keyboardTargetRef?.current;
    if (!target) return;

    const handleKeyDown = (e: KeyboardEvent) => {
      switch (e.key) {
        case "ArrowDown":
          e.preventDefault();
          setSelectedIndex((prev) =>
            prev < filteredContacts.length - 1 ? prev + 1 : 0,
          );
          break;
        case "ArrowUp":
          e.preventDefault();
          setSelectedIndex((prev) =>
            prev > 0 ? prev - 1 : filteredContacts.length - 1,
          );
          break;
        case "Enter":
        case "Tab": {
          e.preventDefault();
          const selected = filteredContacts[selectedIndex];
          if (selected) selectContact(selected.pubkey);
          break;
        }
      }
    };

    target.addEventListener("keydown", handleKeyDown);
    return () => target.removeEventListener("keydown", handleKeyDown);
  }, [
    isOpen,
    filteredContacts,
    selectedIndex,
    keyboardTargetRef,
    selectContact,
    onClose,
  ]);

  // Scroll selected item into view
  useEffect(() => {
    if (selectedIndex >= 0 && listRef.current) {
      const items = listRef.current.querySelectorAll(
        "[data-user-autocomplete-item]",
      );
      items[selectedIndex]?.scrollIntoView({ block: "nearest" });
    }
  }, [selectedIndex]);

  if (!isOpen || !position || filteredContacts.length === 0) {
    return null;
  }

  // A nested Radix layer keeps portaled suggestions interactive inside a
  // modal and handles Escape before the surrounding dialog can dismiss.
  return (
    <Popover
      open
      onOpenChange={(open) => {
        if (!open) onClose();
      }}
    >
      <PopoverAnchor virtualRef={anchorRef} />
      <PopoverContent
        role="presentation"
        align="start"
        sideOffset={4}
        collisionPadding={8}
        className="z-[100] w-[280px] rounded-xl p-0 shadow-lg overflow-hidden"
        onOpenAutoFocus={(event) => event.preventDefault()}
        onCloseAutoFocus={(event) => event.preventDefault()}
        onInteractOutside={(event) => {
          // Typing and moving the caret remain interactions with the owner.
          if (
            event.target instanceof Node &&
            keyboardTargetRef?.current?.contains(event.target)
          )
            event.preventDefault();
        }}
      >
        <div
          id={listboxId}
          ref={listRef}
          role="listbox"
          className="overflow-y-auto py-1 [&::-webkit-scrollbar]:w-1.5 [&::-webkit-scrollbar-track]:bg-transparent [&::-webkit-scrollbar-thumb]:rounded-full [&::-webkit-scrollbar-thumb]:bg-border hover:[&::-webkit-scrollbar-thumb]:bg-border/80"
          style={{
            maxHeight:
              "max(0px, min(240px, calc(var(--radix-popover-content-available-height) - 2px)))",
            scrollbarWidth: "thin",
            scrollbarColor: "hsl(var(--border)) transparent",
          }}
        >
          {filteredContacts.map((contact, index) => (
            <UserAutocompleteItem
              key={contact.pubkey}
              id={getOptionId(listboxId, contact.pubkey)}
              pubkey={contact.pubkey}
              isGitFollow={contact.isGitFollow}
              isSocialFollow={contact.isSocialFollow}
              isSelected={index === selectedIndex}
              onClick={() => selectContact(contact.pubkey)}
            />
          ))}
        </div>
      </PopoverContent>
    </Popover>
  );
}

function UserAutocompleteItem({
  id,
  pubkey,
  isGitFollow,
  isSocialFollow,
  isSelected,
  onClick,
}: {
  id: string;
  pubkey: string;
  isGitFollow: boolean;
  isSocialFollow: boolean;
  isSelected: boolean;
  onClick: () => void;
}) {
  // useUserDisplayName subscribes reactively and updates when kind:0 lands.
  const { name: displayName, isPlaceholder } = useUserDisplayName(pubkey);
  const profile = useProfile(pubkey);
  const nip05 = profile?.nip05;
  const npub = nip19.npubEncode(pubkey);
  const identifier = nip05 ?? `${npub.slice(0, 12)}…`;
  const reactiveIsGitFollow = useIsGitAuthorFollowing(pubkey);
  const reactiveIsSocialFollow = useIsFollowing(pubkey);
  const showGitFollow = isGitFollow || reactiveIsGitFollow === true;
  const showSocialFollow = isSocialFollow || reactiveIsSocialFollow === true;

  return (
    <button
      id={id}
      data-user-autocomplete-item
      type="button"
      role="option"
      aria-selected={isSelected}
      className={cn(
        "w-full flex items-center gap-3 px-3 py-2 text-left transition-colors cursor-pointer",
        isSelected
          ? "bg-accent text-accent-foreground"
          : "hover:bg-secondary/60",
      )}
      onClick={onClick}
      onPointerDown={(e) => e.preventDefault()}
    >
      <AvatarWithBadges
        avatarEl={
          <UserAvatar
            pubkey={pubkey}
            size="md"
            className="shrink-0"
            showFollowIndicator={false}
          />
        }
        size="md"
        showGit={showGitFollow}
        showSocial={showSocialFollow}
      />

      <div className="flex-1 min-w-0">
        <div
          className={cn(
            "font-semibold text-sm truncate font-mono",
            isPlaceholder && "text-muted-foreground",
          )}
        >
          {displayName}
        </div>
        <div className="flex min-w-0 items-center gap-1.5">
          <span className="min-w-0 truncate font-mono text-xs text-muted-foreground">
            {identifier}
          </span>
          {showSocialFollow && (
            <span className="shrink-0 rounded-full bg-emerald-500/15 px-1.5 py-0.5 text-[10px] font-medium text-emerald-700 dark:text-emerald-300">
              Social follow
            </span>
          )}
          {showGitFollow && (
            <span className="shrink-0 rounded-full bg-primary/15 px-1.5 py-0.5 text-[10px] font-medium text-primary">
              Git follow
            </span>
          )}
        </div>
      </div>
    </button>
  );
}
