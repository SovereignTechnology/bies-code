import { useState, type ReactNode } from "react";
import { useSeoMeta } from "@unhead/react";
import {
  Check,
  CheckCircle2,
  CircleDot,
  Clock3,
  GitFork,
  Link2,
  Megaphone,
  Plus,
  Send,
  Settings2,
  UserPlus,
  UserRound,
  Users,
  type LucideIcon,
} from "lucide-react";
import { Badge } from "@/components/ui/badge";
import { Button } from "@/components/ui/button";
import {
  Card,
  CardContent,
  CardDescription,
  CardHeader,
  CardTitle,
} from "@/components/ui/card";
import { Checkbox } from "@/components/ui/checkbox";
import { Separator } from "@/components/ui/separator";
import { Tabs, TabsContent, TabsList, TabsTrigger } from "@/components/ui/tabs";
import {
  Dialog,
  DialogContent,
  DialogDescription,
  DialogFooter,
  DialogHeader,
  DialogTitle,
} from "@/components/ui/dialog";
import { cn } from "@/lib/utils";
import { GraspServerSelector } from "@/components/GraspServerSelector";

const mockGraspServers = [
  { domain: "relay.ngit.dev", wsUrl: "wss://relay.ngit.dev" },
  { domain: "gitnostr.com", wsUrl: "wss://gitnostr.com" },
  {
    domain: "ngit.danconwaydev.com",
    wsUrl: "wss://ngit.danconwaydev.com",
  },
];

type PersonTone = "pink" | "violet" | "blue" | "amber" | "green";

const toneClasses: Record<PersonTone, string> = {
  pink: "border-pink-500/25 bg-pink-500/10 text-pink-700 dark:text-pink-300",
  violet:
    "border-violet-500/25 bg-violet-500/10 text-violet-700 dark:text-violet-300",
  blue: "border-sky-500/25 bg-sky-500/10 text-sky-700 dark:text-sky-300",
  amber:
    "border-amber-500/25 bg-amber-500/10 text-amber-700 dark:text-amber-300",
  green:
    "border-emerald-500/25 bg-emerald-500/10 text-emerald-700 dark:text-emerald-300",
};

function Person({
  name,
  tone,
  compact = false,
}: {
  name: string;
  tone: PersonTone;
  compact?: boolean;
}) {
  return (
    <span className="inline-flex min-w-0 items-center gap-1.5 font-medium text-foreground">
      <span
        className={cn(
          "inline-flex shrink-0 items-center justify-center rounded-full border",
          compact ? "h-5 w-5" : "h-7 w-7",
          toneClasses[tone],
        )}
      >
        <UserRound className={compact ? "h-3 w-3" : "h-3.5 w-3.5"} />
      </span>
      <span className="truncate">{name}</span>
    </span>
  );
}

function MockupLabel({
  icon: Icon,
  children,
}: {
  icon: LucideIcon;
  children: ReactNode;
}) {
  return (
    <div className="mb-3 flex items-center gap-2 text-xs font-semibold uppercase tracking-[0.16em] text-muted-foreground">
      <Icon className="h-3.5 w-3.5 text-pink-500" />
      {children}
    </div>
  );
}

function StateBadge({
  state,
}: {
  state: "setup" | "ready" | "waiting" | "accepted" | "review";
}) {
  const styles = {
    setup:
      "border-amber-500/30 bg-amber-500/10 text-amber-700 dark:text-amber-300",
    ready: "border-pink-500/30 bg-pink-500/10 text-pink-700 dark:text-pink-300",
    waiting: "border-border bg-muted/50 text-muted-foreground",
    review:
      "border-amber-500/30 bg-amber-500/10 text-amber-700 dark:text-amber-300",
    accepted:
      "border-emerald-500/30 bg-emerald-500/10 text-emerald-700 dark:text-emerald-300",
  };
  const labels = {
    setup: "setup required",
    ready: "ready to accept",
    waiting: "awaiting response",
    review: "merge required",
    accepted: "accepted",
  };

  return (
    <Badge
      variant="outline"
      className={cn("h-5 whitespace-nowrap px-2 text-[10px]", styles[state])}
    >
      {state === "accepted" && <Check className="mr-1 h-2.5 w-2.5" />}
      {labels[state]}
    </Badge>
  );
}

