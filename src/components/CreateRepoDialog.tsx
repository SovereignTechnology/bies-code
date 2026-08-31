/**
 * CreateRepoDialog — dialog for creating a new git repository using Grasp.
 *
 * Shows a form (name, description, optional advanced Grasp settings) then
 * transitions to a step-by-step progress view during creation.
 */

import { useState, useMemo, useCallback, useEffect } from "react";
import { useNavigate } from "react-router-dom";
import { useActiveAccount } from "applesauce-react/hooks";
import {
  Check,
  Circle,
  Loader2,
  X,
  AlertTriangle,
  ChevronDown,
  ChevronRight,
} from "lucide-react";
import {
  Dialog,
  DialogContent,
  DialogHeader,
  DialogTitle,
  DialogDescription,
} from "@/components/ui/dialog";
import { Button } from "@/components/ui/button";
import { Input } from "@/components/ui/input";
import { Textarea } from "@/components/ui/textarea";
import { Label } from "@/components/ui/label";
import { Badge } from "@/components/ui/badge";
import { Checkbox } from "@/components/ui/checkbox";
import {
  Collapsible,
  CollapsibleContent,
  CollapsibleTrigger,
} from "@/components/ui/collapsible";
import { toRepoIdentifier, validateRepoIdentifier } from "@/lib/create-repo";
import {
  useCreateRepo,
  type CreateRepoStep,
  type CreateRepoFormInput,
} from "@/hooks/useCreateRepo";
import { useGraspServers, type GraspServer } from "@/hooks/useGraspServers";
import { useRepoPath } from "@/hooks/useRepoPath";
import { usePublish } from "@/hooks/usePublish";
import { GraspServerSelector } from "@/components/GraspServerSelector";
import { graspServerFromAddress } from "@/lib/grasp";
import { usePrivateGitRelays } from "@/hooks/usePrivateGitRelays";

// ---------------------------------------------------------------------------
// Constants
// ---------------------------------------------------------------------------

const GRASP_LIST_KIND = 10317;

// ---------------------------------------------------------------------------
// Props
// ---------------------------------------------------------------------------

interface CreateRepoDialogProps {
  isOpen: boolean;
  onClose: () => void;
}

// ---------------------------------------------------------------------------
// Step indicator
// ---------------------------------------------------------------------------

const STEPS: { key: CreateRepoStep; label: string }[] = [
  { key: "building-commit", label: "Building initial commit" },
  { key: "signing-events", label: "Signing events" },
  {
    key: "publishing-announcement",
    label: "Publishing repository announcement",
  },
  { key: "publishing-state", label: "Publishing repository state" },
  { key: "pushing", label: "Pushing git data" },
];

const STEP_ORDER: CreateRepoStep[] = STEPS.map((s) => s.key);

function StepIcon({
  step,
  currentStep,
}: {
  step: CreateRepoStep;
  currentStep: CreateRepoStep;
}) {
  const stepIdx = STEP_ORDER.indexOf(step);
  const currentIdx = STEP_ORDER.indexOf(currentStep);

  if (currentStep === "error") {
    if (stepIdx < currentIdx) {
      return <Check className="h-4 w-4 text-green-500" />;
    }
    if (stepIdx === currentIdx) {
      return <X className="h-4 w-4 text-red-500" />;
    }
    return <Circle className="h-3.5 w-3.5 text-muted-foreground/40" />;
  }

  if (currentStep === "done") {
    return <Check className="h-4 w-4 text-green-500" />;
  }

  if (stepIdx < currentIdx) {
    return <Check className="h-4 w-4 text-green-500" />;
  }
  if (stepIdx === currentIdx) {
    return <Loader2 className="h-4 w-4 text-pink-500 animate-spin" />;
  }
  return <Circle className="h-3.5 w-3.5 text-muted-foreground/40" />;
}

// ---------------------------------------------------------------------------
// Purgatory countdown
// ---------------------------------------------------------------------------

