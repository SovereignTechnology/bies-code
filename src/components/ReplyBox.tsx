/**
 * ReplyBox — NIP-22 comment composer for NIP-34 issues and PRs.
 *
 * Uses the CreateComment action (blueprint + outbox relay logic) rather than
 * raw usePublish, so comments are published to the same relay groups as other
 * NIP-34 events (git index + user outbox + repo relays + root author inbox).
 *
 * When no account is logged in, an "Anonymous" checkbox appears. Checking it
 * signs the comment with a fresh ephemeral key so the user can post without
 * creating a Nostr identity first.
 */

import { useCallback, useRef, useState } from "react";
import type { NostrEvent } from "nostr-tools";
import { useActiveAccount } from "applesauce-react/hooks";
import { runner } from "@/services/actions";
import { createAnonRunner } from "@/lib/anonPublish";
import { useToast } from "@/hooks/useToast";
import { useProfile } from "@/hooks/useProfile";
import { useUserDisplayName } from "@/hooks/useUserDisplayName";
import { ChangeIssueStatus, CreateComment } from "@/actions/nip34";
import type { IssueStatus } from "@/lib/nip34";
import {
  NostrComposer,
  type NostrComposerHandle,
} from "@/components/NostrComposer";
import type { Nip94Tags } from "@/hooks/useBlossomUpload";
import { composerHasNsec, hasPreviewableContent } from "@/lib/composerUtils";
import { Avatar, AvatarImage, AvatarFallback } from "@/components/ui/avatar";
import { Button } from "@/components/ui/button";
import { Checkbox } from "@/components/ui/checkbox";
import { Label } from "@/components/ui/label";
import {
  DropdownMenu,
  DropdownMenuContent,
  DropdownMenuItem,
  DropdownMenuTrigger,
} from "@/components/ui/dropdown-menu";
import { useAuthModal } from "@/contexts/AuthModalContext";
import {
  CheckCircle2,
  ChevronDown,
  Loader2,
  Paperclip,
  XCircle,
} from "lucide-react";
import { cn } from "@/lib/utils";

interface ReplyStatusActions {
  /** The issue/PR event ID whose status will change after commenting. */
  itemId: string;
  /** Pubkey of the issue/PR author, used for status-event notifications. */
  itemAuthorPubkey: string;
  /** All accepted repository coordinates for publishing the status event. */
  repoCoords: string[];
  /** Issues may resolve or close; PRs may only close from the composer. */
  variant: "issue" | "pr";
}

export interface ReplyBoxProps {
  /** The root issue/PR event being commented on */
  rootEvent: NostrEvent;
  /**
   * When replying to an existing comment rather than the root, provide the
   * parent comment event. The applesauce CommentBlueprint will automatically
   * propagate the root E/K/P tags from the parent comment.
   */
  parentEvent?: NostrEvent;
  /** Called after a comment is successfully posted (e.g. to close an inline composer) */
  onSubmitted?: () => void;
  /**
   * Ordered pubkeys to surface first in @ mention autocomplete:
   * parent author → thread participants → repo maintainers.
   */
  priorityPubkeys?: string[];
  /**
   * Enables maintainer/author-only combined comment and status actions.
   * Omit for nested replies, logged-out users, and items that are not open.
   */
  statusActions?: ReplyStatusActions;
}