function InvitationDiscoveryNote() {
  return (
    <Card className="border-dashed border-border/80 bg-muted/10 shadow-none">
      <CardContent className="flex flex-col gap-4 p-5 sm:flex-row sm:items-center">
        <span className="flex h-11 w-11 shrink-0 items-center justify-center rounded-full bg-violet-500/10 text-violet-600 dark:text-violet-400">
          <GitFork className="h-5 w-5" />
        </span>
        <div className="min-w-0 flex-1">
          <div className="flex flex-wrap items-center gap-2">
            <p className="font-semibold">
              Invitations are contextual, not a global inbox
            </p>
            <Badge variant="outline" className="text-[10px]">
              no relay-wide scan
            </Badge>
          </div>
          <p className="mt-1 text-sm leading-relaxed text-muted-foreground">
            The recipient sees the acceptance banner after opening a repository
            from a direct link, search result, maintainer profile, or another
            existing discovery path. The client does not download every
            repository announcement to inspect its{" "}
            <code className="font-mono text-xs text-foreground">
              maintainers
            </code>{" "}
            tag.
          </p>
        </div>
        <div className="flex flex-wrap gap-2 sm:max-w-56 sm:justify-end">
          <Badge variant="secondary">Direct link</Badge>
          <Badge variant="secondary">Repository banner</Badge>
          <Badge variant="secondary">Inviter settings</Badge>
        </div>
      </CardContent>
    </Card>
  );
}

function SingleMaintainerCard() {
  const [selectedDomains, setSelectedDomains] = useState(
    mockGraspServers.map(({ domain }) => domain),
  );
  const [accepted, setAccepted] = useState(false);
  const [dialogOpen, setDialogOpen] = useState(false);

  return (
    <ScenarioCard
      number="01 / 02"
      title="One maintainer invited you"
      description="The acceptance flow is the same for every non-conflicting invitation."
      state={accepted ? "accepted" : "ready"}
    >
      {accepted ? (
        <SyncingPanel repo="open-fork" />
      ) : (
        <>
          <InvitationBanner>
            <div className="flex min-w-0 gap-3">
              <InvitationIcon />
              <div className="min-w-0">
                <p className="font-semibold">
                  You’re invited to maintain open-fork
                </p>
                <p className="mt-1 text-sm leading-relaxed text-muted-foreground">
                  Invited by <Person name="Maya" tone="pink" compact />
                </p>
              </div>
            </div>
            <Button
              type="button"
              onClick={() => setDialogOpen(true)}
              className="mt-4 w-full bg-pink-600 text-white hover:bg-pink-700 dark:bg-pink-600"
            >
              <CheckCircle2 className="h-4 w-4" />
              Accept invitation
            </Button>
          </InvitationBanner>
          <MockAcceptanceDialog
            repo="open-fork"
            open={dialogOpen}
            onOpenChange={setDialogOpen}
            selectedDomains={selectedDomains}
            onSelectedDomainsChange={setSelectedDomains}
            onAccept={() => setAccepted(true)}
          />
        </>
      )}
    </ScenarioCard>
  );
}

const inviteOptions = [
  { name: "Maya", tone: "pink" as const, lead: true },
  { name: "Theo", tone: "violet" as const, lead: false },
  { name: "Lena", tone: "green" as const, lead: false },
];

function MultipleMaintainersCard() {
  const [selected, setSelected] = useState(["Maya"]);
  const [selectedDomains, setSelectedDomains] = useState(
    mockGraspServers.map(({ domain }) => domain),
  );
  const [accepted, setAccepted] = useState(false);
  const [dialogOpen, setDialogOpen] = useState(false);

  const toggle = (name: string, checked: boolean) => {
    setSelected((current) =>
      checked
        ? Array.from(new Set([...current, name]))
        : current.filter((candidate) => candidate !== name),
    );
  };

  return (
    <ScenarioCard
      number="03"
      title="Several maintainers invited you"
      description="Choose the lead link and the GRASP servers for your repository."
      state={accepted ? "accepted" : "ready"}
    >
      {accepted ? (
        <SyncingPanel repo="nostr-kit" />
      ) : (
        <>
          <InvitationBanner>
            <div className="flex min-w-0 gap-3">
              <InvitationIcon />
              <div className="min-w-0">
                <p className="font-semibold">
                  You’re invited to maintain nostr-kit
                </p>
                <div className="mt-1 flex flex-wrap items-center gap-1 text-sm text-muted-foreground">
                  Invited by
                  <Person name="Maya" tone="pink" compact />,
                  <Person name="Theo" tone="violet" compact /> and
                  <Person name="Lena" tone="green" compact />
                </div>
              </div>
            </div>
            <Button
              type="button"
              onClick={() => setDialogOpen(true)}
              className="mt-4 w-full bg-pink-600 text-white hover:bg-pink-700 dark:bg-pink-600"
            >
              <CheckCircle2 className="h-4 w-4" />
              Accept invitation
            </Button>
          </InvitationBanner>
          <MockAcceptanceDialog
            repo="nostr-kit"
            open={dialogOpen}
            onOpenChange={setDialogOpen}
            selectedDomains={selectedDomains}
            onSelectedDomainsChange={setSelectedDomains}
            selectedMaintainers={selected}
            onToggleMaintainer={toggle}
            onAccept={() => setAccepted(true)}
          />
        </>
      )}
    </ScenarioCard>
  );
}

