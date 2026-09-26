import { ManualRetryAction } from "@/components/ErrorRetryAction";
/**
 * RepoAdvancedRepairPage — danger-zone raw editor for the signer's OWN
 * kind:30617 announcement role tags (`M` / `m` / `o`).
 *
 * This is the explicit signer-reviewed escape hatch for announcement
 * histories the guided repair flows cannot fix. It grants no authority a
 * keyholder does not already have — anyone can hand-craft their own
 * announcement with another client — and the published replacement still
 * resolves through the normal reciprocal authorization model.
 *
 * Everything is read from the repository context and EventStore-backed
 * resolution already wired on repo pages; no new relay machinery. The
 * replacement is built by the guarded pure builder, previewed with the
 * production announcement parser and component resolver, and published
 * through the same signer + publish path the settings form uses.
 */

import { useMemo, useRef, useState } from "react";
import { Link } from "react-router-dom";
import { useActiveAccount } from "applesauce-react/hooks";
import {
  AlertTriangle,
  ArrowLeft,
  Loader2,
  Plus,
  ShieldAlert,
  X,
} from "lucide-react";
import type { NostrEvent } from "nostr-tools";

import { Alert, AlertDescription, AlertTitle } from "@/components/ui/alert";
import {
  AlertDialog,
  AlertDialogAction,
  AlertDialogCancel,
  AlertDialogContent,
  AlertDialogDescription,
  AlertDialogFooter,
  AlertDialogHeader,
  AlertDialogTitle,
  AlertDialogTrigger,
} from "@/components/ui/alert-dialog";
import { Badge } from "@/components/ui/badge";
import { Button } from "@/components/ui/button";
import { Card, CardContent } from "@/components/ui/card";
import { Checkbox } from "@/components/ui/checkbox";
import { Input } from "@/components/ui/input";
import { Label } from "@/components/ui/label";
import {
  Select,
  SelectContent,
  SelectItem,
  SelectTrigger,
  SelectValue,
} from "@/components/ui/select";
import { Separator } from "@/components/ui/separator";
import { UserName } from "@/components/UserAvatar";

import { repoCoordinate, type ResolvedRepo } from "@/lib/nip34";
import {
  parseAnnouncement,
  type RepositoryRole,
} from "@/lib/nip34-maintainer-model";
import {
  buildAdvancedRepairReplacement,
  classifyRoleTag,
  diffRoleTags,
  repositoryAnnouncementRoleTags,
  type RoleTagClassification,
} from "@/lib/repositoryAdvancedRepair";
import { RepositoryMembershipMutationRefusal } from "@/lib/repositoryMembershipMutation";
import { cn } from "@/lib/utils";
import { publish } from "@/services/nostr";
import { useRepoContext } from "./RepoContext";
import { useRepositoryReplaceablePreflight } from "@/hooks/useRepositoryReplaceablePreflight";
import type { ResolvedRepository } from "@/hooks/useResolvedRepository";
import { REPO_KIND } from "@/lib/nip34";

const HEX_PUBKEY = /^[0-9a-f]{64}$/;
const MEMBERSHIP_TAG_NAMES = new Set(["M", "m", "o", "maintainers"]);

function latestByNip01Order(events: NostrEvent[]): NostrEvent | undefined {
  return events.reduce<NostrEvent | undefined>(
    (latest, event) =>
      !latest ||
      event.created_at > latest.created_at ||
      (event.created_at === latest.created_at && event.id < latest.id)
        ? event
        : latest,
    undefined,
  );
}