export function ReplyBox({
  rootEvent,
  parentEvent,
  onSubmitted,
  priorityPubkeys,
  statusActions,
}: ReplyBoxProps) {
  const composerRef = useRef<NostrComposerHandle>(null);
  const [body, setBody] = useState("");
  const [activeTab, setActiveTab] = useState<"write" | "preview">("write");
  const [focused, setFocused] = useState(false);
  const [isPending, setIsPending] = useState(false);
  const [anonMode, setAnonMode] = useState(false);
  /** NIP-94 tag groups accumulated from Blossom uploads in this session */
  const [uploadedTagGroups, setUploadedTagGroups] = useState<Nip94Tags[]>([]);
  const { toast } = useToast();
  const { openAuthModal } = useAuthModal();

  const account = useActiveAccount();
  const profile = useProfile(account?.pubkey);
  const { name: displayName } = useUserDisplayName(account?.pubkey ?? "");

  const isLoggedIn = !!account;

  const initials = displayName.slice(0, 2).toUpperCase() || "?";

  const showToggle = focused || hasPreviewableContent(body);

  // The applesauce CommentBlueprint takes the immediate parent event.
  // For a top-level comment that's the root; for a reply it's the comment.
  const parent = parentEvent ?? rootEvent;

  const handleUploadedTags = useCallback((tags: Nip94Tags) => {
    setUploadedTagGroups((prev) => [...prev, tags]);
  }, []);

  const submitComment = useCallback(
    async (
      trimmed: string,
      useAnonMode: boolean,
      nextStatus?: Extract<IssueStatus, "resolved" | "closed">,
    ) => {
      const activeRunner =
        !isLoggedIn && useAnonMode ? createAnonRunner() : runner;

      // Build imeta tags — only include uploads whose URL is still in the content
      const extraTags = uploadedTagGroups
        .filter((group) => {
          const url = group[0][1];
          return trimmed.includes(url);
        })
        .map((group) => {
          const fields = group.map(([k, v]) => `${k} ${v}`);
          return ["imeta", ...fields];
        });

      setIsPending(true);
      let commentPosted = false;
      try {
        await activeRunner.run(CreateComment, parent, trimmed, rootEvent, {
          extraTags: extraTags.length > 0 ? extraTags : undefined,
        });
        commentPosted = true;

        if (nextStatus && statusActions) {
          await activeRunner.run(
            ChangeIssueStatus,
            statusActions.itemId,
            statusActions.itemAuthorPubkey,
            statusActions.repoCoords,
            nextStatus,
          );
        }

        toast({
          title: nextStatus
            ? `Comment posted and ${nextStatus === "resolved" ? "resolved" : "closed"}`
            : "Comment posted",
          description: nextStatus
            ? `Your comment was published and the ${statusActions?.variant === "pr" ? "pull request" : "issue"} was ${nextStatus === "resolved" ? "resolved" : "closed"}.`
            : "Your comment has been published.",
        });

        setBody("");
        setActiveTab("write");
        setUploadedTagGroups([]);
        onSubmitted?.();
      } catch (err) {
        const message =
          err instanceof Error ? err.message : "Failed to post comment";
        toast({
          title: commentPosted
            ? "Comment posted, but status unchanged"
            : "Failed to post comment",
          description: message,
          variant: "destructive",
        });
        if (commentPosted) {
          setBody("");
          setActiveTab("write");
          setUploadedTagGroups([]);
          onSubmitted?.();
        }
      } finally {
        setIsPending(false);
      }
    },
    [
      parent,
      rootEvent,
      onSubmitted,
      toast,
      isLoggedIn,
      uploadedTagGroups,
      statusActions,
    ],
  );

  const requestSubmit = useCallback(
    async (nextStatus?: Extract<IssueStatus, "resolved" | "closed">) => {
      const trimmed = body.trim();
      if (!trimmed) return;

      // Not logged in and not anonymous — open auth modal and retry on success
      if (!isLoggedIn && !anonMode) {
        openAuthModal("landing", () =>
          submitComment(trimmed, false, nextStatus),
        );
        return;
      }

      await submitComment(trimmed, anonMode, nextStatus);
    },
    [body, isLoggedIn, anonMode, openAuthModal, submitComment],
  );

  const handleSubmit = useCallback(
    (e: React.FormEvent) => {
      e.preventDefault();
      void requestSubmit();
    },
    [requestSubmit],
  );

  const submitDisabled = isPending || !body.trim() || composerHasNsec(body);

  return (
    <div className="flex gap-3 items-start">
      {/* Avatar — shows who is posting */}
      <Avatar className="h-8 w-8 shrink-0 mt-0.5">
        {profile?.picture && (
          <AvatarImage src={profile.picture} alt={displayName} />
        )}
        <AvatarFallback className="bg-gradient-to-br from-primary/20 to-primary/20 text-foreground font-medium text-xs">
          {initials}
        </AvatarFallback>
      </Avatar>

      {/* Composer */}
      <form
        onSubmit={handleSubmit}
        className="flex-1 space-y-2"
        onBlur={(e) => {
          if (!e.currentTarget.contains(e.relatedTarget)) setFocused(false);
        }}
      >
        <NostrComposer
          ref={composerRef}
          value={body}
          onChange={setBody}
          placeholder="Leave a comment..."
          disabled={isPending}
          rows={4}
          minRows={4}
          activeTab={activeTab}
          onTabChange={setActiveTab}
          onFocusChange={(f) => {
            if (f) setFocused(true);
          }}
          priorityPubkeys={priorityPubkeys}
          onUploadedTags={handleUploadedTags}
        />

        <div className="flex flex-wrap items-center gap-2">
          {/* Attach + Write/Preview — visible on focus or when there is content */}
          {showToggle && (
            <>
              <button
                type="button"
                title="Attach image or video (Blossom)"
                disabled={isPending || composerRef.current?.isUploading}
                onClick={() => composerRef.current?.triggerAttach()}
                className="rounded p-1 text-muted-foreground hover:text-foreground hover:bg-muted transition-colors disabled:opacity-40 disabled:cursor-not-allowed"
              >
                {composerRef.current?.isUploading ? (
                  <Loader2 className="h-4 w-4 animate-spin" />
                ) : (
                  <Paperclip className="h-4 w-4" />
                )}
              </button>

              <div className="flex items-center gap-0.5">
                {(["write", "preview"] as const).map((tab) => (
                  <button
                    key={tab}
                    type="button"
                    onClick={() => setActiveTab(tab)}
                    className={`rounded px-2 py-0.5 text-xs font-medium capitalize transition-colors ${
                      activeTab === tab
                        ? "bg-muted text-foreground"
                        : "text-muted-foreground hover:text-foreground"
                    }`}
                  >
                    {tab}
                  </button>
                ))}
              </div>
            </>
          )}

          <div className="flex items-center gap-3 ml-auto">
            {/* Anonymous checkbox — only shown when not logged in */}
            {!isLoggedIn && (
              <div className="flex items-center gap-1.5">
                <Checkbox
                  id="reply-anon"
                  checked={anonMode}
                  onCheckedChange={(checked) => setAnonMode(checked === true)}
                  disabled={isPending}
                  className="h-3.5 w-3.5"
                />
                <Label
                  htmlFor="reply-anon"
                  className="text-xs text-muted-foreground cursor-pointer select-none"
                >
                  Anonymous
                </Label>
              </div>
            )}

            <div className="flex">
              <Button
                type="submit"
                size="sm"
                disabled={submitDisabled}
                className={cn(
                  "gap-1.5 bg-primary hover:bg-primary/90 text-primary-foreground",
                  statusActions && "rounded-r-none",
                )}
              >
                {isPending ? (
                  <>
                    <Loader2 className="h-3.5 w-3.5 animate-spin" />
                    Signing...
                  </>
                ) : (
                  "Comment"
                )}
              </Button>

              {statusActions && (
                <DropdownMenu>
                  <DropdownMenuTrigger asChild>
                    <Button
                      type="button"
                      size="sm"
                      disabled={submitDisabled}
                      aria-label="More comment actions"
                      className="rounded-l-none border-l border-primary px-2 bg-primary hover:bg-primary/90 text-primary-foreground"
                    >
                      <ChevronDown className="h-3.5 w-3.5" />
                    </Button>
                  </DropdownMenuTrigger>
                  <DropdownMenuContent align="end" className="w-52">
                    {statusActions.variant === "issue" && (
                      <DropdownMenuItem
                        className="gap-2"
                        onSelect={() => void requestSubmit("resolved")}
                      >
                        <CheckCircle2 className="h-4 w-4 text-emerald-600" />
                        Comment and resolve
                      </DropdownMenuItem>
                    )}
                    <DropdownMenuItem
                      className="gap-2"
                      onSelect={() => void requestSubmit("closed")}
                    >
                      <XCircle className="h-4 w-4 text-red-600" />
                      Comment and close
                    </DropdownMenuItem>
                  </DropdownMenuContent>
                </DropdownMenu>
              )}
            </div>
          </div>
        </div>
      </form>
    </div>
  );
}