function MockAcceptanceDialog({
  repo,
  open,
  onOpenChange,
  selectedDomains,
  onSelectedDomainsChange,
  selectedMaintainers,
  onToggleMaintainer,
  onAccept,
}: {
  repo: string;
  open: boolean;
  onOpenChange(open: boolean): void;
  selectedDomains: string[];
  onSelectedDomainsChange(domains: string[]): void;
  selectedMaintainers?: string[];
  onToggleMaintainer?(name: string, checked: boolean): void;
  onAccept(): void;
}) {
  const canAccept =
    selectedDomains.length > 0 &&
    (!selectedMaintainers || selectedMaintainers.length > 0);

  return (
    <Dialog open={open} onOpenChange={onOpenChange}>
      <DialogContent className="max-h-[85vh] overflow-y-auto sm:max-w-xl">
        <DialogHeader>
          <DialogTitle>Accept invitation</DialogTitle>
          <DialogDescription>
            Choose where to host your copy of {repo}.
          </DialogDescription>
        </DialogHeader>

        <section className="space-y-3">
          <div>
            <h3 className="font-medium">Your GRASP servers</h3>
            <p className="text-sm text-muted-foreground">
              Where to store the data
            </p>
          </div>
          <GraspServerSelector
            selectedDomains={selectedDomains}
            onSelectedDomainsChange={onSelectedDomainsChange}
            resolvedServers={mockGraspServers}
            isFromUserList
            requiredGrasps={["GRASP-01", "GRASP-02"]}
            showTitle={false}
          />
        </section>

        {selectedMaintainers && onToggleMaintainer && (
          <section className="space-y-3 border-t pt-4">
            <h3 className="flex items-center gap-2 font-medium">
              <Users className="h-4 w-4" />
              Select lead maintainer(s)
            </h3>
            <div className="space-y-1">
              {inviteOptions.map((person) => (
                <label
                  key={person.name}
                  className="flex cursor-pointer items-center gap-2 rounded-md px-2 py-1.5 transition-colors hover:bg-muted/60"
                >
                  <Checkbox
                    checked={selectedMaintainers.includes(person.name)}
                    onCheckedChange={(checked) =>
                      onToggleMaintainer(person.name, checked === true)
                    }
                  />
                  <Person name={person.name} tone={person.tone} compact />
                  {person.lead && (
                    <Badge
                      variant="outline"
                      className="ml-auto h-4 px-1.5 text-[10px] text-pink-600 dark:text-pink-400"
                    >
                      lead
                    </Badge>
                  )}
                </label>
              ))}
            </div>
          </section>
        )}

        <DialogFooter>
          <Button
            type="button"
            variant="outline"
            onClick={() => onOpenChange(false)}
          >
            Cancel
          </Button>
          <Button
            type="button"
            disabled={!canAccept}
            onClick={() => {
              onOpenChange(false);
              onAccept();
            }}
            className="bg-pink-600 text-white hover:bg-pink-700"
          >
            Accept invitation
          </Button>
        </DialogFooter>
      </DialogContent>
    </Dialog>
  );
}

