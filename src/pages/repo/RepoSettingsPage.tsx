/**
 * RepoSettingsPage — edit repository settings for the selected maintainer.
 *
 * Allows editing:
 *   - Basic info: name, description, web URLs, topics
 *   - Default branch (kind:30618 HEAD pointer)
 *   - Grasp servers (with NIP-11 validation, same as CreateRepoDialog)
 *   - Other relays (non-Grasp relay URLs)
 *   - Other git servers (non-Grasp clone URLs)
 *
 * Read-only / auto-populated:
 *   - Clone URLs generated from selected Grasp servers
 *   - Relay URLs generated from selected Grasp servers
 *   - Items contributed only by co-maintainers (displayed as info)
 *
 * The repository stays on its canonical route while the form resolves an
 * account-rooted view for the signed-in maintainer's own announcement.
 * Membership changes are intentionally read-only until the role-aware
 * mutation preflight is implemented.
 */

import {
  type ReactNode,
  useState,
  useMemo,
  useCallback,
  useEffect,
  useId,
  useRef,
} from "react";
import { Link, useNavigate } from "react-router-dom";
import { useActiveAccount } from "applesauce-react/hooks";
import {
  ArrowLeft,
  Plus,
  X,
  Loader2,
  Radio,
  GitBranch,
  AlertTriangle,
  Users,
  Tag,
  CircleHelp,
  CircleAlert,
  Crown,
  Network,
  ChevronDown,
  ChevronRight,
} from "lucide-react";
import { nip19 } from "nostr-tools";
import type { EventTemplate } from "nostr-tools";

import { Button } from "@/components/ui/button";
import { Input } from "@/components/ui/input";
import { Textarea } from "@/components/ui/textarea";
import { Label } from "@/components/ui/label";
import { Badge } from "@/components/ui/badge";
import { Separator } from "@/components/ui/separator";
import { Alert, AlertDescription, AlertTitle } from "@/components/ui/alert";
import { RadioGroup, RadioGroupItem } from "@/components/ui/radio-group";
import {
  Collapsible,
  CollapsibleContent,
  CollapsibleTrigger,
} from "@/components/ui/collapsible";
import {
  Popover,
  PopoverContent,
  PopoverTrigger,
} from "@/components/ui/popover";
import {
  DropdownMenu,
  DropdownMenuContent,
  DropdownMenuItem,
  DropdownMenuTrigger,
} from "@/components/ui/dropdown-menu";
import { UserAvatar, UserLink, UserName } from "@/components/UserAvatar";
import { UserAutocompleteDropdown } from "@/components/UserAutocompleteDropdown";

import { useRepoContext } from "./RepoContext";
import {
  REPO_KIND,
  REPO_STATE_KIND,
  getRepoName,
  getRepoDescription,
  getRepoCloneUrls,
  getRepoRelays,
  getRepoWebUrls,
  getRepoMaintainers,
  getRepoUpstreams,
  repoUpstreamsEqual,
  repoUpstreamsToTags,
  emptyRepoUpstream,
  isRepoUpstreamSelfReference,
  isGraspCloneUrl,
  graspCloneUrlServiceAddress,
  groupRequestedMaintainers,
  resolveChain,
  type RepoUpstream,
  type ResolvedRepo,
} from "@/lib/nip34";
import type { RepositoryState } from "@/casts/RepositoryState";
import { decodePubkeyIdentifier, repoToPath } from "@/lib/routeUtils";
import { publish } from "@/services/nostr";
import { useGraspServers } from "@/hooks/useGraspServers";
import { GraspLogo } from "@/components/GraspLogo";
import { GraspServerSelector } from "@/components/GraspServerSelector";
import { cn } from "@/lib/utils";
import { normalizeUrl } from "@/lib/url";
import {
  graspRepositoryCloneUrl,
  graspServiceAddressToRelayUrl,
  relayMatchesGraspService,
} from "@/lib/grasp";
import { SubordinateForkField } from "@/components/repo/SubordinateForkField";
import {
  formatUpstreamInput,
  type PendingNip05Upstream,
} from "@/lib/repoUpstreamInput";
import { useResolvedUpstreamNip05 } from "@/hooks/useResolvedUpstreamNip05";
import { useRepositoryMembershipMutation } from "@/hooks/useRepositoryMembershipMutation";

// ---------------------------------------------------------------------------
// Known tag names — tags that the settings form explicitly manages.
// Any tag with a name NOT in this set is treated as "unknown" and preserved
// verbatim so that data from other clients is never silently dropped.
// ---------------------------------------------------------------------------

const KNOWN_TAG_NAMES = new Set([
  "d",
  "name",
  "description",
  "clone",
  "relays",
  "alt",
  "r",
  "M",
  "m",
  "o",
  "maintainers",
  "web",
  "t",
  "u",
]);

const HEX_PUBKEY_INPUT_RE = /^[0-9a-fA-F]{64}$/;
const MEMBERSHIP_TAG_NAMES = new Set(["M", "m", "o", "maintainers"]);
const NO_LEAD = "no-lead";
const LEAD_MAINTAINER_HELP_TEXT =
  "The lead maintainer is the confirmed maintainer listed by more confirmed maintainers than anyone else. If the top listing count is tied, there is no single lead maintainer.";

function stringArraysEqual(a: string[], b: string[]): boolean {
  return a.length === b.length && a.every((value, index) => value === b[index]);
}

function tagArraysEqual(a: string[][], b: string[][]): boolean {
  return (
    a.length === b.length &&
    a.every((tag, index) => stringArraysEqual(tag, b[index] ?? []))
  );
}

function isValidRepoUpstream(upstream: RepoUpstream): boolean {
  return !!(upstream.repository?.trim() || upstream.gitUrl?.trim());
}

function looksLikeDirectPubkeyInput(value: string): boolean {
  const trimmed = value.trim();
  return (
    trimmed.toLowerCase().startsWith("npub1") ||
    HEX_PUBKEY_INPUT_RE.test(trimmed)
  );
}

function LeadMaintainerHelp() {
  const [open, setOpen] = useState(false);

  return (
    <Popover open={open} onOpenChange={setOpen}>
      <PopoverTrigger asChild>
        <button
          type="button"
          className="inline-flex h-4 w-4 items-center justify-center rounded-full text-muted-foreground/80 transition-colors hover:text-foreground focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-ring focus-visible:ring-offset-2"
          aria-label="How lead maintainers are chosen"
          onMouseEnter={() => setOpen(true)}
          onMouseLeave={() => setOpen(false)}
        >
          <CircleHelp className="h-3.5 w-3.5" />
        </button>
      </PopoverTrigger>
      <PopoverContent
        side="top"
        className="w-64 text-xs leading-relaxed"
        onMouseEnter={() => setOpen(true)}
        onMouseLeave={() => setOpen(false)}
      >
        {LEAD_MAINTAINER_HELP_TEXT}
      </PopoverContent>
    </Popover>
  );
}

function LeadMaintainerSummary({
  children,
  hasLead,
  className,
}: {
  children?: ReactNode;
  hasLead: boolean;
  className?: string;
}) {
  return (
    <div className={cn("flex flex-wrap items-center gap-1.5", className)}>
      <span>{hasLead ? "Lead maintainer" : "No lead maintainer"}</span>
      <LeadMaintainerHelp />
      {hasLead ? children : null}
    </div>
  );
}

function LeadBadge() {
  const [open, setOpen] = useState(false);

  return (
    <Popover open={open} onOpenChange={setOpen}>
      <PopoverTrigger asChild>
        <button
          type="button"
          className="inline-flex h-4 items-center rounded-full border border-pink-500/40 px-1.5 py-0 text-[10px] font-semibold text-pink-600 transition-colors focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-ring focus-visible:ring-offset-2 dark:text-pink-400"
          aria-label="How lead maintainers are chosen"
          onMouseEnter={() => setOpen(true)}
          onMouseLeave={() => setOpen(false)}
        >
          lead
        </button>
      </PopoverTrigger>
      <PopoverContent
        side="top"
        className="w-64 text-xs leading-relaxed"
        onMouseEnter={() => setOpen(true)}
        onMouseLeave={() => setOpen(false)}
      >
        {LEAD_MAINTAINER_HELP_TEXT}
      </PopoverContent>
    </Popover>
  );
}

// ---------------------------------------------------------------------------
// Main page
// ---------------------------------------------------------------------------

export default function RepoSettingsPage() {
  const { resolved, repoState, basePath, announcementsSettled, repoRelayEose } =
    useRepoContext();
  const account = useActiveAccount();
  const repo = resolved?.repo;

  if (!repo) {
    return (
      <div className="container max-w-screen-xl px-4 md:px-8 py-8">
        <div className="flex items-center gap-2">
          <Loader2 className="h-4 w-4 animate-spin text-muted-foreground" />
          <span className="text-sm text-muted-foreground">Loading…</span>
        </div>
      </div>
    );
  }

  const accountPubkey = account?.pubkey;
  const isConfirmedMaintainer =
    !!accountPubkey && repo.confirmedMaintainers.includes(accountPubkey);
  const editableRepo =
    accountPubkey && isConfirmedMaintainer
      ? resolveChain(repo.discoveredAnnouncements, accountPubkey, repo.dTag)
      : undefined;
  const accountAnnouncement = editableRepo
    ? editableRepo.confirmedAnnouncements.find(
        (announcement) => announcement.pubkey === accountPubkey,
      )
    : undefined;

  if (!isConfirmedMaintainer || !editableRepo || !accountAnnouncement) {
    return (
      <div className="container max-w-screen-xl px-4 py-8 md:px-8">
        <div className="max-w-md">
          <div className="mb-4 flex items-center gap-2 text-destructive">
            <AlertTriangle className="h-5 w-5" />
            <p className="font-medium">Not authorised</p>
          </div>
          <p className="mb-4 text-sm text-muted-foreground">
            Only a confirmed maintainer in this repository&apos;s reciprocal
            component can edit settings.
          </p>
          <Button asChild variant="outline" size="sm">
            <Link to={`${basePath}/about`}>
              <ArrowLeft className="mr-2 h-4 w-4" />
              Back to About
            </Link>
          </Button>
        </div>
      </div>
    );
  }

  return (
    <RepoSettingsForm
      key={editableRepo.selectedMaintainer}
      repo={editableRepo}
      basePath={basePath}
      repoState={repoState}
      announcementsSettled={announcementsSettled}
      stateSettled={repoRelayEose}
      relayUrls={[
        ...new Set([
          ...(resolved.repoRelayGroup?.relays.map(({ url }) => url) ?? []),
          ...(resolved.extraRelaysForMaintainerMailboxCoverage?.relays.map(
            ({ url }) => url,
          ) ?? []),
        ]),
      ]}
    />
  );
}

// ---------------------------------------------------------------------------
// Settings form
// ---------------------------------------------------------------------------

interface RepoSettingsFormProps {
  repo: ResolvedRepo;
  basePath: string;
  repoState?: RepositoryState | null;
  announcementsSettled: boolean;
  stateSettled: boolean;
  relayUrls: string[];
  title?: string;
}