export default function RepoAdvancedRepairPage() {
  const { resolved, basePath, announcementsSettled } = useRepoContext();
  const account = useActiveAccount();
  const [publishedEventId, setPublishedEventId] = useState<string>();
  const repo = resolved?.repo;
  const accountPubkey = account?.pubkey;

  // The editor operates exclusively on the current account's own latest
  // announcement for this identifier, read from events already resolved on
  // this page — never another author's event.
  const ownAnnouncement = useMemo(() => {
    if (!repo || !accountPubkey) return undefined;
    return latestByNip01Order(
      [...repo.discoveredAnnouncements, ...repo.historicalAnnouncements].filter(
        (event) => event.pubkey === accountPubkey,
      ),
    );
  }, [repo, accountPubkey]);

  return (
    <div className="container max-w-screen-xl px-4 py-6 md:px-8">
      <div className="max-w-2xl space-y-6 pb-8">
        <Link
          to={`${basePath}/settings`}
          className="inline-flex items-center gap-1.5 text-sm text-muted-foreground transition-colors hover:text-foreground"
        >
          <ArrowLeft className="h-4 w-4" />
          Back to settings
        </Link>

        <div className="space-y-2">
          <h1 className="flex items-center gap-2 text-xl font-semibold">
            <ShieldAlert className="h-5 w-5 text-destructive" />
            Advanced repair
          </h1>
          <p className="text-sm leading-relaxed text-muted-foreground">
            Rewrite the raw <code className="font-mono">M</code> /{" "}
            <code className="font-mono">m</code> /{" "}
            <code className="font-mono">o</code> role records of your own
            repository announcement. Use it for histories the guided repairs
            cannot fix. This tool grants no authority you do not already hold:
            anyone can publish any event, and the replacement still resolves
            through reciprocal maintainer confirmation.
          </p>
        </div>

        {!repo ? (
          <div className="flex items-center gap-2">
            <Loader2 className="h-4 w-4 animate-spin text-muted-foreground" />
            <span className="text-sm text-muted-foreground">Loading…</span>
          </div>
        ) : !accountPubkey ? (
          <Card className="border-dashed">
            <CardContent className="px-8 py-12 text-center">
              <p className="mx-auto max-w-sm text-muted-foreground">
                Sign in to edit the role records of your own repository
                announcement. Advanced repair never edits another author&apos;s
                event.
              </p>
            </CardContent>
          </Card>
        ) : !ownAnnouncement ? (
          <Card className="border-dashed">
            <CardContent className="px-8 py-12 text-center">
              <p className="mx-auto max-w-sm text-muted-foreground">
                {announcementsSettled
                  ? "Your account has not published an announcement for this repository identifier, so there is nothing to repair here."
                  : "Announcements are still loading. If your account has published one for this repository identifier, it will appear shortly."}
              </p>
            </CardContent>
          </Card>
        ) : (
          <>
            {publishedEventId && (
              <p
                role="status"
                className="rounded-md border border-emerald-500/30 bg-emerald-500/5 px-3 py-2 text-sm text-emerald-700 dark:text-emerald-300"
              >
                Replacement published. The editor below now shows your updated
                announcement.
              </p>
            )}
            <AdvancedRepairEditor
              key={ownAnnouncement.id}
              resolved={resolved}
              repo={repo}
              announcement={ownAnnouncement}
              onPublished={setPublishedEventId}
            />
          </>
        )}
      </div>
    </div>
  );
}

interface RoleTagRow {
  key: number;
  role: RepositoryRole;
  subject: string;
  boundaries: string;
}

function rowToTag(row: RoleTagRow): string[] {
  return [
    row.role,
    row.subject.trim(),
    ...row.boundaries
      .trim()
      .split(/[\s,]+/)
      .filter(Boolean),
  ];
}

function classificationBadge(classification: RoleTagClassification) {
  switch (classification) {
    case "active":
      return (
        <Badge
          variant="outline"
          className="border-emerald-500/40 text-emerald-700 dark:text-emerald-300"
        >
          valid, active
        </Badge>
      );
    case "inactive":
      return (
        <Badge variant="outline" className="text-muted-foreground">
          valid, ended
        </Badge>
      );
    case "invalid-self-defer":
      return (
        <Badge
          variant="outline"
          className="border-amber-500/40 text-amber-700 dark:text-amber-300"
        >
          invalid self-defer
        </Badge>
      );
    case "malformed":
      return (
        <Badge
          variant="outline"
          className="border-destructive/40 text-destructive"
        >
          malformed
        </Badge>
      );
  }
}

function PubkeyDelta({
  label,
  added,
  removed,
}: {
  label: string;
  added: string[];
  removed: string[];
}) {
  return (
    <div className="space-y-1">
      <p className="text-xs font-medium uppercase tracking-wide text-muted-foreground">
        {label}
      </p>
      {added.length === 0 && removed.length === 0 ? (
        <p className="text-sm text-muted-foreground">Unchanged.</p>
      ) : (
        <ul className="space-y-0.5 text-sm">
          {added.map((pubkey) => (
            <li key={pubkey} className="text-emerald-700 dark:text-emerald-300">
              + <UserName pubkey={pubkey} className="text-sm" />
            </li>
          ))}
          {removed.map((pubkey) => (
            <li key={pubkey} className="text-red-600 dark:text-red-400">
              − <UserName pubkey={pubkey} className="text-sm" />
            </li>
          ))}
        </ul>
      )}
    </div>
  );
}