function ConflictingStateCard() {
  return (
    <ScenarioCard
      number="04"
      title="Announcement + state"
      description="Two repository histories require an explicit combined state before acceptance."
      state="review"
    >
      <div className="h-full rounded-xl border border-amber-500/30 bg-amber-500/[0.06] p-4">
        <div className="flex gap-3">
          <span className="flex h-9 w-9 shrink-0 items-center justify-center rounded-full bg-amber-500/15 text-amber-700 dark:text-amber-300">
            <GitFork className="h-4 w-4" />
          </span>
          <div>
            <p className="font-semibold">Combine repository state first</p>
            <p className="mt-1 text-xs leading-relaxed text-muted-foreground">
              Publishing either existing state as the newest event could hide
              refs from the other repository.
            </p>
          </div>
        </div>
        <ol className="mt-4 space-y-2 text-xs text-muted-foreground">
          {[
            "Compare every branch and tag from both state events",
            "Choose the desired combined ref set",
            "Prepare only the Git objects each server is missing",
            "Publish state to purgatory, then push to every server",
          ].map((step, index) => (
            <li key={step} className="flex gap-2">
              <span className="font-mono text-amber-700 dark:text-amber-300">
                {index + 1}.
              </span>
              {step}
            </li>
          ))}
        </ol>
        <Button
          type="button"
          disabled
          variant="outline"
          className="mt-4 w-full"
        >
          Review combined state · next phase
        </Button>
      </div>
    </ScenarioCard>
  );
}

function ScenarioCard({
  number,
  title,
  description,
  state,
  children,
}: {
  number: string;
  title: string;
  description: string;
  state: "setup" | "ready" | "accepted" | "review";
  children: ReactNode;
}) {
  return (
    <Card className="flex h-full flex-col overflow-hidden border-border/70">
      <CardHeader className="p-5">
        <div className="flex items-start justify-between gap-3">
          <span className="font-mono text-xs font-semibold text-pink-600 dark:text-pink-400">
            {number}
          </span>
          <StateBadge state={state} />
        </div>
        <CardTitle className="pt-2 text-lg">{title}</CardTitle>
        <CardDescription className="leading-relaxed">
          {description}
        </CardDescription>
      </CardHeader>
      <CardContent className="flex flex-1 p-0">
        <div className="flex-1 border-t bg-muted/10 p-3">{children}</div>
      </CardContent>
    </Card>
  );
}

function InvitationBanner({ children }: { children: ReactNode }) {
  return (
    <div className="h-full rounded-xl border border-pink-500/25 bg-gradient-to-br from-pink-500/[0.08] via-background to-violet-500/[0.08] p-4 shadow-sm">
      {children}
    </div>
  );
}

function InvitationIcon() {
  return (
    <span className="flex h-9 w-9 shrink-0 items-center justify-center rounded-full bg-pink-500/15 text-pink-600 dark:text-pink-400">
      <UserPlus className="h-4 w-4" />
    </span>
  );
}

function SyncingPanel({ repo }: { repo: string }) {
  return (
    <div className="flex h-full min-h-52 flex-col items-center justify-center rounded-xl border border-emerald-500/25 bg-emerald-500/[0.06] p-5 text-center">
      <span className="flex h-12 w-12 items-center justify-center rounded-full bg-emerald-500/15 text-emerald-600 dark:text-emerald-400">
        <CheckCircle2 className="h-6 w-6" />
      </span>
      <p className="mt-3 font-semibold">Invitation accepted</p>
      <p className="mt-1 text-xs text-muted-foreground">
        Syncing up your GRASP servers for {repo}
      </p>
      <div className="mt-4 flex items-center gap-2 text-xs text-muted-foreground">
        <Clock3 className="h-3.5 w-3.5" />1 of 3 ready
      </div>
    </div>
  );
}

function InviteeView() {
  return (
    <div className="space-y-10">
      <section>
        <MockupLabel icon={GitFork}>
          Discovery boundary · repository context
        </MockupLabel>
        <InvitationDiscoveryNote />
      </section>

      <section>
        <div className="mb-5 flex flex-col gap-2 sm:flex-row sm:items-end sm:justify-between">
          <div>
            <MockupLabel icon={GitFork}>
              Repository page · persistent banner
            </MockupLabel>
            <h2 className="text-2xl font-semibold tracking-tight">
              Acceptance changes with repository state
            </h2>
          </div>
          <p className="max-w-lg text-sm leading-relaxed text-muted-foreground">
            These banners remain visible at the top of the repository until the
            invitation is accepted.
          </p>
        </div>
        <div className="grid gap-4 md:grid-cols-2 xl:grid-cols-3">
          <SingleMaintainerCard />
          <MultipleMaintainersCard />
          <ConflictingStateCard />
        </div>
      </section>
    </div>
  );
}