function RepoSettingsForm({
  repo,
  basePath,
  repoState,
  announcementsSettled,
  stateSettled,
  relayUrls,
  title = "Repository settings",
}: RepoSettingsFormProps) {
  const account = useActiveAccount();
  const navigate = useNavigate();
  const membershipMutation = useRepositoryMembershipMutation({
    repo,
    announcementsSettled,
    stateSettled,
    relayUrls,
    repoState,
  });
  const [membershipTargetInput, setMembershipTargetInput] = useState("");
  const [membershipTargetError, setMembershipTargetError] = useState<string>();
  const [membershipSuccess, setMembershipSuccess] = useState<string>();
  // Kept in source for migration archaeology; the complete-roster editor must
  // never render now that membership writes are relationship intents.
  const showLegacyRosterEditor = false;

  // Find the selected maintainer's own announcement
  const selectedAnnouncement = useMemo(
    () =>
      repo.confirmedAnnouncements.find(
        (a) => a.pubkey === repo.selectedMaintainer,
      ),
    [repo],
  );

  // Grasp server resolution (for the known server list)
  const { servers: resolvedServers, isFromUserList } = useGraspServers(
    account?.pubkey,
  );

  // ---------------------------------------------------------------------------
  // Parse current values from the selected announcement
  // ---------------------------------------------------------------------------

  const currentCloneUrls = useMemo(
    () => (selectedAnnouncement ? getRepoCloneUrls(selectedAnnouncement) : []),
    [selectedAnnouncement],
  );
  const currentRelayUrls = useMemo(
    () => (selectedAnnouncement ? getRepoRelays(selectedAnnouncement) : []),
    [selectedAnnouncement],
  );
  const currentGraspCloneUrls = useMemo(
    () => currentCloneUrls.filter(isGraspCloneUrl),
    [currentCloneUrls],
  );
  const currentGraspAddresses = useMemo(
    () => [
      ...new Set(
        currentGraspCloneUrls
          .map(graspCloneUrlServiceAddress)
          .filter((address): address is string => !!address),
      ),
    ],
    [currentGraspCloneUrls],
  );
  const currentOtherGitServers = useMemo(
    () => currentCloneUrls.filter((u) => !isGraspCloneUrl(u)),
    [currentCloneUrls],
  );
  const currentOtherRelays = useMemo(() => {
    return currentRelayUrls.filter(
      (relay) => !relayMatchesGraspService(relay, currentGraspAddresses),
    );
  }, [currentRelayUrls, currentGraspAddresses]);

  const currentWebUrls = useMemo(
    () => (selectedAnnouncement ? getRepoWebUrls(selectedAnnouncement) : []),
    [selectedAnnouncement],
  );
  const currentTopics = useMemo(
    () =>
      selectedAnnouncement?.tags
        .filter(([t]) => t === "t")
        .map(([, v]) => v)
        .filter((value): value is string => !!value) ?? [],
    [selectedAnnouncement],
  );
  const currentUpstreams = useMemo(
    () => (selectedAnnouncement ? getRepoUpstreams(selectedAnnouncement) : []),
    [selectedAnnouncement],
  );
  const currentMaintainers = useMemo(() => {
    if (!selectedAnnouncement) return [];
    return Array.from(
      new Set(
        getRepoMaintainers(selectedAnnouncement).flatMap((identifier) => {
          const pubkey = decodePubkeyIdentifier(identifier);
          return pubkey && pubkey !== repo.selectedMaintainer ? [pubkey] : [];
        }),
      ),
    );
  }, [selectedAnnouncement, repo.selectedMaintainer]);
  const isMultiMaintainer = repo.confirmedMaintainers.length > 1;
  const leadMaintainer = repo.leadResolution.leadMaintainer;
  const maintainerListers = useMemo(
    () =>
      computeMaintainerListers(
        repo.confirmedMaintainers,
        repo.confirmedMaintainers,
        repo.maintainerEdges,
      ),
    [repo.confirmedMaintainers, repo.maintainerEdges],
  );
  const initialCoordinationCandidatePubkeys = useMemo(
    () =>
      Array.from(
        new Set([
          repo.selectedMaintainer,
          ...repo.discoveryPubkeys,
          ...currentMaintainers,
        ]),
      ),
    [repo.selectedMaintainer, repo.discoveryPubkeys, currentMaintainers],
  );
  const initialCoordinationChoice = useMemo(() => {
    const lead = leadMaintainer;
    if (!lead || initialCoordinationCandidatePubkeys.length <= 2) {
      return NO_LEAD;
    }

    if (lead !== repo.selectedMaintainer) {
      return currentMaintainers.length === 1 && currentMaintainers[0] === lead
        ? lead
        : NO_LEAD;
    }

    const otherCandidates = initialCoordinationCandidatePubkeys.filter(
      (pubkey) => pubkey !== repo.selectedMaintainer,
    );
    return currentMaintainers.length === otherCandidates.length &&
      otherCandidates.every((pubkey) => currentMaintainers.includes(pubkey))
      ? lead
      : NO_LEAD;
  }, [
    currentMaintainers,
    initialCoordinationCandidatePubkeys,
    leadMaintainer,
    repo.selectedMaintainer,
  ]);
  const currentEucHash = useMemo(
    () =>
      selectedAnnouncement?.tags.find(
        ([t, , marker]) => t === "r" && marker === "euc",
      )?.[1] ?? "",
    [selectedAnnouncement],
  );

  // ---------------------------------------------------------------------------
  // Form state
  // ---------------------------------------------------------------------------

  const [name, setName] = useState(
    selectedAnnouncement ? getRepoName(selectedAnnouncement) : "",
  );
  const [description, setDescription] = useState(
    selectedAnnouncement ? getRepoDescription(selectedAnnouncement) : "",
  );
  const [webUrls, setWebUrls] = useState<string[]>(currentWebUrls);
  const [webInput, setWebInput] = useState("");
  const [topics, setTopics] = useState<string[]>(currentTopics);
  const [topicInput, setTopicInput] = useState("");
  const [upstream, setUpstream] = useState<RepoUpstream>(
    () => currentUpstreams[0] ?? emptyRepoUpstream(),
  );
  const [upstreamInput, setUpstreamInput] = useState<string>(() =>
    formatUpstreamInput(currentUpstreams[0] ?? emptyRepoUpstream()),
  );
  const [pendingUpstreamNip05, setPendingUpstreamNip05] =
    useState<PendingNip05Upstream>();
  const [subordinateForkEditorOpen, setSubordinateForkEditorOpen] = useState(
    () => currentUpstreams.length > 0,
  );
  const [subordinateForkInputBlurred, setSubordinateForkInputBlurred] =
    useState(false);
  const [subordinateForkFocusRequest, setSubordinateForkFocusRequest] =
    useState(0);

  // Co-maintainers listed by this selected announcement.
  const [editedMaintainers, setEditedMaintainers] =
    useState<string[]>(currentMaintainers);
  const [coordinationCandidatePubkeys, setCoordinationCandidatePubkeys] =
    useState<string[]>(initialCoordinationCandidatePubkeys);
  const [selectedLead, setSelectedLead] = useState(initialCoordinationChoice);
  const [maintainerInput, setMaintainerInput] = useState("");
  const [maintainerInputError, setMaintainerInputError] = useState<
    string | undefined
  >();

  // Grasp server selection
  const [selectedAddresses, setSelectedAddresses] = useState<string[]>(
    currentGraspAddresses,
  );

  // Other relays
  const [otherRelays, setOtherRelays] = useState<string[]>(currentOtherRelays);
  const [relayInput, setRelayInput] = useState("");
  const [relayInputError, setRelayInputError] = useState<string | undefined>();

  // Other git servers
  const [otherGitServers, setOtherGitServers] = useState<string[]>(
    currentOtherGitServers,
  );
  const [gitServerInput, setGitServerInput] = useState("");
  const [gitServerInputError, setGitServerInputError] = useState<
    string | undefined
  >();

  // Earliest unique commit hash
  const [eucHash, setEucHash] = useState(currentEucHash);

  // Default branch from the repository state event
  const branches = useMemo(() => {
    if (!repoState) return [];
    return repoState.refs
      .filter((r) => r.name.startsWith("refs/heads/"))
      .map((r) => r.name.replace("refs/heads/", ""))
      .sort();
  }, [repoState]);
  const currentHeadBranch = repoState?.headBranch ?? null;
  const [selectedBranch, setSelectedBranch] = useState<string>("");
  const [userHasSelectedBranch, setUserHasSelectedBranch] = useState(false);

  // Unknown / custom tags — tags not managed by the form fields above.
  // Stored as string[][] so multi-value tags and repeated tag names are
  // preserved exactly. Initialised once from the selected announcement.
  const [unknownTags, setUnknownTags] = useState<string[][]>(() => {
    if (!selectedAnnouncement) return [];
    return selectedAnnouncement.tags.filter(
      ([name]) => name !== undefined && !KNOWN_TAG_NAMES.has(name),
    );
  });
  const preservedMembershipTags = useMemo(
    () =>
      selectedAnnouncement?.tags
        .filter(([name]) => MEMBERSHIP_TAG_NAMES.has(name))
        .map((tag) => [...tag]) ?? [],
    [selectedAnnouncement],
  );

  // Other-section open state (auto-open if the repo already has entries there)
  const [otherRelaysOpen, setOtherRelaysOpen] = useState(
    () => currentOtherRelays.length > 0,
  );
  const [otherGitServersOpen, setOtherGitServersOpen] = useState(
    () => currentOtherGitServers.length > 0,
  );
  const [unknownTagsOpen, setUnknownTagsOpen] = useState(
    () =>
      !!selectedAnnouncement?.tags.some(
        ([name]) => name !== undefined && !KNOWN_TAG_NAMES.has(name),
      ),
  );

  // Submit state
  const [isSaving, setIsSaving] = useState(false);
  const [saveError, setSaveError] = useState<string | undefined>();

  const editedCloneUrls = useMemo(() => {
    const npub = nip19.npubEncode(repo.selectedMaintainer);
    const encodedId = encodeURIComponent(repo.dTag);
    const graspCloneUrls = selectedAddresses.map((address) =>
      graspRepositoryCloneUrl(address, npub, encodedId),
    );

    return Array.from(
      new Set([...repo.cloneUrls, ...graspCloneUrls, ...otherGitServers]),
    );
  }, [
    repo.selectedMaintainer,
    repo.dTag,
    repo.cloneUrls,
    selectedAddresses,
    otherGitServers,
  ]);

  const {
    status: upstreamNip05Status,
    resolvedUpstream: resolvedNip05Upstream,
  } = useResolvedUpstreamNip05(pendingUpstreamNip05);

  const hasValidUpstream = isValidRepoUpstream(upstream);
  const isSelfReferentialUpstream = isRepoUpstreamSelfReference(
    upstream,
    repo.selectedMaintainer,
    repo.dTag,
    editedCloneUrls,
  );
  const isResolvingUpstreamNip05 = upstreamNip05Status === "loading";
  const isSubordinateFork = hasValidUpstream && !isSelfReferentialUpstream;
  const hasInvalidSubordinateForkInput =
    subordinateForkEditorOpen &&
    upstreamInput.trim().length > 0 &&
    !isResolvingUpstreamNip05 &&
    (!hasValidUpstream || isSelfReferentialUpstream);

  const effectiveUpstreams = useMemo(
    () => (isSubordinateFork ? [upstream] : []),
    [isSubordinateFork, upstream],
  );

  const focusSubordinateForkInput = useCallback(() => {
    setSubordinateForkEditorOpen(true);
    setSubordinateForkFocusRequest((request) => request + 1);
  }, []);

  useEffect(() => {
    if (!resolvedNip05Upstream) return;

    setUpstream(resolvedNip05Upstream);
    setPendingUpstreamNip05(undefined);
    setSubordinateForkInputBlurred(
      isRepoUpstreamSelfReference(
        resolvedNip05Upstream,
        repo.selectedMaintainer,
        repo.dTag,
        editedCloneUrls,
      ),
    );
  }, [
    resolvedNip05Upstream,
    repo.selectedMaintainer,
    repo.dTag,
    editedCloneUrls,
  ]);

  // Sync selected addresses with the current GRASP services on first render.
  useEffect(() => {
    setSelectedAddresses(currentGraspAddresses);
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, []);

  useEffect(() => {
    if (userHasSelectedBranch) return;
    setSelectedBranch(currentHeadBranch ?? branches[0] ?? "");
  }, [currentHeadBranch, branches, userHasSelectedBranch]);

  // ---------------------------------------------------------------------------
  // Union items from other maintainers
  // ---------------------------------------------------------------------------

  const requestedMaintainers = useMemo(
    () => Array.from(new Set(repo.invitedMaintainers)),
    [repo.invitedMaintainers],
  );
  const requestedMaintainerGroups = useMemo(
    () => groupRequestedMaintainers(repo, requestedMaintainers),
    [repo, requestedMaintainers],
  );
  const invitedMaintainers = Array.from(
    new Set(
      requestedMaintainerGroups.flatMap((group) => group.recipientMaintainers),
    ),
  );
  const invitedMaintainersWithRepositories = new Set(
    requestedMaintainerGroups
      .filter((group) => group.hasAnnouncement)
      .flatMap((group) => group.recipientMaintainers),
  );

  const requestedMaintainerListers = useMemo(
    () =>
      computeMaintainerListers(
        requestedMaintainers,
        repo.confirmedMaintainers,
        repo.maintainerEdges,
      ),
    [requestedMaintainers, repo.confirmedMaintainers, repo.maintainerEdges],
  );

  const orderedCoordinationCandidatePubkeys = useMemo(
    () =>
      Array.from(
        new Set([
          repo.selectedMaintainer,
          ...coordinationCandidatePubkeys.filter(
            (pubkey) => pubkey !== repo.selectedMaintainer,
          ),
        ]),
      ),
    [coordinationCandidatePubkeys, repo.selectedMaintainer],
  );
  const showMaintainerCoordination =
    orderedCoordinationCandidatePubkeys.length > 2;
  const coordinationCandidateListers = useMemo(
    () =>
      computeMaintainerListers(
        orderedCoordinationCandidatePubkeys,
        orderedCoordinationCandidatePubkeys,
        repo.maintainerEdges,
      ),
    [orderedCoordinationCandidatePubkeys, repo.maintainerEdges],
  );
  const otherMaintainerListers = useMemo(
    () =>
      computeMaintainerListers(
        orderedCoordinationCandidatePubkeys.filter(
          (pubkey) => pubkey !== repo.selectedMaintainer,
        ),
        editedMaintainers,
        repo.maintainerEdges,
      ),
    [
      editedMaintainers,
      orderedCoordinationCandidatePubkeys,
      repo.maintainerEdges,
      repo.selectedMaintainer,
    ],
  );
  const coMaintainersListedByOthers = useMemo(
    () =>
      orderedCoordinationCandidatePubkeys
        .filter((pubkey) => pubkey !== repo.selectedMaintainer)
        .filter((pubkey) => !editedMaintainers.includes(pubkey))
        .map((pubkey) => ({
          pubkey,
          listerPubkeys: otherMaintainerListers.get(pubkey) ?? [],
        }))
        .filter(({ listerPubkeys }) => listerPubkeys.length > 0),
    [
      editedMaintainers,
      orderedCoordinationCandidatePubkeys,
      otherMaintainerListers,
      repo.selectedMaintainer,
    ],
  );
  const removedCurrentMaintainers = useMemo(
    () =>
      currentMaintainers.filter(
        (pubkey) => !editedMaintainers.includes(pubkey),
      ),
    [currentMaintainers, editedMaintainers],
  );
  const temporarilyRemovedMaintainers = useMemo(() => {
    if (!showMaintainerCoordination || selectedLead === NO_LEAD) return [];
    if (selectedLead === repo.selectedMaintainer) {
      return removedCurrentMaintainers.filter(
        (pubkey) => (otherMaintainerListers.get(pubkey) ?? []).length === 0,
      );
    }

    return removedCurrentMaintainers.filter(
      (pubkey) =>
        !repo.maintainerEdges.some(
          ({ from, to }) => from === selectedLead && to === pubkey,
        ),
    );
  }, [
    otherMaintainerListers,
    removedCurrentMaintainers,
    repo.maintainerEdges,
    repo.selectedMaintainer,
    selectedLead,
    showMaintainerCoordination,
  ]);
  const stillRecognizedMaintainers = useMemo(
    () =>
      removedCurrentMaintainers
        .map((pubkey) => ({
          pubkey,
          listerPubkeys: otherMaintainerListers.get(pubkey) ?? [],
        }))
        .filter(({ listerPubkeys }) => listerPubkeys.length > 0),
    [otherMaintainerListers, removedCurrentMaintainers],
  );

  const maintainerPickerPriorityPubkeys = useMemo(
    () =>
      Array.from(
        new Set([...repo.confirmedMaintainers, ...requestedMaintainers]),
      ),
    [repo.confirmedMaintainers, requestedMaintainers],
  );

  const maintainerPickerExcludePubkeys = useMemo(
    () => [repo.selectedMaintainer, ...editedMaintainers],
    [repo.selectedMaintainer, editedMaintainers],
  );

  const unionOnlyRelays = useMemo((): Array<{
    url: string;
    contributorPubkey: string;
  }> => {
    if (!isMultiMaintainer || !selectedAnnouncement) return [];
    const myRelays = new Set(
      getRepoRelays(selectedAnnouncement).map(normalizeUrl),
    );
    return repo.relays
      .filter((r) => !myRelays.has(normalizeUrl(r)))
      .map((url) => ({
        url,
        contributorPubkey:
          repo.relayProvenance.find((p) => p.value === url)?.pubkey ?? "",
      }));
  }, [
    isMultiMaintainer,
    selectedAnnouncement,
    repo.relays,
    repo.relayProvenance,
  ]);

  const unionOnlyGitServers = useMemo((): Array<{
    url: string;
    contributorPubkey: string;
  }> => {
    if (!isMultiMaintainer || !selectedAnnouncement) return [];
    const myCloneUrls = new Set(
      getRepoCloneUrls(selectedAnnouncement).map(normalizeUrl),
    );
    return repo.cloneUrls
      .filter((u) => !myCloneUrls.has(normalizeUrl(u)) && !isGraspCloneUrl(u))
      .map((url) => ({
        url,
        contributorPubkey:
          repo.cloneUrlProvenance.find((p) => p.value === url)?.pubkey ?? "",
      }));
  }, [
    isMultiMaintainer,
    selectedAnnouncement,
    repo.cloneUrls,
    repo.cloneUrlProvenance,
  ]);

  const unionOnlyGraspAddresses = useMemo((): Array<{
    address: string;
    contributorPubkey: string;
  }> => {
    if (!isMultiMaintainer || !selectedAnnouncement) return [];
    const myCloneUrls = new Set(getRepoCloneUrls(selectedAnnouncement));
    const myGraspAddresses = new Set(
      Array.from(myCloneUrls)
        .filter(isGraspCloneUrl)
        .map(graspCloneUrlServiceAddress)
        .filter(Boolean),
    );
    return repo.graspCloneUrls
      .filter((u) => {
        const address = graspCloneUrlServiceAddress(u);
        return address && !myGraspAddresses.has(address);
      })
      .map((url) => ({
        address: graspCloneUrlServiceAddress(url) ?? url,
        contributorPubkey:
          repo.cloneUrlProvenance.find((p) => p.value === url)?.pubkey ?? "",
      }))
      .filter(
        (item, idx, arr) =>
          arr.findIndex((candidate) => candidate.address === item.address) ===
          idx,
      );
  }, [
    isMultiMaintainer,
    selectedAnnouncement,
    repo.graspCloneUrls,
    repo.cloneUrlProvenance,
  ]);

  // ---------------------------------------------------------------------------
  // Other relay actions
  // ---------------------------------------------------------------------------

  const handleAddRelay = useCallback(() => {
    const raw = relayInput.trim();
    if (!raw) return;
    let url = raw;
    if (!url.startsWith("wss://") && !url.startsWith("ws://")) {
      url = `wss://${url}`;
    }
    try {
      new URL(url);
    } catch {
      setRelayInputError(
        "Enter a valid WebSocket URL (e.g. wss://relay.example.com)",
      );
      return;
    }
    if (otherRelays.includes(url)) {
      setRelayInputError("Already in the list");
      return;
    }
    setOtherRelays((prev) => [...prev, url]);
    setRelayInput("");
    setRelayInputError(undefined);
  }, [relayInput, otherRelays]);

  const handleRemoveRelay = useCallback((url: string) => {
    setOtherRelays((prev) => prev.filter((r) => r !== url));
  }, []);

  // ---------------------------------------------------------------------------
  // Other git server actions
  // ---------------------------------------------------------------------------

  const handleAddGitServer = useCallback(() => {
    const raw = gitServerInput.trim();
    if (!raw) return;
    try {
      new URL(raw);
    } catch {
      setGitServerInputError(
        "Enter a valid URL (e.g. https://github.com/user/repo.git)",
      );
      return;
    }
    if (isGraspCloneUrl(raw)) {
      setGitServerInputError(
        "This looks like a GRASP server URL — use the GRASP servers section instead",
      );
      return;
    }
    if (otherGitServers.includes(raw)) {
      setGitServerInputError("Already in the list");
      return;
    }
    setOtherGitServers((prev) => [...prev, raw]);
    setGitServerInput("");
    setGitServerInputError(undefined);
  }, [gitServerInput, otherGitServers]);

  const handleRemoveGitServer = useCallback((url: string) => {
    setOtherGitServers((prev) => prev.filter((u) => u !== url));
  }, []);

  // ---------------------------------------------------------------------------
  // Web URL actions
  // ---------------------------------------------------------------------------

  const handleAddWebUrl = useCallback(() => {
    const raw = webInput.trim();
    if (!raw) return;
    let url = raw;
    if (!/^https?:\/\//i.test(url)) {
      url = `https://${url}`;
    }
    try {
      new URL(url);
    } catch {
      return;
    }
    if (webUrls.includes(url)) return;
    setWebUrls((prev) => [...prev, url]);
    setWebInput("");
  }, [webInput, webUrls]);

  // ---------------------------------------------------------------------------
  // Topic actions
  // ---------------------------------------------------------------------------

  const handleAddTopic = useCallback(() => {
    const raw = topicInput.trim().toLowerCase().replace(/\s+/g, "-");
    if (!raw || topics.includes(raw)) return;
    setTopics((prev) => [...prev, raw]);
    setTopicInput("");
  }, [topicInput, topics]);

  // ---------------------------------------------------------------------------
  // Maintainer actions
  // ---------------------------------------------------------------------------

  const addMaintainerPubkey = useCallback(
    (pubkey: string) => {
      if (pubkey === repo.selectedMaintainer) {
        setMaintainerInputError("You cannot add yourself as a co-maintainer");
        return;
      }
      if (editedMaintainers.includes(pubkey)) {
        setMaintainerInputError("Already in the list");
        return;
      }

      setEditedMaintainers((prev) =>
        prev.includes(pubkey) ? prev : [...prev, pubkey],
      );
      setCoordinationCandidatePubkeys((prev) =>
        prev.includes(pubkey) ? prev : [...prev, pubkey],
      );
      setMaintainerInput("");
      setMaintainerInputError(undefined);
    },
    [repo.selectedMaintainer, editedMaintainers],
  );

  const handleAddMaintainer = useCallback(() => {
    const raw = maintainerInput.trim();
    if (!raw) return;

    const pubkey = decodePubkeyIdentifier(raw);
    if (!pubkey) {
      setMaintainerInputError("Enter a valid hex pubkey or npub");
      return;
    }
    addMaintainerPubkey(pubkey);
  }, [maintainerInput, addMaintainerPubkey]);

  const handleRemoveMaintainer = useCallback((pubkey: string) => {
    setEditedMaintainers((prev) => prev.filter((pk) => pk !== pubkey));
  }, []);

  const handleSelectLead = useCallback(
    (pubkey: string) => {
      setSelectedLead(pubkey);
      setMaintainerInput("");
      setMaintainerInputError(undefined);

      if (pubkey === NO_LEAD) {
        setEditedMaintainers([...currentMaintainers]);
        return;
      }

      if (pubkey === repo.selectedMaintainer) {
        setEditedMaintainers((current) =>
          Array.from(
            new Set([
              ...orderedCoordinationCandidatePubkeys.filter(
                (candidate) => candidate !== repo.selectedMaintainer,
              ),
              ...current,
            ]),
          ),
        );
        return;
      }

      setEditedMaintainers([pubkey]);
    },
    [
      currentMaintainers,
      orderedCoordinationCandidatePubkeys,
      repo.selectedMaintainer,
    ],
  );

  const runMembershipIntent = useCallback(
    async (
      intent:
        | { type: "add"; targetPubkey: string }
        | { type: "remove"; targetPubkey: string }
        | { type: "leave" },
    ) => {
      setMembershipTargetError(undefined);
      setMembershipSuccess(undefined);
      try {
        await membershipMutation.mutate(intent);
        setMembershipSuccess(
          intent.type === "add"
            ? `Invitation published for ${nip19.npubEncode(intent.targetPubkey)}`
            : intent.type === "remove"
              ? `Relationship removed for ${nip19.npubEncode(intent.targetPubkey)}`
              : "Leave announcement published",
        );
        if (intent.type === "add") setMembershipTargetInput("");
      } catch {
        // The mutation hook exposes a stable refusal category and explanation.
      }
    },
    [membershipMutation],
  );

  const handleSafeAddMaintainer = useCallback(() => {
    const targetPubkey = decodePubkeyIdentifier(membershipTargetInput.trim());
    if (!targetPubkey) {
      setMembershipTargetError("Enter a valid hex pubkey or npub");
      return;
    }
    if (targetPubkey === repo.selectedMaintainer) {
      setMembershipTargetError("You cannot invite yourself");
      return;
    }
    void runMembershipIntent({ type: "add", targetPubkey });
  }, [membershipTargetInput, repo.selectedMaintainer, runMembershipIntent]);

  // ---------------------------------------------------------------------------
  // Save
  // ---------------------------------------------------------------------------

  const hasInfrastructure =
    selectedAddresses.length > 0 ||
    (otherRelays.length > 0 && otherGitServers.length > 0);

  const announcementFieldsChanged =
    name.trim() !==
      (selectedAnnouncement ? getRepoName(selectedAnnouncement) : "") ||
    description.trim() !==
      (selectedAnnouncement ? getRepoDescription(selectedAnnouncement) : "") ||
    !stringArraysEqual(webUrls, currentWebUrls) ||
    !stringArraysEqual(topics, currentTopics) ||
    !repoUpstreamsEqual(effectiveUpstreams, currentUpstreams) ||
    !stringArraysEqual(selectedAddresses, currentGraspAddresses) ||
    !stringArraysEqual(otherRelays, currentOtherRelays) ||
    !stringArraysEqual(otherGitServers, currentOtherGitServers) ||
    eucHash.trim() !== currentEucHash ||
    !tagArraysEqual(
      unknownTags,
      selectedAnnouncement?.tags.filter(
        ([tagName]) => tagName !== undefined && !KNOWN_TAG_NAMES.has(tagName),
      ) ?? [],
    );

  const defaultBranchChanged =
    userHasSelectedBranch &&
    selectedBranch.length > 0 &&
    selectedBranch !== currentHeadBranch;
  const hasChanges = announcementFieldsChanged || defaultBranchChanged;
  const canSave =
    name.trim().length > 0 &&
    hasInfrastructure &&
    hasChanges &&
    (!defaultBranchChanged || !!repoState) &&
    !hasInvalidSubordinateForkInput &&
    !isResolvingUpstreamNip05 &&
    !isSaving;

  const handleSave = useCallback(async () => {
    if (!canSave || !account) return;
    if (!selectedAnnouncement) return;

    setIsSaving(true);
    setSaveError(undefined);

    try {
      const repoCoord = `${REPO_KIND}:${repo.selectedMaintainer}:${repo.dTag}`;

      if (announcementFieldsChanged) {
        const npub = nip19.npubEncode(account.pubkey);
        const encodedId = encodeURIComponent(repo.dTag);

        // Build clone URLs: Grasp URLs + other git servers
        const graspCloneUrls = selectedAddresses.map((address) =>
          graspRepositoryCloneUrl(address, npub, encodedId),
        );
        const allCloneUrls = [...graspCloneUrls, ...otherGitServers];

        // Build relay URLs: Grasp relay WSS + other relays
        const graspRelayUrls = selectedAddresses.map((address) =>
          graspServiceAddressToRelayUrl(address),
        );
        const allRelayUrls = [...graspRelayUrls, ...otherRelays];

        const template: EventTemplate = {
          kind: REPO_KIND,
          content: "",
          created_at: Math.floor(Date.now() / 1000),
          tags: [
            ["d", repo.dTag],
            ["name", name.trim()],
            ["description", description.trim()],
            ...(allCloneUrls.length > 0
              ? [["clone", ...allCloneUrls] as string[]]
              : []),
            ...(allRelayUrls.length > 0
              ? [["relays", ...allRelayUrls] as string[]]
              : []),
            ["alt", `git repository: ${name.trim()}`],
            ...(eucHash.trim()
              ? [["r", eucHash.trim(), "euc"] as string[]]
              : []),
            // Membership is not editable in Wave 1. Preserve indexed roles,
            // history boundaries, and the legacy compatibility projection
            // exactly during every metadata-only edit.
            ...preservedMembershipTags,
            ...webUrls.map((u) => ["web", u] as string[]),
            ...topics.map((t) => ["t", t] as string[]),
            ...repoUpstreamsToTags(effectiveUpstreams),
            // Preserve unknown/custom tags verbatim
            ...unknownTags.filter((tag) => tag.length > 0 && tag[0]),
          ],
        };

        const signedEvent = await account.signer.signEvent(template);

        // Publish to user outbox + repo's declared relays + git index
        await publish(signedEvent, [repoCoord, "git-index"]);
      }

      if (defaultBranchChanged && repoState) {
        const newHeadValue = `ref: refs/heads/${selectedBranch}`;
        const hasHead = repoState.event.tags.some(
          ([tagName]) => tagName === "HEAD",
        );
        const tags = hasHead
          ? repoState.event.tags.map((tag) =>
              tag[0] === "HEAD" ? ["HEAD", newHeadValue] : tag,
            )
          : [...repoState.event.tags, ["HEAD", newHeadValue]];

        const template: EventTemplate = {
          kind: REPO_STATE_KIND,
          content: repoState.event.content,
          created_at: Math.floor(Date.now() / 1000),
          tags,
        };

        const signedEvent = await account.signer.signEvent(template);
        await publish(signedEvent, [repoCoord]);
      }

      // Navigate back to the about page
      navigate(`${basePath}/about`);
    } catch (err) {
      setSaveError(
        err instanceof Error ? err.message : "Failed to save changes",
      );
    } finally {
      setIsSaving(false);
    }
  }, [
    canSave,
    account,
    selectedAnnouncement,
    announcementFieldsChanged,
    defaultBranchChanged,
    repo,
    repoState,
    selectedAddresses,
    otherGitServers,
    otherRelays,
    name,
    description,
    webUrls,
    topics,
    effectiveUpstreams,
    preservedMembershipTags,
    eucHash,
    unknownTags,
    selectedBranch,
    basePath,
    navigate,
  ]);

  // ---------------------------------------------------------------------------
  // Render
  // ---------------------------------------------------------------------------

  return (
    <div className="container max-w-screen-xl px-4 py-6 md:px-8">
      <div className="max-w-2xl">
        {/* Back link */}
        <Link
          to={`${basePath}/about`}
          className="inline-flex items-center gap-1.5 text-sm text-muted-foreground hover:text-foreground transition-colors mb-6"
        >
          <ArrowLeft className="h-4 w-4" />
          Back to About
        </Link>

        <h1 className="text-xl font-semibold mb-6">{title}</h1>

        <div className="space-y-8 pb-8">
          {/* ── Basic info ─────────────────────────────────────────────── */}
          <section className="space-y-4">
            <div className="space-y-2">
              <Label htmlFor="edit-name">Name</Label>
              <Input
                id="edit-name"
                value={name}
                onChange={(e) => setName(e.target.value)}
                placeholder="Repository name"
              />
            </div>

            <div className="space-y-2">
              <Label htmlFor="edit-description">Description</Label>
              <Textarea
                id="edit-description"
                value={description}
                onChange={(e) => setDescription(e.target.value)}
                placeholder="A brief description of the project"
                rows={3}
                className="resize-none"
              />
            </div>

            {/* Website */}
            <div className="space-y-2">
              <Label>Website</Label>
              {webUrls.length > 0 && (
                <div className="space-y-1.5">
                  {webUrls.map((url) => (
                    <div
                      key={url}
                      className="flex items-center gap-2 rounded-md border border-border/60 bg-muted/20 px-3 py-1.5"
                    >
                      <span className="text-sm text-foreground/80 flex-1 truncate">
                        {url}
                      </span>
                      <button
                        type="button"
                        onClick={() =>
                          setWebUrls((prev) => prev.filter((u) => u !== url))
                        }
                        className="text-muted-foreground hover:text-foreground transition-colors"
                        aria-label={`Remove ${url}`}
                      >
                        <X className="h-3.5 w-3.5" />
                      </button>
                    </div>
                  ))}
                </div>
              )}
              <div className="flex gap-2">
                <Input
                  placeholder="https://example.com"
                  value={webInput}
                  onChange={(e) => setWebInput(e.target.value)}
                  onKeyDown={(e) => {
                    if (e.key === "Enter") {
                      e.preventDefault();
                      handleAddWebUrl();
                    }
                  }}
                  className="h-8 text-sm"
                />
                <Button
                  type="button"
                  variant="outline"
                  size="sm"
                  onClick={handleAddWebUrl}
                  className="h-8 px-2.5 shrink-0"
                >
                  <Plus className="h-3.5 w-3.5" />
                </Button>
              </div>
            </div>

            {/* Topics */}
            <div className="space-y-2">
              <Label>Topics</Label>
              {topics.length > 0 && (
                <div className="flex flex-wrap gap-1.5 mb-1">
                  {topics.map((t) => (
                    <Badge
                      key={t}
                      variant="secondary"
                      className="text-xs gap-1 pr-1"
                    >
                      {t}
                      <button
                        type="button"
                        onClick={() =>
                          setTopics((prev) => prev.filter((x) => x !== t))
                        }
                        className="rounded-full hover:bg-muted-foreground/20 p-0.5"
                        aria-label={`Remove ${t}`}
                      >
                        <X className="h-2.5 w-2.5" />
                      </button>
                    </Badge>
                  ))}
                </div>
              )}
              <div className="flex gap-2">
                <Input
                  placeholder="Add topic…"
                  value={topicInput}
                  onChange={(e) => setTopicInput(e.target.value)}
                  onKeyDown={(e) => {
                    if (e.key === "Enter") {
                      e.preventDefault();
                      handleAddTopic();
                    }
                  }}
                  className="h-8 text-sm"
                />
                <Button
                  type="button"
                  variant="outline"
                  size="sm"
                  onClick={handleAddTopic}
                  className="h-8 px-2.5 shrink-0"
                >
                  <Plus className="h-3.5 w-3.5" />
                </Button>
              </div>
            </div>

            {/* Earliest unique commit */}
            <div className="space-y-2">
              <Label htmlFor="edit-euc">Earliest unique commit</Label>
              <Input
                id="edit-euc"
                value={eucHash}
                onChange={(e) => setEucHash(e.target.value)}
                placeholder="40-character git commit hash"
                className="font-mono text-sm"
              />
              <p className="text-xs text-muted-foreground leading-relaxed">
                The earliest commit hash that uniquely identifies this
                repository — used to track it across forks and renames. Set
                automatically by <code className="font-mono">ngit push</code>.
              </p>
            </div>

            {/* Subordinate fork upstreams */}
            <SubordinateForkField
              upstream={upstream}
              upstreamInput={upstreamInput}
              pendingNip05={pendingUpstreamNip05}
              nip05Status={upstreamNip05Status}
              editorOpen={subordinateForkEditorOpen}
              inputBlurred={subordinateForkInputBlurred}
              focusRequest={subordinateForkFocusRequest}
              repoPubkey={repo.selectedMaintainer}
              repoIdentifier={repo.dTag}
              repoCloneUrls={editedCloneUrls}
              onInputChange={(value, parsed) => {
                const nextUpstream = parsed.upstream;
                setUpstreamInput(value);
                setUpstream(nextUpstream);
                setPendingUpstreamNip05(
                  parsed.pendingNip05
                    ? {
                        ...parsed.pendingNip05,
                        gitUrl: nextUpstream.gitUrl ?? "",
                      }
                    : undefined,
                );
                if (
                  isValidRepoUpstream(nextUpstream) &&
                  !isRepoUpstreamSelfReference(
                    nextUpstream,
                    repo.selectedMaintainer,
                    repo.dTag,
                    editedCloneUrls,
                  )
                ) {
                  setSubordinateForkInputBlurred(false);
                }
              }}
              onInputBlur={() => setSubordinateForkInputBlurred(true)}
              onOpenEditor={focusSubordinateForkInput}
              onCloseEditor={() => {
                setSubordinateForkEditorOpen(false);
                setSubordinateForkInputBlurred(false);
              }}
              onClear={() => {
                setUpstream(emptyRepoUpstream());
                setPendingUpstreamNip05(undefined);
                setUpstreamInput("");
                setSubordinateForkInputBlurred(false);
              }}
            />
          </section>

          <Separator />

          {/* ── Default branch ─────────────────────────────────────────── */}
          <section className="space-y-4">
            <div>
              <h2 className="text-sm font-semibold">Default branch</h2>
              <p className="text-xs text-muted-foreground mt-1 leading-relaxed">
                The default branch is used as the repository HEAD, shown first
                in the code view, and used as the base for pull requests. This
                setting updates only the kind:30618 repository state event.
              </p>
            </div>

            {!repoState ? (
              <div className="rounded-lg border border-amber-500/30 bg-amber-500/5 px-4 py-3 text-sm text-amber-700 dark:text-amber-400">
                <div className="flex items-start gap-2">
                  <AlertTriangle className="h-4 w-4 mt-0.5 shrink-0" />
                  <p>
                    No state event found for this repository. Push your
                    repository via <code className="font-mono">ngit push</code>{" "}
                    to create one, then return here to set the default branch.
                  </p>
                </div>
              </div>
            ) : branches.length === 0 ? (
              <div className="rounded-lg border border-muted bg-muted/30 px-4 py-3 text-sm text-muted-foreground">
                No branches found in the repository state event.
              </div>
            ) : (
              <div className="space-y-3">
                <DropdownMenu>
                  <DropdownMenuTrigger asChild>
                    <Button
                      id="default-branch"
                      variant="outline"
                      className="w-full max-w-xs justify-between font-mono text-sm"
                    >
                      <span className="flex items-center gap-2">
                        <GitBranch className="h-3.5 w-3.5 text-muted-foreground shrink-0" />
                        {selectedBranch || "Select branch…"}
                      </span>
                      <ChevronDown className="h-4 w-4 text-muted-foreground shrink-0" />
                    </Button>
                  </DropdownMenuTrigger>
                  <DropdownMenuContent className="w-[var(--radix-dropdown-menu-trigger-width)] min-w-[200px]">
                    {branches.map((branch) => (
                      <DropdownMenuItem
                        key={branch}
                        onSelect={() => {
                          setSelectedBranch(branch);
                          setUserHasSelectedBranch(
                            branch !== currentHeadBranch,
                          );
                        }}
                        className="flex items-center justify-between font-mono text-sm"
                      >
                        <span className="flex items-center gap-2">
                          <GitBranch className="h-3.5 w-3.5 text-muted-foreground shrink-0" />
                          {branch}
                        </span>
                        {branch === currentHeadBranch && (
                          <span className="text-xs text-muted-foreground ml-2">
                            current
                          </span>
                        )}
                      </DropdownMenuItem>
                    ))}
                  </DropdownMenuContent>
                </DropdownMenu>

                {currentHeadBranch && (
                  <p className="text-xs text-muted-foreground">
                    Current default branch:{" "}
                    <code className="font-mono bg-muted px-1 py-0.5 rounded">
                      {currentHeadBranch}
                    </code>
                  </p>
                )}
              </div>
            )}
          </section>

          <Separator />

          {/* ── Maintainers ─────────────────────────────────────────────── */}
          <section className="space-y-4">
            <div>
              <h2 className="text-sm font-semibold flex items-center gap-1.5">
                <Users className="h-4 w-4" />
                Maintainers
              </h2>
              {isMultiMaintainer || showMaintainerCoordination ? (
                <p className="text-xs text-muted-foreground mt-0.5 leading-relaxed">
                  You are editing only your selected announcement.
                  Co-maintainers become confirmed when the recursive maintainer
                  chain resolves them through reciprocal listings.
                </p>
              ) : null}
            </div>

            <Alert className="border-sky-500/40 bg-sky-500/5">
              <Users className="h-4 w-4 text-sky-600 dark:text-sky-400" />
              <AlertTitle>One relationship at a time</AlertTitle>
              <AlertDescription className="text-muted-foreground">
                Each operation refreshes the affected announcements and state,
                simulates the exact graph effect, rechecks predecessors before
                signing, and verifies the observed replacement. Unsupported
                topology, history, identity, and state cases publish nothing.
              </AlertDescription>
            </Alert>

            <div className="space-y-4 rounded-lg border border-border/60 bg-muted/10 p-4">
              {leadMaintainer === repo.selectedMaintainer ? (
                <div className="space-y-2">
                  <Label htmlFor="membership-target">
                    Invite one maintainer
                  </Label>
                  <div className="flex flex-col gap-2 sm:flex-row">
                    <Input
                      id="membership-target"
                      value={membershipTargetInput}
                      onChange={(event) => {
                        setMembershipTargetInput(event.target.value);
                        setMembershipTargetError(undefined);
                        membershipMutation.clearFailure();
                      }}
                      onKeyDown={(event) => {
                        if (event.key === "Enter") {
                          event.preventDefault();
                          handleSafeAddMaintainer();
                        }
                      }}
                      placeholder="npub1… or hex pubkey"
                      className="font-mono"
                      disabled={!!membershipMutation.pendingIntent}
                    />
                    <Button
                      type="button"
                      onClick={handleSafeAddMaintainer}
                      disabled={
                        !!membershipMutation.pendingIntent ||
                        !announcementsSettled ||
                        !stateSettled
                      }
                    >
                      {membershipMutation.pendingIntent?.type === "add" ? (
                        <Loader2 className="mr-2 h-4 w-4 animate-spin" />
                      ) : (
                        <Plus className="mr-2 h-4 w-4" />
                      )}
                      Invite
                    </Button>
                  </div>
                  {membershipTargetError && (
                    <p className="text-xs text-destructive">
                      {membershipTargetError}
                    </p>
                  )}
                </div>
              ) : (
                <p className="text-sm text-muted-foreground">
                  Roster changes are routed through the resolved lead. You can
                  leave this repository below; lead transfer and leadless
                  changes remain unsupported in the browser.
                </p>
              )}

              {leadMaintainer === repo.selectedMaintainer &&
                repo.maintainerEdges.some(
                  ({ from }) => from === repo.selectedMaintainer,
                ) && (
                  <div className="space-y-2 border-t border-border/50 pt-3">
                    <Label>Remove one direct relationship</Label>
                    {repo.maintainerEdges
                      .filter(
                        ({ from, to }) =>
                          from === repo.selectedMaintainer &&
                          to !== repo.selectedMaintainer,
                      )
                      .map(({ to }) => (
                        <div
                          key={to}
                          className="flex items-center gap-2 rounded-md border border-border/50 bg-background/60 px-3 py-2"
                        >
                          <UserLink
                            pubkey={to}
                            avatarSize="xs"
                            nameClassName="text-sm"
                            className="min-w-0 flex-1"
                          />
                          <Button
                            type="button"
                            variant="outline"
                            size="sm"
                            disabled={!!membershipMutation.pendingIntent}
                            onClick={() =>
                              void runMembershipIntent({
                                type: "remove",
                                targetPubkey: to,
                              })
                            }
                          >
                            {membershipMutation.pendingIntent?.type ===
                              "remove" &&
                            membershipMutation.pendingIntent.targetPubkey ===
                              to ? (
                              <Loader2 className="mr-2 h-3.5 w-3.5 animate-spin" />
                            ) : (
                              <X className="mr-2 h-3.5 w-3.5" />
                            )}
                            Remove
                          </Button>
                        </div>
                      ))}
                  </div>
                )}

              {leadMaintainer && leadMaintainer !== repo.selectedMaintainer && (
                <div className="flex flex-col gap-3 border-t border-border/50 pt-3 sm:flex-row sm:items-center sm:justify-between">
                  <div>
                    <Label>Leave repository</Label>
                    <p className="text-xs text-muted-foreground">
                      End your self-role while retaining the signed redirect to
                      the lead.
                    </p>
                  </div>
                  <Button
                    type="button"
                    variant="outline"
                    disabled={!!membershipMutation.pendingIntent}
                    onClick={() => void runMembershipIntent({ type: "leave" })}
                  >
                    {membershipMutation.pendingIntent?.type === "leave" && (
                      <Loader2 className="mr-2 h-4 w-4 animate-spin" />
                    )}
                    Leave repository
                  </Button>
                </div>
              )}

              {membershipSuccess && (
                <p
                  role="status"
                  className="rounded-md border border-emerald-500/30 bg-emerald-500/5 px-3 py-2 text-xs text-emerald-700 dark:text-emerald-300"
                >
                  {membershipSuccess}
                </p>
              )}
              {membershipMutation.failure && (
                <div
                  role="alert"
                  className="rounded-md border border-amber-500/30 bg-amber-500/5 px-3 py-2 text-xs leading-relaxed text-muted-foreground"
                >
                  <span className="font-mono text-amber-700 dark:text-amber-300">
                    {membershipMutation.failure.code}
                  </span>{" "}
                  {membershipMutation.failure.message}
                </div>
              )}
            </div>

            <div className="rounded-lg border border-border/60 bg-muted/10 p-3 space-y-3">
              <div>
                <p className="text-xs font-medium text-muted-foreground uppercase tracking-wide">
                  {isMultiMaintainer ? "Confirmed maintainers" : "Maintainer"}
                </p>
                {isMultiMaintainer ? (
                  <p className="text-xs text-muted-foreground/80 mt-0.5">
                    Resolved from the current recursive maintainer graph.
                  </p>
                ) : null}
              </div>

              <div className="space-y-2">
                {repo.confirmedMaintainers.map((pubkey) => {
                  const listedBy = maintainerListers.get(pubkey) ?? [];
                  const isLead = leadMaintainer === pubkey;
                  return (
                    <div
                      key={pubkey}
                      className="flex flex-wrap items-center gap-x-2 gap-y-1 rounded-md border border-border/50 bg-background/60 px-2.5 py-2"
                    >
                      <UserLink
                        pubkey={pubkey}
                        avatarSize="sm"
                        nameClassName="text-sm whitespace-nowrap"
                        className="min-w-fit flex-1"
                      />
                      {isMultiMaintainer ? (
                        <MaintainerListedBy pubkeys={listedBy} />
                      ) : null}
                      {isLead && <LeadBadge />}
                    </div>
                  );
                })}
              </div>

              {isMultiMaintainer || showMaintainerCoordination ? (
                <div className="rounded-md border border-border/40 bg-background/40 px-2.5 py-2 text-xs">
                  {leadMaintainer ? (
                    <LeadMaintainerSummary
                      hasLead
                      className="text-muted-foreground"
                    >
                      <UserName
                        pubkey={leadMaintainer}
                        className="text-xs text-foreground"
                        linkToProfile
                      />
                    </LeadMaintainerSummary>
                  ) : (
                    <LeadMaintainerSummary
                      hasLead={false}
                      className="text-muted-foreground"
                    />
                  )}
                </div>
              ) : null}

              {requestedMaintainers.length > 0 && (
                <div className="space-y-2 border-t border-border/50 pt-3">
                  <p className="text-xs font-medium text-muted-foreground uppercase tracking-wide">
                    Invited maintainer
                    {invitedMaintainers.length === 1 ? "" : "s"}
                  </p>

                  {invitedMaintainers.map((pubkey) => {
                    const listedBy =
                      requestedMaintainerListers.get(pubkey) ?? [];
                    const announcement = repo.discoveredAnnouncements.find(
                      (event) => event.pubkey === pubkey,
                    );
                    const announcementRelays = announcement
                      ? getRepoRelays(announcement)
                      : [];
                    const repositoryPath =
                      invitedMaintainersWithRepositories.has(pubkey)
                        ? repoToPath(
                            pubkey,
                            repo.dTag,
                            announcementRelays.length > 0
                              ? announcementRelays
                              : repo.relays,
                          )
                        : undefined;
                    return (
                      <div
                        key={pubkey}
                        className="flex flex-wrap items-center gap-x-2 gap-y-1 rounded-md border border-dashed border-border/60 bg-muted/10 px-2.5 py-1.5"
                      >
                        <UserLink
                          pubkey={pubkey}
                          avatarSize="xs"
                          nameClassName="text-xs text-muted-foreground whitespace-nowrap"
                          className="min-w-fit flex-1"
                        />
                        {repositoryPath && (
                          <span className="text-[11px] text-muted-foreground">
                            (has{" "}
                            <Link
                              to={repositoryPath}
                              className="underline-offset-2 hover:underline"
                            >
                              existing repository
                            </Link>
                            )
                          </span>
                        )}
                        {listedBy.length > 0 &&
                          listedBy.length <
                            repo.confirmedMaintainers.length && (
                            <MaintainerListedBy
                              pubkeys={listedBy}
                              label="Invited by"
                            />
                          )}
                        <Badge
                          variant="outline"
                          className="h-4 px-1.5 text-[10px] text-muted-foreground"
                        >
                          awaiting response
                        </Badge>
                      </div>
                    );
                  })}
                </div>
              )}
            </div>

            {showLegacyRosterEditor && (
              <>
                {showMaintainerCoordination ? (
                  <div className="space-y-3">
                    <div>
                      <Label className="flex items-center gap-1.5">
                        <Crown className="h-3.5 w-3.5 text-pink-500" />
                        Maintainer coordination
                      </Label>
                      <p className="mt-0.5 text-xs leading-relaxed text-muted-foreground">
                        With more than two maintainers, choose one person to
                        coordinate or explicitly keep responsibility shared.
                        This updates your maintainer list; it does not grant
                        extra permissions.
                      </p>
                    </div>

                    <RadioGroup
                      value={selectedLead}
                      onValueChange={handleSelectLead}
                      disabled
                      className="grid gap-2 sm:grid-cols-2"
                      aria-label="Maintainer coordination preference"
                    >
                      {orderedCoordinationCandidatePubkeys.map(
                        (pubkey, index) => {
                          const selected = selectedLead === pubkey;
                          const listedByCount =
                            coordinationCandidateListers.get(pubkey)?.length ??
                            0;

                          return (
                            <div key={pubkey} className="contents">
                              <label
                                className={cn(
                                  "flex cursor-pointer items-center gap-2 rounded-md border px-2.5 py-2 transition-colors",
                                  "focus-within:ring-2 focus-within:ring-ring focus-within:ring-offset-2",
                                  selected
                                    ? "border-pink-500/50 bg-pink-500/5"
                                    : "border-border/60 hover:bg-muted/30",
                                )}
                              >
                                <RadioGroupItem
                                  value={pubkey}
                                  aria-label={`Choose ${pubkey} as lead`}
                                />
                                <UserAvatar
                                  pubkey={pubkey}
                                  size="xs"
                                  noHoverCard
                                />
                                <UserName
                                  pubkey={pubkey}
                                  className="min-w-0 flex-1 truncate text-xs"
                                  noHoverCard
                                />
                                {pubkey === repo.selectedMaintainer ? (
                                  <Badge
                                    variant="outline"
                                    className="h-5 shrink-0 px-1.5 text-[10px]"
                                  >
                                    you
                                  </Badge>
                                ) : (
                                  <span className="shrink-0 text-[10px] text-muted-foreground">
                                    {listedByCount} listing
                                    {listedByCount === 1 ? "" : "s"}
                                  </span>
                                )}
                              </label>

                              {index === 0 ? (
                                <label
                                  className={cn(
                                    "flex cursor-pointer items-center gap-2 rounded-md border px-2.5 py-2 transition-colors",
                                    "focus-within:ring-2 focus-within:ring-ring focus-within:ring-offset-2",
                                    selectedLead === NO_LEAD
                                      ? "border-pink-500/50 bg-pink-500/5"
                                      : "border-border/60 hover:bg-muted/30",
                                  )}
                                >
                                  <RadioGroupItem
                                    value={NO_LEAD}
                                    aria-label="Choose no lead"
                                  />
                                  <Network className="h-4 w-4 shrink-0 text-sky-600 dark:text-sky-400" />
                                  <div className="min-w-0">
                                    <p className="text-xs font-medium">
                                      No lead
                                    </p>
                                    <p className="text-[11px] text-muted-foreground">
                                      List everyone you recognize
                                    </p>
                                  </div>
                                </label>
                              ) : null}
                            </div>
                          );
                        },
                      )}
                    </RadioGroup>

                    {selectedLead === NO_LEAD ? (
                      <p className="rounded-md bg-muted/40 px-2.5 py-2 text-xs leading-relaxed text-muted-foreground">
                        Everyone lists the maintainers they recognize. Removing
                        someone requires the maintainers you still recognize to
                        remove them too.
                      </p>
                    ) : selectedLead === repo.selectedMaintainer ? (
                      <p className="rounded-md bg-muted/40 px-2.5 py-2 text-xs leading-relaxed text-muted-foreground">
                        As lead, your announcement lists every maintainer. The
                        others must list you back before the shared graph
                        recognizes you as lead.
                      </p>
                    ) : (
                      <p className="rounded-md bg-muted/40 px-2.5 py-2 text-xs leading-relaxed text-muted-foreground">
                        Your announcement will keep{" "}
                        <UserName
                          pubkey={selectedLead}
                          className="text-xs text-foreground"
                          linkToProfile
                        />{" "}
                        as its direct maintainer link.
                      </p>
                    )}
                  </div>
                ) : null}

                {!showMaintainerCoordination ||
                selectedLead === NO_LEAD ||
                selectedLead === repo.selectedMaintainer ? (
                  <div className="space-y-2">
                    <div>
                      <Label>
                        {isMultiMaintainer || showMaintainerCoordination
                          ? "Co-maintainers you have listed"
                          : "Add co-maintainers"}
                      </Label>
                      {isMultiMaintainer || showMaintainerCoordination ? (
                        <p className="mt-0.5 text-xs text-muted-foreground">
                          These people are written to your repository
                          announcement. Your own pubkey is the event signer.
                        </p>
                      ) : null}
                    </div>

                    {editedMaintainers.length > 0 ? (
                      <div className="space-y-1.5">
                        {editedMaintainers.map((pubkey) => (
                          <div
                            key={pubkey}
                            className="flex items-center gap-2 rounded-md border border-border/60 bg-muted/20 px-3 py-1.5"
                          >
                            <UserLink
                              pubkey={pubkey}
                              avatarSize="xs"
                              nameClassName="text-sm"
                              className="min-w-0 flex-1"
                            />
                            <button
                              type="button"
                              disabled
                              onClick={() => handleRemoveMaintainer(pubkey)}
                              className="shrink-0 cursor-not-allowed text-muted-foreground opacity-50"
                              aria-label={`Remove maintainer ${pubkey}`}
                            >
                              <X className="h-3.5 w-3.5" />
                            </button>
                          </div>
                        ))}
                      </div>
                    ) : (
                      <div className="rounded-md border border-dashed border-border/70 bg-muted/10 px-3 py-3 text-xs text-muted-foreground">
                        You have not listed any co-maintainers.
                      </div>
                    )}

                    <div className="space-y-1.5">
                      <div className="flex gap-2">
                        <MaintainerUserInput
                          disabled
                          placeholder="Name, npub1…, or hex pubkey"
                          value={maintainerInput}
                          onValueChange={(value) => {
                            setMaintainerInput(value);
                            setMaintainerInputError(undefined);
                          }}
                          onAdd={handleAddMaintainer}
                          onSelectPubkey={addMaintainerPubkey}
                          priorityPubkeys={maintainerPickerPriorityPubkeys}
                          excludePubkeys={maintainerPickerExcludePubkeys}
                          className="h-8 text-sm font-mono"
                        />
                        <Button
                          type="button"
                          disabled
                          variant="outline"
                          size="sm"
                          onClick={handleAddMaintainer}
                          className="h-8 shrink-0 px-2.5"
                        >
                          <Plus className="h-3.5 w-3.5" />
                        </Button>
                      </div>
                      {maintainerInputError && (
                        <p className="px-0.5 text-xs text-red-500">
                          {maintainerInputError}
                        </p>
                      )}
                    </div>
                  </div>
                ) : null}

                {showMaintainerCoordination &&
                selectedLead === repo.selectedMaintainer &&
                coMaintainersListedByOthers.length > 0 ? (
                  <div className="space-y-2">
                    <div>
                      <Label>Co-maintainers listed by others</Label>
                      <p className="mt-0.5 text-xs text-muted-foreground">
                        These people are also listed by co-maintainers you
                        recognize.
                      </p>
                    </div>

                    <Alert className="border-amber-500/50 bg-amber-500/5">
                      <CircleAlert className="h-4 w-4 text-amber-600 dark:text-amber-400" />
                      <AlertTitle>
                        Removing them from your list is not enough
                      </AlertTitle>
                      <AlertDescription className="text-muted-foreground">
                        To fully remove one of these maintainers, the other
                        maintainers who list them must remove them too.
                      </AlertDescription>
                    </Alert>

                    <div className="space-y-1.5">
                      {coMaintainersListedByOthers.map(
                        ({ pubkey, listerPubkeys }) => (
                          <div
                            key={pubkey}
                            className="rounded-md border border-border/60 bg-background/60 px-2.5 py-2"
                          >
                            <UserLink
                              pubkey={pubkey}
                              avatarSize="xs"
                              nameClassName="text-sm"
                            />
                            <p className="ml-6 mt-1 text-xs leading-relaxed text-muted-foreground">
                              Ask <MaintainerNameList pubkeys={listerPubkeys} />{" "}
                              to remove{" "}
                              <UserName
                                pubkey={pubkey}
                                className="text-xs text-foreground"
                                linkToProfile
                              />{" "}
                              from{" "}
                              {listerPubkeys.length === 1
                                ? "their repository announcement"
                                : "each of their repository announcements"}{" "}
                              too.
                            </p>
                          </div>
                        ),
                      )}
                    </div>
                  </div>
                ) : null}

                {temporarilyRemovedMaintainers.length > 0 ? (
                  <Alert className="border-amber-500/50 bg-amber-500/5">
                    <CircleAlert className="h-4 w-4 text-amber-600 dark:text-amber-400" />
                    <AlertTitle>
                      This can temporarily remove{" "}
                      <MaintainerNameList
                        pubkeys={temporarilyRemovedMaintainers}
                      />
                    </AlertTitle>
                    <AlertDescription className="text-muted-foreground">
                      {selectedLead !== repo.selectedMaintainer ? (
                        <>
                          Consider asking{" "}
                          <MaintainerNameList pubkeys={[selectedLead]} /> to add{" "}
                          <MaintainerNameList
                            pubkeys={temporarilyRemovedMaintainers}
                          />{" "}
                          first. Otherwise saving will, at least temporarily,
                          remove them from this maintainer chain.
                        </>
                      ) : (
                        <>
                          Restore{" "}
                          <MaintainerNameList
                            pubkeys={temporarilyRemovedMaintainers}
                          />{" "}
                          unless you intend to remove them from your lead
                          announcement.
                        </>
                      )}
                    </AlertDescription>
                  </Alert>
                ) : null}

                {showMaintainerCoordination &&
                selectedLead === NO_LEAD &&
                stillRecognizedMaintainers.length > 0 ? (
                  <Alert className="border-sky-500/40 bg-sky-500/5">
                    <Network className="h-4 w-4 text-sky-600 dark:text-sky-400" />
                    <AlertTitle>Your change alone is not enough</AlertTitle>
                    <AlertDescription className="space-y-2 text-muted-foreground">
                      {stillRecognizedMaintainers.map(
                        ({ pubkey, listerPubkeys }) => (
                          <p key={pubkey}>
                            <UserName
                              pubkey={pubkey}
                              className="text-sm text-foreground"
                              linkToProfile
                            />{" "}
                            is still listed by{" "}
                            <MaintainerNameList pubkeys={listerPubkeys} />, whom
                            you continue to recognize. Ask{" "}
                            {listerPubkeys.length === 1
                              ? "them"
                              : "those maintainers"}{" "}
                            to remove{" "}
                            <UserName
                              pubkey={pubkey}
                              className="text-sm text-foreground"
                              linkToProfile
                            />{" "}
                            too.
                          </p>
                        ),
                      )}
                    </AlertDescription>
                  </Alert>
                ) : null}
              </>
            )}
          </section>

          <Separator />

          {/* ── Infrastructure ─────────────────────────────────────────── */}
          <section className="space-y-3">
            <div>
              <h2 className="text-sm font-semibold">Infrastructure</h2>
              <p className="text-xs text-muted-foreground mt-0.5">
                GRASP servers provide git hosting and Nostr relay in one.
                Alternatively, specify both a relay and a git server manually.
              </p>
            </div>

            {/* Grasp servers — always visible, primary path */}
            <div className="space-y-3">
              <div className="flex items-center gap-1.5 px-1">
                <GraspLogo className="h-3.5 w-3.5 text-pink-500" />
                <span className="text-sm font-medium">GRASP servers</span>
              </div>

              <div className="space-y-3 pl-1">
                <p className="text-xs text-muted-foreground leading-relaxed">
                  GRASP servers host your git data and act as relays. Clone and
                  relay URLs are auto-generated from your server selection.
                  Adding a new server requires pushing via{" "}
                  <code className="font-mono">ngit</code> afterwards.
                </p>

                <GraspServerSelector
                  selectedAddresses={selectedAddresses}
                  onSelectedAddressesChange={setSelectedAddresses}
                  resolvedServers={resolvedServers}
                  isFromUserList={isFromUserList}
                  currentAddresses={currentGraspAddresses}
                  showTitle={false}
                />

                {!hasInfrastructure && (
                  <p className="text-xs text-amber-600 dark:text-amber-400 px-0.5">
                    Select at least one GRASP server, or add both a relay and a
                    git server below.
                  </p>
                )}

                {/* Union Grasp servers from other maintainers */}
                {unionOnlyGraspAddresses.length > 0 && (
                  <UnionSection label="Covered by co-maintainers (read-only)">
                    {unionOnlyGraspAddresses.map(
                      ({ address, contributorPubkey }) => (
                        <UnionItem
                          key={address}
                          value={address}
                          contributorPubkey={contributorPubkey}
                          monospace
                        />
                      ),
                    )}
                  </UnionSection>
                )}
              </div>
            </div>

            {/* Other relays — optional, collapsed by default */}
            <Collapsible
              open={otherRelaysOpen}
              onOpenChange={setOtherRelaysOpen}
            >
              <CollapsibleTrigger asChild>
                <button
                  type="button"
                  className="flex w-full items-center justify-between rounded-md px-1 py-0.5 text-xs text-muted-foreground hover:text-foreground transition-colors"
                >
                  <span className="flex items-center gap-1.5">
                    {otherRelaysOpen ? (
                      <ChevronDown className="h-3 w-3" />
                    ) : (
                      <ChevronRight className="h-3 w-3" />
                    )}
                    <Radio className="h-3 w-3" />
                    <span className="font-medium">Other relays</span>
                    <span className="font-normal opacity-60 ml-0.5">
                      (optional)
                    </span>
                  </span>
                  {!otherRelaysOpen && otherRelays.length > 0 && (
                    <Badge
                      variant="secondary"
                      className="text-[10px] h-4 px-1.5"
                    >
                      {otherRelays.length}
                    </Badge>
                  )}
                </button>
              </CollapsibleTrigger>

              <CollapsibleContent className="space-y-3 pt-2 pl-1">
                <p className="text-xs text-muted-foreground leading-relaxed">
                  Additional Nostr relay URLs beyond GRASP servers.
                </p>

                {otherRelays.length > 0 && (
                  <div className="space-y-1.5">
                    {otherRelays.map((url) => (
                      <div
                        key={url}
                        className="flex items-center gap-2 rounded-md border border-border/60 bg-muted/20 px-3 py-1.5"
                      >
                        <code className="text-xs font-mono text-foreground/80 flex-1 truncate">
                          {url}
                        </code>
                        <button
                          type="button"
                          onClick={() => handleRemoveRelay(url)}
                          className="text-muted-foreground hover:text-foreground transition-colors shrink-0"
                          aria-label={`Remove ${url}`}
                        >
                          <X className="h-3.5 w-3.5" />
                        </button>
                      </div>
                    ))}
                  </div>
                )}

                <div className="space-y-1.5">
                  <div className="flex gap-2">
                    <Input
                      placeholder="wss://relay.example.com"
                      value={relayInput}
                      onChange={(e) => {
                        setRelayInput(e.target.value);
                        setRelayInputError(undefined);
                      }}
                      onKeyDown={(e) => {
                        if (e.key === "Enter") {
                          e.preventDefault();
                          handleAddRelay();
                        }
                      }}
                      className="h-8 text-sm font-mono"
                    />
                    <Button
                      type="button"
                      variant="outline"
                      size="sm"
                      onClick={handleAddRelay}
                      className="h-8 px-2.5 shrink-0"
                    >
                      <Plus className="h-3.5 w-3.5" />
                    </Button>
                  </div>
                  {relayInputError && (
                    <p className="text-xs text-red-500 px-0.5">
                      {relayInputError}
                    </p>
                  )}
                </div>

                {/* Union relays from other maintainers */}
                {unionOnlyRelays.length > 0 && (
                  <UnionSection label="Covered by co-maintainers (read-only)">
                    {unionOnlyRelays.map(({ url, contributorPubkey }) => (
                      <UnionItem
                        key={url}
                        value={url}
                        contributorPubkey={contributorPubkey}
                        monospace
                      />
                    ))}
                  </UnionSection>
                )}
              </CollapsibleContent>
            </Collapsible>

            {/* Other git servers — optional, collapsed by default */}
            <Collapsible
              open={otherGitServersOpen}
              onOpenChange={setOtherGitServersOpen}
            >
              <CollapsibleTrigger asChild>
                <button
                  type="button"
                  className="flex w-full items-center justify-between rounded-md px-1 py-0.5 text-xs text-muted-foreground hover:text-foreground transition-colors"
                >
                  <span className="flex items-center gap-1.5">
                    {otherGitServersOpen ? (
                      <ChevronDown className="h-3 w-3" />
                    ) : (
                      <ChevronRight className="h-3 w-3" />
                    )}
                    <GitBranch className="h-3 w-3" />
                    <span className="font-medium">Other git servers</span>
                    <span className="font-normal opacity-60 ml-0.5">
                      (optional)
                    </span>
                  </span>
                  {!otherGitServersOpen && otherGitServers.length > 0 && (
                    <Badge
                      variant="secondary"
                      className="text-[10px] h-4 px-1.5"
                    >
                      {otherGitServers.length}
                    </Badge>
                  )}
                </button>
              </CollapsibleTrigger>

              <CollapsibleContent className="space-y-3 pt-2 pl-1">
                <p className="text-xs text-muted-foreground leading-relaxed">
                  Additional raw git clone URLs beyond GRASP servers (e.g.
                  GitHub mirrors).
                </p>

                {otherGitServers.length > 0 && (
                  <div className="space-y-1.5">
                    {otherGitServers.map((url) => (
                      <div
                        key={url}
                        className="flex items-center gap-2 rounded-md border border-border/60 bg-muted/20 px-3 py-1.5"
                      >
                        <code className="text-xs font-mono text-foreground/80 flex-1 truncate break-all">
                          {url}
                        </code>
                        <button
                          type="button"
                          onClick={() => handleRemoveGitServer(url)}
                          className="text-muted-foreground hover:text-foreground transition-colors shrink-0"
                          aria-label={`Remove ${url}`}
                        >
                          <X className="h-3.5 w-3.5" />
                        </button>
                      </div>
                    ))}
                  </div>
                )}

                <div className="space-y-1.5">
                  <div className="flex gap-2">
                    <Input
                      placeholder="https://github.com/user/repo.git"
                      value={gitServerInput}
                      onChange={(e) => {
                        setGitServerInput(e.target.value);
                        setGitServerInputError(undefined);
                      }}
                      onKeyDown={(e) => {
                        if (e.key === "Enter") {
                          e.preventDefault();
                          handleAddGitServer();
                        }
                      }}
                      className="h-8 text-sm font-mono"
                    />
                    <Button
                      type="button"
                      variant="outline"
                      size="sm"
                      onClick={handleAddGitServer}
                      className="h-8 px-2.5 shrink-0"
                    >
                      <Plus className="h-3.5 w-3.5" />
                    </Button>
                  </div>
                  {gitServerInputError && (
                    <p className="text-xs text-red-500 px-0.5">
                      {gitServerInputError}
                    </p>
                  )}
                </div>

                {/* Union git servers from other maintainers */}
                {unionOnlyGitServers.length > 0 && (
                  <UnionSection label="Covered by co-maintainers (read-only)">
                    {unionOnlyGitServers.map(({ url, contributorPubkey }) => (
                      <UnionItem
                        key={url}
                        value={url}
                        contributorPubkey={contributorPubkey}
                        monospace
                      />
                    ))}
                  </UnionSection>
                )}
              </CollapsibleContent>
            </Collapsible>
          </section>

          <Separator />

          {/* ── Unknown / custom tags ──────────────────────────────────── */}
          <section className="space-y-3">
            <Collapsible
              open={unknownTagsOpen}
              onOpenChange={setUnknownTagsOpen}
            >
              <CollapsibleTrigger asChild>
                <button
                  type="button"
                  className="flex w-full items-center justify-between rounded-md px-1 py-0.5 text-xs text-muted-foreground hover:text-foreground transition-colors"
                >
                  <span className="flex items-center gap-1.5">
                    {unknownTagsOpen ? (
                      <ChevronDown className="h-3 w-3" />
                    ) : (
                      <ChevronRight className="h-3 w-3" />
                    )}
                    <Tag className="h-3 w-3" />
                    <span className="font-medium">Custom tags</span>
                    <span className="font-normal opacity-60 ml-0.5">
                      (advanced)
                    </span>
                  </span>
                  {!unknownTagsOpen && unknownTags.length > 0 && (
                    <Badge
                      variant="secondary"
                      className="text-[10px] h-4 px-1.5"
                    >
                      {unknownTags.length}
                    </Badge>
                  )}
                </button>
              </CollapsibleTrigger>

              <CollapsibleContent className="space-y-3 pt-2 pl-1">
                <p className="text-xs text-muted-foreground leading-relaxed">
                  Tags not recognised by this client are preserved here. Both
                  the tag name and values are editable. Use "add value" to
                  attach additional values to the same tag.
                </p>

                {unknownTags.length > 0 && (
                  <div className="space-y-2">
                    {unknownTags.map((tag, idx) => (
                      <UnknownTagRow
                        key={idx}
                        tag={tag}
                        onChange={(updated) =>
                          setUnknownTags((prev) =>
                            prev.map((t, i) => (i === idx ? updated : t)),
                          )
                        }
                        onRemove={() =>
                          setUnknownTags((prev) =>
                            prev.filter((_, i) => i !== idx),
                          )
                        }
                      />
                    ))}
                  </div>
                )}

                <AddCustomTagRow
                  onAdd={(tag) => setUnknownTags((prev) => [...prev, tag])}
                />
              </CollapsibleContent>
            </Collapsible>
          </section>

          {/* ── Error / actions ────────────────────────────────────────── */}
        </div>
      </div>

      <div className="sticky bottom-0 z-20 ml-[calc(50%_-_50vw)] w-screen border-y border-pink-200/70 bg-pink-50/95 py-4 backdrop-blur dark:border-pink-900/60 dark:bg-pink-950/40">
        <div className="container max-w-screen-xl px-4 md:px-8">
          <div className="max-w-2xl space-y-3">
            {saveError && (
              <div className="rounded-lg border border-red-500/20 bg-red-500/5 p-3">
                <div className="flex items-start gap-2">
                  <AlertTriangle className="h-4 w-4 text-red-500 mt-0.5 shrink-0" />
                  <p className="text-sm text-red-600 dark:text-red-400">
                    {saveError}
                  </p>
                </div>
              </div>
            )}

            <div className="flex items-center gap-3">
              <Button
                onClick={() => void handleSave()}
                disabled={!canSave}
                className="bg-pink-600 hover:bg-pink-700 text-white"
              >
                {isSaving ? (
                  <>
                    <Loader2 className="h-4 w-4 mr-2 animate-spin" />
                    Saving…
                  </>
                ) : (
                  "Save changes"
                )}
              </Button>
              <Button asChild variant="ghost">
                <Link to={`${basePath}/about`}>Cancel</Link>
              </Button>
            </div>
          </div>
        </div>
      </div>
    </div>
  );
}

// ---------------------------------------------------------------------------
// MaintainerUserInput — single-line user finder for co-maintainers
// ---------------------------------------------------------------------------

function MaintainerUserInput({
  disabled = false,
  value,
  onValueChange,
  onAdd,
  onSelectPubkey,
  priorityPubkeys,
  excludePubkeys,
  placeholder,
  className,
}: {
  disabled?: boolean;
  value: string;
  onValueChange: (value: string) => void;
  onAdd: () => void;
  onSelectPubkey: (pubkey: string) => void;
  priorityPubkeys: string[];
  excludePubkeys: string[];
  placeholder?: string;
  className?: string;
}) {
  const listboxId = useId();
  const inputRef = useRef<HTMLInputElement>(null);
  const [isFocused, setIsFocused] = useState(false);
  const [isSearching, setIsSearching] = useState(false);
  const [activeDescendantId, setActiveDescendantId] = useState<
    string | undefined
  >();
  const [dropdownPos, setDropdownPos] = useState<{
    top: number;
    left: number;
  } | null>(null);

  const raw = value.trim();
  const searchQuery = raw.startsWith("@") ? raw.slice(1) : raw;
  const shouldSearch =
    !disabled &&
    isFocused &&
    raw.length > 0 &&
    !looksLikeDirectPubkeyInput(raw);

  const updateDropdownPosition = useCallback(() => {
    const input = inputRef.current;
    if (!input) return;
    const rect = input.getBoundingClientRect();
    setDropdownPos({
      top: rect.bottom + 4,
      left: Math.max(0, Math.min(rect.left, window.innerWidth - 280)),
    });
  }, []);

  useEffect(() => {
    if (!shouldSearch) return;
    updateDropdownPosition();
    window.addEventListener("resize", updateDropdownPosition);
    return () => window.removeEventListener("resize", updateDropdownPosition);
  }, [shouldSearch, updateDropdownPosition]);

  const handleSelectPubkey = useCallback(
    (pubkey: string) => {
      onSelectPubkey(pubkey);

      // UserAutocompleteDropdown closes itself after selection. Restore both
      // DOM focus and our focus state on the next frame so the user can keep
      // typing another maintainer name and immediately get suggestions.
      requestAnimationFrame(() => {
        inputRef.current?.focus();
        setIsFocused(true);
        updateDropdownPosition();
      });
    },
    [onSelectPubkey, updateDropdownPosition],
  );

  return (
    <div className="relative flex-1">
      <Input
        ref={inputRef}
        disabled={disabled}
        placeholder={placeholder}
        value={value}
        onChange={(e) => {
          onValueChange(e.target.value);
          updateDropdownPosition();
        }}
        onFocus={() => {
          setIsFocused(true);
          updateDropdownPosition();
        }}
        onBlur={() => setIsFocused(false)}
        onKeyDown={(e) => {
          if (e.key === "Enter" && !shouldSearch) {
            e.preventDefault();
            onAdd();
          }
        }}
        aria-autocomplete="list"
        aria-haspopup="listbox"
        aria-expanded={shouldSearch}
        aria-controls={shouldSearch ? listboxId : undefined}
        aria-activedescendant={
          shouldSearch && activeDescendantId ? activeDescendantId : undefined
        }
        className={cn(className, isSearching && "pr-8")}
      />
      {!disabled && isSearching && (
        <>
          <span className="pointer-events-none absolute inset-y-0 right-2 flex items-center">
            <Loader2
              className="h-4 w-4 animate-spin text-muted-foreground"
              aria-hidden="true"
            />
          </span>
          <span className="sr-only" role="status" aria-live="polite">
            Searching users
          </span>
        </>
      )}
      <UserAutocompleteDropdown
        query={searchQuery}
        isOpen={!disabled && shouldSearch}
        position={dropdownPos}
        onSelectPubkey={handleSelectPubkey}
        onClose={() => setIsFocused(false)}
        keyboardTargetRef={inputRef}
        priorityPubkeys={priorityPubkeys}
        excludePubkeys={excludePubkeys}
        listboxId={listboxId}
        onActiveDescendantChange={setActiveDescendantId}
        onLoadingChange={setIsSearching}
      />
    </div>
  );
}

function MaintainerNameList({ pubkeys }: { pubkeys: string[] }) {
  return (
    <span className="inline">
      {pubkeys.map((pubkey, index) => (
        <span key={pubkey}>
          {index > 0 && (index === pubkeys.length - 1 ? " and " : ", ")}
          <UserName pubkey={pubkey} className="text-inherit" linkToProfile />
        </span>
      ))}
    </span>
  );
}

function computeMaintainerListers(
  listedPubkeys: string[],
  listerPubkeys: string[],
  maintainerEdges: ResolvedRepo["maintainerEdges"],
): Map<string, string[]> {
  const listed = new Set(listedPubkeys);
  const listers = new Set(listerPubkeys);
  const listerOrder = new Map(
    listerPubkeys.map((pubkey, index) => [pubkey, index]),
  );
  const listedByPubkey = new Map<string, string[]>();
  const seenEdges = new Set<string>();

  for (const pubkey of listedPubkeys) listedByPubkey.set(pubkey, []);

  for (const { from, to } of maintainerEdges) {
    if (!listers.has(from) || !listed.has(to)) continue;
    if (from === to) continue;

    const edgeKey = `${from}:${to}`;
    if (seenEdges.has(edgeKey)) continue;
    seenEdges.add(edgeKey);

    listedByPubkey.get(to)?.push(from);
  }

  for (const listedBy of listedByPubkey.values()) {
    listedBy.sort(
      (a, b) => (listerOrder.get(a) ?? 0) - (listerOrder.get(b) ?? 0),
    );
  }

  return listedByPubkey;
}

function MaintainerListedBy({
  pubkeys,
  label = "Listed by",
}: {
  pubkeys: string[];
  label?: string;
}) {
  if (pubkeys.length === 0) {
    return (
      <span className="shrink-0 text-[11px] text-muted-foreground">
        {label === "Listed by" ? "Not listed yet" : `${label} unknown`}
      </span>
    );
  }

  return (
    <div className="flex min-w-0 max-w-full shrink items-center gap-1.5 text-[11px] text-muted-foreground">
      <span className="shrink-0">{label}</span>
      <div className="flex min-w-0 flex-wrap items-center gap-x-2 gap-y-1">
        {pubkeys.map((pubkey) => (
          <span key={pubkey} className="inline-flex min-w-0 items-center gap-1">
            <UserAvatar pubkey={pubkey} size="xs" linkToProfile />
            <UserName
              pubkey={pubkey}
              className="hidden max-w-24 truncate text-[11px] text-foreground md:inline-block"
              linkToProfile
            />
          </span>
        ))}
      </div>
    </div>
  );
}

// ---------------------------------------------------------------------------
// UnknownTagRow — editable row for a single unknown/custom tag
// ---------------------------------------------------------------------------

/**
 * Two-column layout:
 *   left  — editable tag name input (fixed width)
 *   right — stacked value inputs, one per line, with per-value × and an
 *           "add value" + button below the last one
 *
 * The outer × (top-right) removes the entire tag.
 */
function UnknownTagRow({
  tag,
  onChange,
  onRemove,
}: {
  tag: string[];
  onChange: (updated: string[]) => void;
  onRemove: () => void;
}) {
  const [name, ...rawValues] = tag;
  // Always show at least one value input
  const values = rawValues.length > 0 ? rawValues : [""];

  const handleNameChange = (newName: string) => {
    onChange([newName, ...values]);
  };

  const handleValueChange = (valueIdx: number, newVal: string) => {
    const newValues = values.map((v, i) => (i === valueIdx ? newVal : v));
    onChange([name, ...newValues]);
  };

  const handleRemoveValue = (valueIdx: number) => {
    const newValues = values.filter((_, i) => i !== valueIdx);
    // Keep at least one empty value so the input is always visible
    onChange([name, ...(newValues.length > 0 ? newValues : [""])]);
  };

  const handleAddValue = () => {
    onChange([name, ...values, ""]);
  };

  return (
    <div className="rounded-md border border-border/60 bg-muted/20 px-3 py-2">
      <div className="flex items-start gap-2">
        {/* Left column — tag name */}
        <Input
          value={name}
          onChange={(e) => handleNameChange(e.target.value)}
          className="h-7 w-24 shrink-0 text-xs font-mono"
          placeholder="name"
          aria-label="Tag name"
        />

        {/* Right column — value inputs stacked */}
        <div className="flex-1 space-y-1">
          {values.map((val, i) => (
            <div key={i} className="flex items-center gap-1.5">
              <Input
                value={val}
                onChange={(e) => handleValueChange(i, e.target.value)}
                className="h-7 text-xs font-mono flex-1"
                placeholder="value"
              />
              {values.length > 1 && (
                <button
                  type="button"
                  onClick={() => handleRemoveValue(i)}
                  className="text-muted-foreground hover:text-foreground transition-colors shrink-0"
                  aria-label="Remove value"
                >
                  <X className="h-3 w-3" />
                </button>
              )}
            </div>
          ))}
          {/* Add another value */}
          <button
            type="button"
            onClick={handleAddValue}
            className="flex items-center gap-1 text-xs text-muted-foreground hover:text-foreground transition-colors pt-0.5"
            aria-label="Add value"
          >
            <Plus className="h-3 w-3" />
            <span>add value</span>
          </button>
        </div>

        {/* Remove whole tag */}
        <button
          type="button"
          onClick={onRemove}
          className="text-muted-foreground hover:text-destructive transition-colors shrink-0 mt-1"
          aria-label={`Remove tag ${name}`}
        >
          <X className="h-3.5 w-3.5" />
        </button>
      </div>
    </div>
  );
}

// ---------------------------------------------------------------------------
// AddCustomTagRow — form for adding a brand-new custom tag
// ---------------------------------------------------------------------------

/**
 * Same two-column layout as UnknownTagRow. Manages its own pending name +
 * values list before committing, so the "add value" button is visible from
 * the start and makes the multi-value capability obvious.
 */
function AddCustomTagRow({ onAdd }: { onAdd: (tag: string[]) => void }) {
  const [tagName, setTagName] = useState("");
  const [values, setValues] = useState<string[]>([""]);
  const [error, setError] = useState<string | undefined>();

  const handleCommit = () => {
    const name = tagName.trim();
    if (!name) {
      setError("Tag name is required");
      return;
    }
    if (KNOWN_TAG_NAMES.has(name)) {
      setError(`"${name}" is managed by the form above`);
      return;
    }
    onAdd([name, ...values]);
    setTagName("");
    setValues([""]);
    setError(undefined);
  };

  const handleValueChange = (i: number, val: string) => {
    setValues((prev) => prev.map((v, idx) => (idx === i ? val : v)));
  };

  const handleRemoveValue = (i: number) => {
    setValues((prev) => {
      const next = prev.filter((_, idx) => idx !== i);
      return next.length > 0 ? next : [""];
    });
  };

  return (
    <div className="space-y-1.5">
      <div className="flex items-start gap-2">
        {/* Left — tag name */}
        <Input
          placeholder="tag name"
          value={tagName}
          onChange={(e) => {
            setTagName(e.target.value);
            setError(undefined);
          }}
          onKeyDown={(e) => {
            if (e.key === "Enter") {
              e.preventDefault();
              handleCommit();
            }
          }}
          className="h-7 w-24 shrink-0 text-xs font-mono"
        />

        {/* Right — values */}
        <div className="flex-1 space-y-1">
          {values.map((val, i) => (
            <div key={i} className="flex items-center gap-1.5">
              <Input
                placeholder="value"
                value={val}
                onChange={(e) => handleValueChange(i, e.target.value)}
                onKeyDown={(e) => {
                  if (e.key === "Enter") {
                    e.preventDefault();
                    handleCommit();
                  }
                }}
                className="h-7 text-xs font-mono flex-1"
              />
              {values.length > 1 && (
                <button
                  type="button"
                  onClick={() => handleRemoveValue(i)}
                  className="text-muted-foreground hover:text-foreground transition-colors shrink-0"
                  aria-label="Remove value"
                >
                  <X className="h-3 w-3" />
                </button>
              )}
            </div>
          ))}
          <button
            type="button"
            onClick={() => setValues((prev) => [...prev, ""])}
            className="flex items-center gap-1 text-xs text-muted-foreground hover:text-foreground transition-colors pt-0.5"
          >
            <Plus className="h-3 w-3" />
            <span>add value</span>
          </button>
        </div>

        {/* Commit */}
        <Button
          type="button"
          variant="outline"
          size="sm"
          onClick={handleCommit}
          className="h-7 px-2.5 shrink-0"
        >
          <Plus className="h-3.5 w-3.5" />
        </Button>
      </div>
      {error && <p className="text-xs text-red-500 px-0.5">{error}</p>}
    </div>
  );
}

// ---------------------------------------------------------------------------
// UnionSection — collapsible section for union-only items from co-maintainers
// ---------------------------------------------------------------------------

function UnionSection({
  label,
  children,
}: {
  label: string;
  children: React.ReactNode;
}) {
  const [open, setOpen] = useState(false);

  return (
    <Collapsible open={open} onOpenChange={setOpen}>
      <CollapsibleTrigger asChild>
        <button
          type="button"
          className="flex items-center gap-1.5 text-xs text-muted-foreground/70 hover:text-muted-foreground transition-colors"
        >
          {open ? (
            <ChevronDown className="h-3 w-3" />
          ) : (
            <ChevronRight className="h-3 w-3" />
          )}
          <Users className="h-3 w-3" />
          {label}
        </button>
      </CollapsibleTrigger>
      <CollapsibleContent className="space-y-1.5 pt-2">
        <p className="text-xs text-muted-foreground/70 leading-relaxed px-1 pb-1">
          These are contributed by co-maintainers' announcements and are
          included via union. They are not in your announcement.
        </p>
        {children}
      </CollapsibleContent>
    </Collapsible>
  );
}

// ---------------------------------------------------------------------------
// UnionItem — a single read-only item with contributor attribution
// ---------------------------------------------------------------------------

function UnionItem({
  value,
  contributorPubkey,
  monospace = false,
}: {
  value: string;
  contributorPubkey: string;
  monospace?: boolean;
}) {
  return (
    <div className="flex items-center gap-2 rounded-md border border-border/40 bg-muted/10 px-3 py-1.5 opacity-75">
      <span
        className={cn(
          "text-xs text-foreground/60 flex-1 truncate",
          monospace && "font-mono",
        )}
      >
        {value}
      </span>
      {contributorPubkey && (
        <span className="text-[10px] text-muted-foreground/60 shrink-0 flex items-center gap-1">
          via{" "}
          <UserName
            pubkey={contributorPubkey}
            className="text-[10px] text-muted-foreground/60"
          />
        </span>
      )}
    </div>
  );
}