function PurgatoryCountdown({ publishedAt }: { publishedAt: number }) {
  const [now, setNow] = useState(Date.now());

  useEffect(() => {
    const interval = setInterval(() => setNow(Date.now()), 1000);
    return () => clearInterval(interval);
  }, []);

  const expiresAt = publishedAt + 30 * 60 * 1000; // 30 minutes
  const remaining = Math.max(0, Math.floor((expiresAt - now) / 1000));
  const minutes = Math.floor(remaining / 60);
  const seconds = remaining % 60;

  if (remaining <= 0) {
    return (
      <p className="text-sm text-red-500">
        Purgatory window has expired. Events may have been discarded.
      </p>
    );
  }

  return (
    <p className="text-sm text-muted-foreground">
      Events are in purgatory. You have{" "}
      <span className="font-mono font-medium text-foreground">
        {minutes}:{seconds.toString().padStart(2, "0")}
      </span>{" "}
      to retry before they expire.
    </p>
  );
}

// ---------------------------------------------------------------------------
// Success redirect helper
// ---------------------------------------------------------------------------

function SuccessActions({
  pubkey,
  identifier,
  onClose,
}: {
  pubkey: string;
  identifier: string;
  onClose: () => void;
}) {
  const navigate = useNavigate();
  const repoPath = useRepoPath(pubkey, identifier, []);

  const handleViewRepo = useCallback(() => {
    onClose();
    navigate(repoPath);
  }, [navigate, repoPath, onClose]);

  return (
    <div className="space-y-4">
      <Button onClick={handleViewRepo} className="w-full">
        View Repository
      </Button>
    </div>
  );
}

// ---------------------------------------------------------------------------
// Main dialog
// ---------------------------------------------------------------------------