function MaintainerRow({
  name,
  tone,
  detail,
  state,
  lead,
}: {
  name: string;
  tone: PersonTone;
  detail: ReactNode;
  state?: "setup" | "ready" | "waiting" | "accepted";
  lead?: boolean;
}) {
  return (
    <div className="flex flex-col gap-2 rounded-lg border border-border/60 bg-background/60 px-3 py-2.5 sm:flex-row sm:items-center">
      <Person name={name} tone={tone} />
      <div className="min-w-0 flex-1 text-xs leading-relaxed text-muted-foreground">
        {detail}
      </div>
      <div className="flex items-center gap-2">
        {lead && (
          <Badge
            variant="outline"
            className="h-5 border-pink-500/30 text-[10px] text-pink-600 dark:text-pink-400"
          >
            lead
          </Badge>
        )}
        {state && <StateBadge state={state} />}
      </div>
    </div>
  );
}

function InviterSettings() {
  const [sent, setSent] = useState(false);

  return (
    <Card className="overflow-hidden border-border/70">
      <CardHeader className="border-b bg-muted/15">
        <div className="flex items-center justify-between gap-4">
          <div>
            <CardTitle className="text-lg">Maintainers</CardTitle>
            <CardDescription className="mt-1">
              Repository settings · nostr-kit
            </CardDescription>
          </div>
          <Settings2 className="h-5 w-5 text-muted-foreground" />
        </div>
      </CardHeader>
      <CardContent className="space-y-5 p-4 sm:p-5">
        <div className="space-y-2">
          <p className="text-xs font-semibold uppercase tracking-wide text-muted-foreground">
            Confirmed maintainers
          </p>
          <MaintainerRow
            name="Maya"
            tone="pink"
            detail="Listed by Theo · Lena"
            lead
          />
          <MaintainerRow
            name="Theo"
            tone="violet"
            detail="Listed by Maya · Lena"
          />
          <MaintainerRow
            name="Lena"
            tone="green"
            detail="Listed by Maya · Theo"
          />
        </div>

        <div className="space-y-2 border-t pt-4">
          <p className="text-xs font-semibold uppercase tracking-wide text-muted-foreground">
            Invited maintainers
          </p>
          <MaintainerRow
            name="Sam"
            tone="amber"
            detail="Invited by you"
            state="ready"
          />
          <MaintainerRow
            name="Alex"
            tone="blue"
            detail="Invited by you and Theo"
            state="ready"
          />
          <MaintainerRow
            name="Jules"
            tone="green"
            detail="Joined through Maya and Theo · just now"
            state="accepted"
          />
        </div>

        <div className="space-y-2 border-t pt-4">
          <p className="text-sm font-medium">Add co-maintainer</p>
          <div className="flex flex-col gap-2 sm:flex-row">
            <div className="flex h-10 min-w-0 flex-1 items-center rounded-md border bg-background px-3 font-mono text-sm text-muted-foreground">
              {sent ? "npub1newmaintainer…" : "@name, npub1…, or hex pubkey"}
            </div>
            <Button
              type="button"
              onClick={() => setSent(true)}
              variant={sent ? "secondary" : "outline"}
              className="shrink-0"
            >
              {sent ? (
                <>
                  <Check className="h-4 w-4" />
                  Added to draft
                </>
              ) : (
                <>
                  <Plus className="h-4 w-4" />
                  Add
                </>
              )}
            </Button>
          </div>
          <p className="text-xs leading-relaxed text-muted-foreground">
            Saving publishes your updated announcement. The relationship stays
            pending until they publish a reciprocal link.
          </p>
        </div>
      </CardContent>
    </Card>
  );
}