function AdvancedRepairEditor({
  resolved,
  repo,
  announcement,
  onPublished,
}: {
  resolved: ResolvedRepository;
  repo: ResolvedRepo;
  announcement: NostrEvent;
  onPublished: (eventId: string) => void;
}) {
  const account = useActiveAccount();
  const replaceablePreflight = useRepositoryReplaceablePreflight(resolved);
  const nextRowKey = useRef(0);
  const [rows, setRows] = useState<RoleTagRow[]>(() =>
    repositoryAnnouncementRoleTags(announcement).map((tag) => ({
      key: nextRowKey.current++,
      role: tag[0] as RepositoryRole,
      subject: tag[1] ?? "",
      boundaries: tag.slice(2).join(" "),
    })),
  );
  const [confirmOpen, setConfirmOpen] = useState(false);
  const [confirmChecked, setConfirmChecked] = useState(false);
  const [publishing, setPublishing] = useState(false);
  const [publishError, setPublishError] = useState<string>();

  const currentRoleTags = useMemo(
    () => repositoryAnnouncementRoleTags(announcement),
    [announcement],
  );
  const carriedTags = useMemo(
    () =>
      announcement.tags.filter(
        ([name]) => !MEMBERSHIP_TAG_NAMES.has(name ?? ""),
      ),
    [announcement],
  );
  const editedTags = useMemo(() => rows.map(rowToTag), [rows]);

  const build = useMemo(() => {
    try {
      return {
        replacement: buildAdvancedRepairReplacement({
          announcement,
          roleTags: editedTags,
          repository: repo,
        }),
        refusal: undefined,
      };
    } catch (error) {
      return {
        replacement: undefined,
        refusal:
          error instanceof RepositoryMembershipMutationRefusal
            ? error.message
            : "The replacement could not be constructed.",
      };
    }
  }, [announcement, editedTags, repo]);

  const previewParsed = useMemo(
    () =>
      build.replacement
        ? parseAnnouncement(build.replacement.simulated)
        : undefined,
    [build],
  );

  const previewResolution = build.replacement?.resolvedRepository;

  const diff = useMemo(
    () => diffRoleTags(currentRoleTags, editedTags),
    [currentRoleTags, editedTags],
  );
  const currentProjectionTags = useMemo(
    () => announcement.tags.filter(([name]) => name === "maintainers"),
    [announcement],
  );
  const projectionChanged =
    !!build.replacement &&
    JSON.stringify(currentProjectionTags) !==
      JSON.stringify([
        ["maintainers", ...build.replacement.maintainersProjection],
      ]);
  const hasChanges =
    diff.added.length > 0 || diff.removed.length > 0 || projectionChanged;

  const authorFlags = previewParsed
    ? [
        ...(previewParsed.authorCannotMaintain
          ? ["your maintainer role would carry no current authority"]
          : []),
        ...(previewParsed.authorCannotModerate
          ? ["your moderator role would carry no current authority"]
          : []),
        ...(previewParsed.authorDeclinesMaintainership
          ? ["you would be declining maintainership"]
          : []),
        ...(previewParsed.authorDeclinesModeratorship
          ? ["you would be declining moderatorship"]
          : []),
      ]
    : [];

  const maintainersAdded =
    previewResolution?.confirmedMaintainers.filter(
      (pubkey) => !repo.confirmedMaintainers.includes(pubkey),
    ) ?? [];
  const maintainersRemoved = previewResolution
    ? repo.confirmedMaintainers.filter(
        (pubkey) => !previewResolution.confirmedMaintainers.includes(pubkey),
      )
    : [];
  const membersAdded =
    previewResolution?.confirmedMembers.filter(
      (pubkey) => !repo.confirmedMembers.includes(pubkey),
    ) ?? [];
  const membersRemoved = previewResolution
    ? repo.confirmedMembers.filter(
        (pubkey) => !previewResolution.confirmedMembers.includes(pubkey),
      )
    : [];

  const updateRow = (key: number, patch: Partial<RoleTagRow>) => {
    setRows((prev) =>
      prev.map((row) => (row.key === key ? { ...row, ...patch } : row)),
    );
  };

  const handlePublish = async () => {
    if (!account) return;
    setPublishing(true);
    setPublishError(undefined);
    try {
      await replaceablePreflight.execute(
        {
          kind: REPO_KIND,
          actorPubkey: account.pubkey,
          expectedEventId: announcement.id,
        },
        async ({ actorEvent }) => {
          if (!actorEvent) {
            throw new Error(
              "Your repository announcement is no longer available.",
            );
          }
          // Rebuild from the exact preflighted winner with a timestamp that
          // cannot lose to that addressable event.
          const fresh = buildAdvancedRepairReplacement({
            announcement: actorEvent,
            roleTags: editedTags,
            repository: repo,
            createdAt: Math.max(
              Math.floor(Date.now() / 1000),
              actorEvent.created_at + 1,
            ),
          });
          const signedEvent = await account.signer.signEvent(fresh.template);
          await publish(signedEvent, [
            repoCoordinate(repo.selectedMaintainer, repo.dTag),
            "git-index",
          ]);
          onPublished(signedEvent.id);
        },
      );
    } catch (error) {
      setPublishError(
        error instanceof Error
          ? error.message
          : "Failed to publish the replacement",
      );
    } finally {
      setPublishing(false);
    }
  };

  return (
    <div className="space-y-8">
      {/* ── Carried over unchanged ─────────────────────────────────────── */}
      <section className="space-y-2">
        <h2 className="text-sm font-semibold">Carried over unchanged</h2>
        <p className="text-xs leading-relaxed text-muted-foreground">
          Every tag other than <code className="font-mono">M</code>,{" "}
          <code className="font-mono">m</code>,{" "}
          <code className="font-mono">o</code>, and the regenerated{" "}
          <code className="font-mono">maintainers</code> projection is copied
          byte-for-byte from your current announcement.
        </p>
        <div className="max-h-48 space-y-0.5 overflow-y-auto rounded-md border border-border/60 bg-muted/20 p-3 font-mono text-xs text-muted-foreground">
          {carriedTags.length === 0 ? (
            <p>(no other tags)</p>
          ) : (
            carriedTags.map((tag, index) => (
              <p key={index} className="truncate">
                {tag.join(" ")}
              </p>
            ))
          )}
        </div>
      </section>

      <Separator />

      {/* ── Role record editor ─────────────────────────────────────────── */}
      <section className="space-y-3">
        <div>
          <h2 className="text-sm font-semibold">Role records</h2>
          <p className="mt-0.5 text-xs leading-relaxed text-muted-foreground">
            Each record is <code className="font-mono">role pubkey</code>{" "}
            followed by alternating interval start/end timestamps (unix
            seconds). No boundaries means active for the whole history; an odd
            number of boundaries means currently active. A trailing{" "}
            <code className="font-mono">defer</code> is only meaningful on
            records for other people.
          </p>
        </div>

        <div className="space-y-2">
          {rows.map((row, index) => {
            const classification = classifyRoleTag(
              announcement.pubkey,
              rowToTag(row),
            );
            return (
              <div
                key={row.key}
                className="space-y-2 rounded-md border border-border/60 bg-muted/10 p-3"
              >
                <div className="flex items-center gap-2">
                  <Select
                    value={row.role}
                    onValueChange={(role) =>
                      updateRow(row.key, { role: role as RepositoryRole })
                    }
                  >
                    <SelectTrigger
                      className="h-8 w-56 text-sm"
                      aria-label={`Role of record ${index + 1}`}
                    >
                      <SelectValue />
                    </SelectTrigger>
                    <SelectContent>
                      <SelectItem value="M">M — lead maintainer</SelectItem>
                      <SelectItem value="m">m — maintainer</SelectItem>
                      <SelectItem value="o">o — moderator</SelectItem>
                    </SelectContent>
                  </Select>
                  <div className="flex-1" />
                  {classificationBadge(classification)}
                  <Button
                    type="button"
                    variant="ghost"
                    size="sm"
                    className="h-8 px-2 text-muted-foreground hover:text-destructive"
                    onClick={() =>
                      setRows((prev) =>
                        prev.filter((candidate) => candidate.key !== row.key),
                      )
                    }
                    aria-label={`Remove record ${index + 1}`}
                  >
                    <X className="h-3.5 w-3.5" />
                  </Button>
                </div>
                <div className="space-y-1.5">
                  <Label
                    htmlFor={`advanced-repair-subject-${row.key}`}
                    className="text-xs text-muted-foreground"
                  >
                    Subject pubkey
                    {HEX_PUBKEY.test(row.subject.trim()) && (
                      <>
                        {" — "}
                        <UserName
                          pubkey={row.subject.trim()}
                          className="text-xs text-foreground"
                        />
                      </>
                    )}
                  </Label>
                  <Input
                    id={`advanced-repair-subject-${row.key}`}
                    value={row.subject}
                    onChange={(event) =>
                      updateRow(row.key, { subject: event.target.value })
                    }
                    placeholder="64-character lowercase hex pubkey"
                    className="h-8 font-mono text-xs"
                  />
                </div>
                <div className="space-y-1.5">
                  <Label
                    htmlFor={`advanced-repair-boundaries-${row.key}`}
                    className="text-xs text-muted-foreground"
                  >
                    Interval boundaries (optional)
                  </Label>
                  <Input
                    id={`advanced-repair-boundaries-${row.key}`}
                    value={row.boundaries}
                    onChange={(event) =>
                      updateRow(row.key, { boundaries: event.target.value })
                    }
                    placeholder='e.g. "1700000000 1710000000" — empty means always active'
                    className="h-8 font-mono text-xs"
                  />
                </div>
              </div>
            );
          })}
        </div>

        <Button
          type="button"
          variant="outline"
          size="sm"
          onClick={() =>
            setRows((prev) => [
              ...prev,
              {
                key: nextRowKey.current++,
                role: "m",
                subject: "",
                boundaries: "",
              },
            ])
          }
        >
          <Plus className="mr-1.5 h-3.5 w-3.5" />
          Add role record
        </Button>
      </section>

      <Separator />

      {/* ── Preview ────────────────────────────────────────────────────── */}
      <section className="space-y-4">
        <h2 className="text-sm font-semibold">Preview of the replacement</h2>

        {build.refusal ? (
          <div
            role="alert"
            className="rounded-md border border-destructive/40 bg-destructive/5 px-3 py-2 text-sm text-destructive"
          >
            {build.refusal}
          </div>
        ) : (
          <>
            <div className="space-y-1">
              <p className="text-xs font-medium uppercase tracking-wide text-muted-foreground">
                Regenerated maintainers projection
              </p>
              <p className="break-all font-mono text-xs text-muted-foreground">
                {[
                  "maintainers",
                  ...(build.replacement?.maintainersProjection ?? []),
                ].join(" ")}
              </p>
            </div>

            <div className="space-y-1">
              <p className="text-xs font-medium uppercase tracking-wide text-muted-foreground">
                Announcement health after the edit
              </p>
              {previewParsed && previewParsed.health.length > 0 ? (
                <ul className="space-y-1 text-sm">
                  {previewParsed.health.map((warning, index) => (
                    <li key={index} className="leading-snug">
                      <span className="font-mono text-xs text-amber-700 dark:text-amber-300">
                        {warning.code}
                      </span>{" "}
                      <span className="text-muted-foreground">
                        {warning.message}
                      </span>
                    </li>
                  ))}
                </ul>
              ) : (
                <p className="text-sm text-emerald-700 dark:text-emerald-300">
                  No announcement-level warnings.
                </p>
              )}
            </div>

            <div className="space-y-1">
              <p className="text-xs font-medium uppercase tracking-wide text-muted-foreground">
                Your resulting standing
              </p>
              {authorFlags.length > 0 ? (
                <ul className="list-inside list-disc text-sm text-amber-700 dark:text-amber-300">
                  {authorFlags.map((flag) => (
                    <li key={flag}>{flag}</li>
                  ))}
                </ul>
              ) : (
                <p className="text-sm text-muted-foreground">
                  No declining or authority-blocking self-role flags.
                </p>
              )}
            </div>

            {previewResolution ? (
              <div className="space-y-3">
                <PubkeyDelta
                  label="Confirmed maintainers after re-resolution"
                  added={maintainersAdded}
                  removed={maintainersRemoved}
                />
                <PubkeyDelta
                  label="Confirmed members after re-resolution"
                  added={membersAdded}
                  removed={membersRemoved}
                />
                <p className="text-xs leading-relaxed text-muted-foreground">
                  Re-resolved by substituting the edited announcement for your
                  current one against the announcements already loaded on this
                  page. Signed deletions are not re-applied in this preview, and
                  other relays may hold announcements this page has not seen.
                </p>
              </div>
            ) : (
              <p className="text-sm text-muted-foreground">
                The edited announcement no longer resolves to a repository
                component from this route&apos;s coordinate, so no confirmed
                maintainer preview is available.
              </p>
            )}

            <div className="space-y-1">
              <p className="text-xs font-medium uppercase tracking-wide text-muted-foreground">
                Tag changes vs your current announcement
              </p>
              {hasChanges ? (
                <div className="space-y-0.5 rounded-md border border-border/60 bg-muted/20 p-3 font-mono text-xs">
                  {diff.removed.map((tag, index) => (
                    <p
                      key={`removed-${index}`}
                      className="break-all text-red-600 dark:text-red-400"
                    >
                      − {tag.join(" ")}
                    </p>
                  ))}
                  {diff.added.map((tag, index) => (
                    <p
                      key={`added-${index}`}
                      className="break-all text-emerald-700 dark:text-emerald-300"
                    >
                      + {tag.join(" ")}
                    </p>
                  ))}
                  {projectionChanged && (
                    <>
                      {currentProjectionTags.map((tag, index) => (
                        <p
                          key={`projection-removed-${index}`}
                          className="break-all text-red-600 dark:text-red-400"
                        >
                          − {tag.join(" ")}
                        </p>
                      ))}
                      <p className="break-all text-emerald-700 dark:text-emerald-300">
                        +{" "}
                        {[
                          "maintainers",
                          ...(build.replacement?.maintainersProjection ?? []),
                        ].join(" ")}
                      </p>
                    </>
                  )}
                  {diff.unchanged.length > 0 && (
                    <p className="text-muted-foreground">
                      {diff.unchanged.length} unchanged record
                      {diff.unchanged.length === 1 ? "" : "s"}
                    </p>
                  )}
                </div>
              ) : (
                <p className="text-sm text-muted-foreground">
                  No changes yet — the replacement would be identical to your
                  current announcement.
                </p>
              )}
            </div>
          </>
        )}
      </section>

      <Separator />

      {/* ── Publish ────────────────────────────────────────────────────── */}
      <section className="space-y-3">
        {publishError && (
          <div
            role="alert"
            className="flex items-start gap-2 rounded-md border border-destructive/40 bg-destructive/5 px-3 py-2 text-sm text-destructive"
          >
            <AlertTriangle className="mt-0.5 h-4 w-4 shrink-0" />
            <div className="space-y-2">
              <p>{publishError}</p>
              <ManualRetryAction
                onRetry={() => {
                  setConfirmChecked(false);
                  setConfirmOpen(true);
                }}
                busy={!build.replacement || !hasChanges || publishing}
              />
            </div>
          </div>
        )}

        <AlertDialog
          open={confirmOpen}
          onOpenChange={(open) => {
            setConfirmOpen(open);
            if (!open) setConfirmChecked(false);
          }}
        >
          <AlertDialogTrigger asChild>
            <Button
              type="button"
              variant="destructive"
              disabled={!build.replacement || !hasChanges || publishing}
            >
              {publishing && <Loader2 className="mr-2 h-4 w-4 animate-spin" />}
              Publish replacement…
            </Button>
          </AlertDialogTrigger>
          <AlertDialogContent>
            <AlertDialogHeader>
              <AlertDialogTitle>
                Publish rewritten role records?
              </AlertDialogTitle>
              <AlertDialogDescription>
                This rewrites your signed membership history for{" "}
                <span className="font-mono">{repo.dTag}</span>. Other clients
                resolve authority from what you publish, not from this preview.
                Every non-membership tag is carried over unchanged and the
                deprecated maintainers projection is regenerated from your
                edited records.
              </AlertDialogDescription>
            </AlertDialogHeader>
            <label className="flex items-start gap-2.5 text-sm">
              <Checkbox
                checked={confirmChecked}
                onCheckedChange={(checked) =>
                  setConfirmChecked(checked === true)
                }
                className="mt-0.5"
                aria-label="Confirm you reviewed the preview"
              />
              <span className="leading-snug text-muted-foreground">
                I have reviewed the preview above and understand this replaces
                the role records of my announcement.
              </span>
            </label>
            <AlertDialogFooter>
              <AlertDialogCancel>Cancel</AlertDialogCancel>
              <AlertDialogAction
                disabled={!confirmChecked || publishing}
                className={cn(
                  "bg-destructive text-destructive-foreground hover:bg-destructive/90",
                )}
                onClick={() => void handlePublish()}
              >
                Publish replacement
              </AlertDialogAction>
            </AlertDialogFooter>
          </AlertDialogContent>
        </AlertDialog>

        <Alert>
          <ShieldAlert className="h-4 w-4" />
          <AlertTitle>Reviewed by you, resolved by everyone</AlertTitle>
          <AlertDescription className="text-muted-foreground">
            The replacement is signed by your key and published to this
            repository&apos;s relays and the Git index. Whether any role in it
            carries authority is still decided by the reciprocal maintainer
            resolution every client runs.
          </AlertDescription>
        </Alert>
      </section>
    </div>
  );
}