export function CreateRepoDialog({ isOpen, onClose }: CreateRepoDialogProps) {
  const account = useActiveAccount();
  const pubkey = account?.pubkey;
  const {
    servers: resolvedServers,
    isFromUserList,
    isLoading: serversLoading,
  } = useGraspServers(pubkey);

  const { state, execute, retryPush, reset } = useCreateRepo();
  const { state: privateRelayState } = usePrivateGitRelays();
  const { publishEvent } = usePublish();

  // Form state
  const [name, setName] = useState("");
  const [description, setDescription] = useState("");
  const [privateRepository, setPrivateRepository] = useState(false);

  // Advanced section state
  const [advancedOpen, setAdvancedOpen] = useState(false);
  // selectedAddresses: the GRASP service endpoints chosen for this repo.
  // Initialised from resolvedServers once they load.
  const [selectedAddresses, setSelectedAddresses] = useState<string[]>([]);
  // Whether to save these servers as the user's default grasp list
  const [saveAsDefaults, setSaveAsDefaults] = useState(false);

  // Derived identifier
  const identifier = useMemo(() => toRepoIdentifier(name), [name]);
  const identifierError = useMemo(
    () => (name.trim() ? validateRepoIdentifier(identifier) : undefined),
    [name, identifier],
  );

  const privateServers = useMemo(
    () =>
      privateRelayState.status === "ready"
        ? privateRelayState.relayUrls.flatMap((relay) => {
            const server = graspServerFromAddress(relay);
            return server ? [server] : [];
          })
        : [],
    [privateRelayState],
  );
  const selectableServers = privateRepository
    ? privateServers
    : resolvedServers;

  // Build the effective GraspServer list from selectedAddresses.
  const selectedServers = useMemo<GraspServer[]>(() => {
    return selectedAddresses.flatMap((address) => {
      const existing = selectableServers.find(
        (server) => server.serviceAddress === address,
      );
      // Private creation never accepts an endpoint outside the current
      // decrypted list. Public creation retains the advanced custom input.
      const server =
        existing ??
        (privateRepository ? undefined : graspServerFromAddress(address));
      return server ? [server] : [];
    });
  }, [selectedAddresses, selectableServers, privateRepository]);

  // Initialise selectedAddresses when servers load or the dialog opens.
  useEffect(() => {
    if (selectableServers.length > 0 && selectedAddresses.length === 0) {
      setSelectedAddresses(
        privateRepository
          ? [selectableServers[0].serviceAddress]
          : selectableServers.map((server) => server.serviceAddress),
      );
    }
  }, [selectableServers, selectedAddresses.length, privateRepository]);

  // Reset form when dialog opens
  useEffect(() => {
    if (isOpen) {
      setName("");
      setDescription("");
      setPrivateRepository(false);
      setSelectedAddresses(
        resolvedServers.map((server) => server.serviceAddress),
      );
      setSaveAsDefaults(false);
      setAdvancedOpen(false);
      reset();
    }
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [isOpen, reset]);

  // When resolvedServers change (e.g. after load) and we haven't customised yet,
  // sync selectedAddresses to the new resolved list.
  useEffect(() => {
    if (!advancedOpen || privateRepository) {
      setSelectedAddresses(
        privateRepository
          ? privateServers.slice(0, 1).map((server) => server.serviceAddress)
          : resolvedServers.map((server) => server.serviceAddress),
      );
    }
  }, [resolvedServers, privateServers, advancedOpen, privateRepository]);

  const handleClose = useCallback(() => {
    if (
      state.step !== "idle" &&
      state.step !== "done" &&
      state.step !== "error"
    ) {
      return;
    }
    onClose();
  }, [state.step, onClose]);

  const canSubmit =
    name.trim().length > 0 &&
    !identifierError &&
    selectedServers.length > 0 &&
    (!privateRepository ||
      (privateRelayState.status === "ready" && selectedServers.length === 1)) &&
    state.step === "idle";

  const handleSubmit = useCallback(async () => {
    if (!canSubmit) return;

    // Optionally save as defaults before creating
    if (!privateRepository && saveAsDefaults && account) {
      try {
        const tags = selectedServers.map((s) => ["g", s.wsUrl]);
        await publishEvent({
          kind: GRASP_LIST_KIND,
          content: "",
          tags,
          created_at: Math.floor(Date.now() / 1000),
        });
      } catch {
        // Non-fatal — continue with repo creation even if saving defaults fails
      }
    }

    const input: CreateRepoFormInput = {
      name: name.trim(),
      description: description.trim(),
      identifier,
      graspServers: selectedServers,
      private: privateRepository,
    };

    await execute(input);
  }, [
    canSubmit,
    saveAsDefaults,
    account,
    selectedServers,
    publishEvent,
    name,
    description,
    identifier,
    execute,
    privateRepository,
  ]);

  const handleRetry = useCallback(async () => {
    if (!state.commitHash) return;

    const input: CreateRepoFormInput = {
      name: name.trim(),
      description: description.trim(),
      identifier,
      graspServers: selectedServers,
      private: privateRepository,
    };

    await retryPush(input, state.commitHash);
  }, [
    state.commitHash,
    name,
    description,
    identifier,
    selectedServers,
    retryPush,
    privateRepository,
  ]);

  const isInProgress =
    state.step !== "idle" && state.step !== "done" && state.step !== "error";

  // Whether the current selection differs from the resolved defaults
  const hasCustomSelection = useMemo(() => {
    const resolvedAddresses = resolvedServers
      .map((server) => server.serviceAddress)
      .sort();
    const current = [...selectedAddresses].sort();
    return (
      current.length !== resolvedAddresses.length ||
      current.some((address, index) => address !== resolvedAddresses[index])
    );
  }, [resolvedServers, selectedAddresses]);

  // Label for the advanced trigger
  const advancedLabel = useMemo(() => {
    if (selectedAddresses.length === 0) return "No servers selected";
    if (selectedAddresses.length === 1) return selectedAddresses[0];
    return `${selectedAddresses.length} servers`;
  }, [selectedAddresses]);

  return (
    <Dialog open={isOpen} onOpenChange={(open) => !open && handleClose()}>
      <DialogContent className="sm:max-w-md">
        <DialogHeader>
          <DialogTitle>
            {state.step === "done"
              ? "Repository created"
              : state.step === "idle"
                ? "Create a new repository"
                : "Creating repository..."}
          </DialogTitle>
          {state.step === "idle" && (
            <DialogDescription>
              Create a git repository hosted using Grasp.
            </DialogDescription>
          )}
        </DialogHeader>

        {/* ── Form view ──────────────────────────────────────────── */}
        {state.step === "idle" && (
          <div className="space-y-4">
            {/* Repository name */}
            <div className="space-y-2">
              <Label htmlFor="repo-name">Repository name</Label>
              <Input
                id="repo-name"
                placeholder="my-project"
                value={name}
                onChange={(e) => setName(e.target.value)}
                autoFocus
              />
              {name.trim() && (
                <div className="flex items-center gap-1.5">
                  {identifierError ? (
                    <p className="text-xs text-red-500">{identifierError}</p>
                  ) : (
                    <p className="text-xs text-muted-foreground">
                      Identifier:{" "}
                      <code className="font-mono text-foreground">
                        {identifier}
                      </code>
                    </p>
                  )}
                </div>
              )}
            </div>

            {/* Description */}
            <div className="space-y-2">
              <Label htmlFor="repo-description">
                Description{" "}
                <span className="text-muted-foreground font-normal">
                  (optional)
                </span>
              </Label>
              <Textarea
                id="repo-description"
                placeholder="A brief description of the project"
                value={description}
                onChange={(e) => setDescription(e.target.value)}
                rows={2}
                className="resize-none"
              />
            </div>

            {/* Info strip */}
            <div className="rounded-lg border border-border/60 bg-muted/30 px-3 py-2.5">
              <div className="flex items-center gap-2 text-xs text-muted-foreground">
                <Badge
                  variant="secondary"
                  className="text-[10px] px-1.5 py-0 h-5"
                >
                  main
                </Badge>
                <span>Default branch</span>
                <span className="text-muted-foreground/40 mx-1">|</span>
                <span>README.md will be created</span>
              </div>
            </div>

            <label className="flex cursor-pointer items-start gap-2.5 rounded-lg border border-border/60 px-3 py-3">
              <Checkbox
                checked={privateRepository}
                onCheckedChange={(value) => {
                  setPrivateRepository(!!value);
                  setSelectedAddresses([]);
                  setSaveAsDefaults(false);
                }}
                id="private-repository"
                className="mt-0.5"
              />
              <div className="space-y-0.5">
                <span className="text-sm font-medium">Private repository</span>
                <p className="text-xs text-muted-foreground">
                  Create on one GRASP-08 service from your encrypted Private Git
                  services list.
                </p>
              </div>
            </label>

            {/* ── Advanced / Grasp servers ──────────────────────────── */}
            <Collapsible open={advancedOpen} onOpenChange={setAdvancedOpen}>
              <CollapsibleTrigger asChild>
                <button
                  type="button"
                  className="flex w-full items-center justify-between rounded-md px-1 py-1 text-sm text-muted-foreground hover:text-foreground transition-colors"
                >
                  <span className="flex items-center gap-1.5">
                    {advancedOpen ? (
                      <ChevronDown className="h-3.5 w-3.5" />
                    ) : (
                      <ChevronRight className="h-3.5 w-3.5" />
                    )}
                    {privateRepository
                      ? "Private GRASP-08 service"
                      : "GRASP servers"}
                  </span>
                  {!advancedOpen && (
                    <span className="text-xs font-mono text-muted-foreground/70 flex items-center gap-1">
                      {(
                        privateRepository
                          ? privateRelayState.status === "loading"
                          : serversLoading
                      ) ? (
                        <Loader2 className="h-3 w-3 animate-spin" />
                      ) : (
                        <>
                          {advancedLabel}
                          {hasCustomSelection && (
                            <span className="ml-1 text-pink-500">(custom)</span>
                          )}
                        </>
                      )}
                    </span>
                  )}
                </button>
              </CollapsibleTrigger>

              <CollapsibleContent className="space-y-3 pt-2">
                {(
                  privateRepository
                    ? privateRelayState.status === "loading"
                    : serversLoading
                ) ? (
                  <div className="flex items-center gap-2 text-sm text-muted-foreground px-1">
                    <Loader2 className="h-3.5 w-3.5 animate-spin" />
                    Loading your server list...
                  </div>
                ) : (
                  <>
                    {privateRepository ? (
                      privateRelayState.status !== "ready" ? (
                        <p className="text-sm text-amber-600 dark:text-amber-400">
                          Your encrypted Private Git services list is
                          unavailable.
                        </p>
                      ) : privateServers.length === 0 ? (
                        <p className="text-sm text-muted-foreground">
                          Add a GRASP-08 service in Settings before creating a
                          private repository.
                        </p>
                      ) : (
                        <div className="space-y-2">
                          {privateServers.map((server) => (
                            <label
                              key={server.wsUrl}
                              className="flex cursor-pointer items-center gap-2 rounded-md border px-3 py-2 text-sm"
                            >
                              <input
                                type="radio"
                                name="private-grasp-service"
                                checked={selectedAddresses.includes(
                                  server.serviceAddress,
                                )}
                                onChange={() =>
                                  setSelectedAddresses([server.serviceAddress])
                                }
                              />
                              <span className="font-mono text-xs">
                                {server.serviceAddress}
                              </span>
                            </label>
                          ))}
                        </div>
                      )
                    ) : (
                      <GraspServerSelector
                        selectedAddresses={selectedAddresses}
                        onSelectedAddressesChange={setSelectedAddresses}
                        resolvedServers={resolvedServers}
                        isFromUserList={isFromUserList}
                        showTitle={false}
                      />
                    )}

                    {/* Save as defaults */}
                    {!privateRepository && (
                      <label className="flex items-start gap-2.5 cursor-pointer rounded-md px-2.5 py-2 hover:bg-muted/40 transition-colors border border-border/40">
                        <Checkbox
                          checked={saveAsDefaults}
                          onCheckedChange={(v) => setSaveAsDefaults(!!v)}
                          id="save-defaults"
                          className="mt-0.5"
                        />
                        <div className="space-y-0.5">
                          <span className="text-sm font-medium">
                            Save as my Grasp defaults
                          </span>
                          <p className="text-xs text-muted-foreground">
                            {isFromUserList
                              ? "Overwrite your saved server list with this selection."
                              : "Save this selection so future repositories use these servers by default."}
                          </p>
                        </div>
                      </label>
                    )}
                  </>
                )}
              </CollapsibleContent>
            </Collapsible>

            {/* Actions */}
            <div className="flex justify-end gap-2 pt-2">
              <Button variant="outline" onClick={onClose}>
                Cancel
              </Button>
              <Button onClick={handleSubmit} disabled={!canSubmit}>
                Create Repository
              </Button>
            </div>
          </div>
        )}

        {/* ── Progress view ──────────────────────────────────────── */}
        {(isInProgress || state.step === "error" || state.step === "done") && (
          <div className="space-y-4">
            {/* Step list */}
            <div className="space-y-2.5">
              {STEPS.map(({ key, label }) => (
                <div key={key} className="flex items-center gap-2.5">
                  <StepIcon step={key} currentStep={state.step} />
                  <span
                    className={
                      STEP_ORDER.indexOf(key) <= STEP_ORDER.indexOf(state.step)
                        ? "text-sm text-foreground"
                        : "text-sm text-muted-foreground/60"
                    }
                  >
                    {label}
                    {key === "pushing" && selectedServers.length > 0 && (
                      <span className="text-muted-foreground">
                        {" "}
                        to{" "}
                        {selectedServers
                          .map((server) => server.serviceAddress)
                          .join(", ")}
                      </span>
                    )}
                  </span>
                </div>
              ))}
            </div>

            {/* Error state */}
            {state.step === "error" && (
              <div className="space-y-3">
                <div className="rounded-lg border border-red-500/20 bg-red-500/5 p-3">
                  <div className="flex items-start gap-2">
                    <AlertTriangle className="h-4 w-4 text-red-500 mt-0.5 shrink-0" />
                    <p className="text-sm text-red-600 dark:text-red-400">
                      {state.error}
                    </p>
                  </div>
                </div>

                {state.publishedAt && (
                  <PurgatoryCountdown publishedAt={state.publishedAt} />
                )}

                <div className="flex justify-end gap-2">
                  <Button variant="outline" onClick={handleClose}>
                    Cancel
                  </Button>
                  {state.publishedAt && state.commitHash && (
                    <Button onClick={handleRetry}>Retry Push</Button>
                  )}
                </div>
              </div>
            )}

            {/* Success state */}
            {state.step === "done" &&
              pubkey &&
              state.identifier &&
              state.cloneUrl && (
                <SuccessActions
                  pubkey={pubkey}
                  identifier={state.identifier}
                  onClose={onClose}
                />
              )}

            {/* In-progress — show a subtle message */}
            {isInProgress && (
              <p className="text-xs text-muted-foreground text-center">
                This may take a few seconds.
              </p>
            )}
          </div>
        )}
      </DialogContent>
    </Dialog>
  );
}