function PublicRepositorySummary() {
  return (
    <Card className="border-border/70">
      <CardHeader>
        <div className="flex items-start justify-between gap-3">
          <div>
            <CardTitle className="text-lg">About this repository</CardTitle>
            <CardDescription className="mt-1">
              Public repository sidebar
            </CardDescription>
          </div>
          <Megaphone className="h-5 w-5 text-pink-500" />
        </div>
      </CardHeader>
      <CardContent>
        <div className="flex flex-wrap gap-2">
          <Badge variant="secondary">TypeScript</Badge>
          <Badge variant="secondary">Nostr</Badge>
          <Badge variant="secondary">MIT</Badge>
        </div>
        <Separator className="my-4" />
        <p className="text-xs text-muted-foreground/80">Maintained by</p>
        <div className="mt-2 flex flex-wrap gap-2">
          <Person name="Maya" tone="pink" />
          <Person name="Theo" tone="violet" />
          <Person name="Lena" tone="green" />
        </div>
        <div className="mt-5 space-y-2 rounded-lg border border-dashed bg-muted/10 p-3">
          <p className="text-xs text-muted-foreground/80">
            Invited maintainers
          </p>
          <div className="flex flex-wrap items-center gap-1 text-xs text-muted-foreground">
            <Person name="Sam" tone="amber" compact />
            <span>invited by</span>
            <Person name="Maya" tone="pink" compact />
          </div>
          <div className="flex flex-wrap items-center gap-1 text-xs text-muted-foreground">
            <Person name="Alex" tone="blue" compact />
            <span>invited by</span>
            <Person name="Maya" tone="pink" compact />
            <span>and</span>
            <Person name="Theo" tone="violet" compact />
          </div>
        </div>
      </CardContent>
    </Card>
  );
}

function AcceptanceNotice() {
  return (
    <Card className="overflow-hidden border-emerald-500/25 bg-emerald-500/[0.04]">
      <CardContent className="p-5">
        <div className="flex gap-3">
          <span className="flex h-9 w-9 shrink-0 items-center justify-center rounded-full bg-emerald-500/15 text-emerald-600 dark:text-emerald-400">
            <CheckCircle2 className="h-4 w-4" />
          </span>
          <div>
            <div className="flex flex-wrap items-center gap-2">
              <p className="font-semibold">Alex accepted your invitation</p>
              <Badge
                variant="outline"
                className="border-emerald-500/30 bg-emerald-500/10 text-emerald-700 dark:text-emerald-300"
              >
                reciprocal
              </Badge>
            </div>
            <p className="mt-1 text-sm leading-relaxed text-muted-foreground">
              Their announcement now links nostr-kit through Maya and Theo. Alex
              has access to maintainer controls.
            </p>
            <div className="mt-3 flex flex-wrap gap-2">
              <Button type="button" size="sm" variant="outline">
                View announcement
              </Button>
              <Button type="button" size="sm" variant="ghost">
                Open settings
              </Button>
            </div>
          </div>
        </div>
      </CardContent>
    </Card>
  );
}

function InviterView() {
  return (
    <div className="space-y-10">
      <section>
        <div className="mb-5">
          <MockupLabel icon={Settings2}>
            Repository settings · private controls
          </MockupLabel>
          <h2 className="text-2xl font-semibold tracking-tight">
            Track every invitation from one roster
          </h2>
          <p className="mt-2 max-w-2xl text-sm leading-relaxed text-muted-foreground">
            The inviter sees who is confirmed and who can accept in the browser.
          </p>
        </div>
        <InviterSettings />
      </section>

      <section className="grid gap-4 lg:grid-cols-[0.9fr_1.1fr]">
        <div>
          <MockupLabel icon={Users}>
            Repository page · public context
          </MockupLabel>
          <PublicRepositorySummary />
        </div>
        <div>
          <MockupLabel icon={CheckCircle2}>
            Repository settings · reciprocity observed
          </MockupLabel>
          <AcceptanceNotice />
          <div className="mt-4 rounded-xl border bg-muted/15 p-4">
            <div className="flex gap-3">
              <CircleDot className="mt-0.5 h-4 w-4 shrink-0 text-pink-500" />
              <div>
                <p className="text-sm font-medium">
                  An invitation is directional, not permission
                </p>
                <p className="mt-1 text-xs leading-relaxed text-muted-foreground">
                  The invitee only becomes a confirmed maintainer after their
                  own signed announcement links back to the group.
                </p>
              </div>
            </div>
          </div>
        </div>
      </section>
    </div>
  );
}

function Lifecycle() {
  const steps = [
    { icon: Send, label: "Invite published", caption: "Inviter lists pubkey" },
    {
      icon: GitFork,
      label: "Repository opened",
      caption: "Context reveals invitation",
    },
    {
      icon: Link2,
      label: "Link selected",
      caption: "Existing repo or Git setup",
    },
    {
      icon: CheckCircle2,
      label: "Reciprocal",
      caption: "Maintainer confirmed",
    },
  ];

  return (
    <div className="grid overflow-hidden rounded-xl border bg-card shadow-sm sm:grid-cols-2 lg:grid-cols-4">
      {steps.map((step, index) => (
        <div
          key={step.label}
          className={cn(
            "relative flex gap-3 p-4",
            index > 0 && "border-t sm:border-t-0",
            index % 2 === 1 && "sm:border-l",
            index === 2 && "lg:border-l",
          )}
        >
          <span
            className={cn(
              "flex h-8 w-8 shrink-0 items-center justify-center rounded-full",
              index === steps.length - 1
                ? "bg-emerald-500/15 text-emerald-600 dark:text-emerald-400"
                : "bg-pink-500/10 text-pink-600 dark:text-pink-400",
            )}
          >
            <step.icon className="h-4 w-4" />
          </span>
          <div>
            <p className="text-sm font-semibold">{step.label}</p>
            <p className="mt-0.5 text-xs text-muted-foreground">
              {step.caption}
            </p>
          </div>
        </div>
      ))}
    </div>
  );
}

export default function RepositoryInvitationMockup() {
  useSeoMeta({
    title: "Repository invitation mockup — GitWorkshop",
    description:
      "Interactive mockup of repository maintainer invitations from recipient and inviter perspectives.",
  });

  return (
    <div className="relative isolate overflow-hidden">
      <div
        aria-hidden
        className="pointer-events-none absolute inset-x-0 top-0 -z-10 h-[34rem] bg-gradient-to-b from-pink-500/[0.07] via-violet-500/[0.04] to-transparent"
      />
      <div
        aria-hidden
        className="pointer-events-none absolute -right-32 top-12 -z-10 h-80 w-80 rounded-full bg-pink-500/10 blur-3xl"
      />

      <div className="container max-w-screen-xl px-4 py-10 md:px-8 md:py-16">
        <header className="max-w-4xl">
          <div className="mb-5 flex flex-wrap items-center gap-2">
            <Badge
              variant="outline"
              className="border-pink-500/30 bg-pink-500/10 text-pink-700 dark:text-pink-300"
            >
              Interactive mockup
            </Badge>
            <span className="inline-flex items-center gap-1.5 text-xs text-muted-foreground">
              <Clock3 className="h-3.5 w-3.5" />
              Sample data · no events are published
            </span>
          </div>
          <h1 className="text-4xl font-bold tracking-tight sm:text-5xl lg:text-6xl">
            Repository invitations,
            <span className="block bg-gradient-to-r from-violet-600 via-pink-600 to-pink-500 bg-clip-text text-transparent dark:from-violet-400 dark:via-pink-400 dark:to-pink-300">
              from both sides.
            </span>
          </h1>
          <p className="mt-5 max-w-3xl text-lg leading-relaxed text-muted-foreground">
            Every place an invitation appears, the choices needed to accept, and
            what the inviter sees while they wait.
          </p>
        </header>

        <div className="mt-8">
          <Lifecycle />
        </div>

        <Tabs defaultValue="invitee" className="mt-12">
          <div className="mb-8 flex flex-col gap-3 border-b pb-5 sm:flex-row sm:items-center sm:justify-between">
            <div>
              <p className="text-sm font-semibold">Choose a perspective</p>
              <p className="mt-1 text-xs text-muted-foreground">
                Controls in this mockup are safe to click.
              </p>
            </div>
            <TabsList className="grid h-11 w-full grid-cols-2 sm:w-80">
              <TabsTrigger value="invitee" className="gap-2">
                <UserPlus className="h-4 w-4" />I was invited
              </TabsTrigger>
              <TabsTrigger value="inviter" className="gap-2">
                <Send className="h-4 w-4" />I sent an invite
              </TabsTrigger>
            </TabsList>
          </div>

          <TabsContent value="invitee" className="mt-0">
            <InviteeView />
          </TabsContent>
          <TabsContent value="inviter" className="mt-0">
            <InviterView />
          </TabsContent>
        </Tabs>
      </div>
    </div>
  );
}
