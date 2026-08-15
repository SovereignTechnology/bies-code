import { useCallback, useMemo, useState } from "react";
import { useActiveAccount } from "applesauce-react/hooks";
import { formatDistanceToNow } from "date-fns";
import {
  Clock3,
  Eye,
  EyeOff,
  KeyRound,
  Loader2,
  LockKeyhole,
  Link2Off,
  Plus,
  ShieldCheck,
  Trash2,
} from "lucide-react";
import type { ResolvedRepo } from "@/lib/nip34";
import type { CICoordinatorSummary } from "@/hooks/useCICoordinators";
import { UserLink } from "@/components/UserAvatar";
import { CICoordinatorLink } from "./CICoordinatorLink";
import { Button } from "@/components/ui/button";
import { Badge } from "@/components/ui/badge";
import {
  Dialog,
  DialogContent,
  DialogDescription,
  DialogFooter,
  DialogHeader,
  DialogTitle,
} from "@/components/ui/dialog";
import { Input } from "@/components/ui/input";
import { Label } from "@/components/ui/label";
import { Textarea } from "@/components/ui/textarea";
import { useToast } from "@/hooks/useToast";
import {
  CI_SECRET_NAME_PATTERN,
  isCISecretsDecryptionBunkerUri,
  isCISecretNameReserved,
} from "@/factories/CIRepositorySecretUpdateFactory";
import { CI_SECRETS_DECRYPTION_BUNKER_NAME } from "@/lib/ci";
import {
  submitCIRepositorySecrets,
  type CIPendingSecretChange,
  type SubmitCIRepositorySecretsResult,
} from "@/services/ci";

interface SecretRow {
  id: number;
  name: string;
  value: string;
}

interface CISecretsDialogProps {
  open: boolean;
  onOpenChange: (open: boolean) => void;
  coordinator: CICoordinatorSummary;
  repo: ResolvedRepo;
  pendingChanges: readonly CIPendingSecretChange[];
  onSubmitted: (
    result: SubmitCIRepositorySecretsResult,
    baselineStatusId: string | undefined,
  ) => void;
}

function parseRemovalNames(value: string): string[] {
  return [
    ...new Set(
      value
        .split(/[\s,]+/)
        .map((name) => name.trim().toUpperCase())
        .filter(Boolean),
    ),
  ];
}

export function CISecretsDialog({
  open,
  onOpenChange,
  coordinator,
  repo,
  pendingChanges,
  onSubmitted,
}: CISecretsDialogProps) {
  const account = useActiveAccount();
  const { toast } = useToast();
  const [nextRowId, setNextRowId] = useState(2);
  const [rows, setRows] = useState<SecretRow[]>([
    { id: 1, name: "", value: "" },
  ]);
  const [removeText, setRemoveText] = useState("");
  const [showValues, setShowValues] = useState(false);
  const [bunkerUri, setBunkerUri] = useState("");
  const [showBunkerUri, setShowBunkerUri] = useState(false);
  const [removeBunker, setRemoveBunker] = useState(false);
  const [submitting, setSubmitting] = useState(false);

  const inventory = coordinator.repositoryStatus?.secrets ?? [];
  const bunkerBinding = inventory.find(
    ({ name }) => name === CI_SECRETS_DECRYPTION_BUNKER_NAME,
  );
  const pendingBunkerChange = pendingChanges.find(
    ({ name }) => name === CI_SECRETS_DECRYPTION_BUNKER_NAME,
  );
  const pendingByName = useMemo(
    () => new Map(pendingChanges.map((change) => [change.name, change])),
    [pendingChanges],
  );
  const secretInventory = inventory.filter(
    ({ name }) => name !== CI_SECRETS_DECRYPTION_BUNKER_NAME,
  );
  const removalNames = useMemo(
    () => parseRemovalNames(removeText),
    [removeText],
  );
  const hasChanges =
    bunkerUri.trim().length > 0 ||
    removeBunker ||
    removalNames.length > 0 ||
    rows.some((row) => row.name.trim().length > 0 || row.value.length > 0);

  const clearSensitiveState = useCallback(() => {
    setRows([{ id: 1, name: "", value: "" }]);
    setNextRowId(2);
    setRemoveText("");
    setShowValues(false);
    setBunkerUri("");
    setShowBunkerUri(false);
    setRemoveBunker(false);
  }, []);

  const handleOpenChange = useCallback(
    (nextOpen: boolean) => {
      if (!nextOpen && !submitting) clearSensitiveState();
      onOpenChange(nextOpen);
    },
    [clearSensitiveState, onOpenChange, submitting],
  );

  const updateRow = useCallback(
    (id: number, patch: Partial<Pick<SecretRow, "name" | "value">>) => {
      setRows((current) =>
        current.map((row) => (row.id === id ? { ...row, ...patch } : row)),
      );
    },
    [],
  );

  const addRow = useCallback(() => {
    setRows((current) => [...current, { id: nextRowId, name: "", value: "" }]);
    setNextRowId((id) => id + 1);
  }, [nextRowId]);

  const queueRemoval = useCallback((name: string) => {
    setRemoveText((current) => {
      const names = parseRemovalNames(current);
      return names.includes(name) ? current : [...names, name].join("\n");
    });
  }, []);

  const submit = useCallback(async () => {
    if (!account) return;

    const set: Record<string, string> = {};
    const trimmedBunkerUri = bunkerUri.trim();
    if (trimmedBunkerUri) {
      if (!isCISecretsDecryptionBunkerUri(trimmedBunkerUri)) {
        toast({
          title: "Check the decryption bunker URI",
          description:
            "Use a valid bunker:// URI containing a remote signer public key and at least one ws:// or wss:// relay.",
          variant: "destructive",
        });
        return;
      }
      set[CI_SECRETS_DECRYPTION_BUNKER_NAME] = trimmedBunkerUri;
    }

    for (const row of rows) {
      const name = row.name.trim().toUpperCase();
      const hasAnyValue = name.length > 0 || row.value.length > 0;
      if (!hasAnyValue) continue;
      if (!CI_SECRET_NAME_PATTERN.test(name)) {
        toast({
          title: "Check the secret names",
          description:
            "Names must start with a letter or underscore and use only A–Z, 0–9, and underscores.",
          variant: "destructive",
        });
        return;
      }
      if (isCISecretNameReserved(name)) {
        toast({
          title: `${name} is reserved`,
          description:
            name === CI_SECRETS_DECRYPTION_BUNKER_NAME
              ? "Use the decryption bunker control above to change this binding."
              : "CI runtime and GitHub Actions environment names cannot be replaced by repository secrets.",
          variant: "destructive",
        });
        return;
      }
      if (!row.value) {
        toast({
          title: `${name} needs a value`,
          description: "Use the remove field to delete an existing secret.",
          variant: "destructive",
        });
        return;
      }
      if (set[name] !== undefined) {
        toast({
          title: `Duplicate secret: ${name}`,
          description: "Each name can appear only once in an update.",
          variant: "destructive",
        });
        return;
      }
      set[name] = row.value;
    }

    if (removalNames.includes(CI_SECRETS_DECRYPTION_BUNKER_NAME)) {
      toast({
        title: "Use the decryption bunker control",
        description:
          "Remove the bunker binding from its protected control rather than the general secret-name field.",
        variant: "destructive",
      });
      return;
    }
    const effectiveRemovals = removeBunker
      ? [...removalNames, CI_SECRETS_DECRYPTION_BUNKER_NAME]
      : removalNames;
    const overlap = effectiveRemovals.find((name) => set[name] !== undefined);
    if (overlap) {
      toast({
        title: `${overlap} is both set and removed`,
        description: "Choose one operation for each secret name.",
        variant: "destructive",
      });
      return;
    }
    const invalidRemoval = effectiveRemovals.find(
      (name) =>
        !CI_SECRET_NAME_PATTERN.test(name) ||
        (isCISecretNameReserved(name) &&
          name !== CI_SECRETS_DECRYPTION_BUNKER_NAME),
    );
    if (invalidRemoval) {
      toast({
        title: `Cannot remove ${invalidRemoval}`,
        description:
          "Removal names must use the secret naming rules and cannot claim a reserved CI runtime variable.",
        variant: "destructive",
      });
      return;
    }

    setSubmitting(true);
    try {
      const baselineStatusId = coordinator.repositoryStatus?.event.id;
      const result = await submitCIRepositorySecrets({
        signer: account.signer,
        author: account.pubkey,
        repositoryCoordinate: `30617:${account.pubkey}:${repo.dTag}`,
        repositoryRelayHint: repo.relays[0],
        advertisement: coordinator.advertisement,
        set,
        remove: effectiveRemovals,
      });
      onSubmitted(result, baselineStatusId);
      clearSensitiveState();
      onOpenChange(false);
      toast({
        title: "Secret update delivered; confirmation pending",
        description: `${result.acceptedRelays.length} of ${result.attemptedRelays.length} inbox relays accepted it. Waiting for the coordinator to report the change in repository status.`,
      });
    } catch (error) {
      toast({
        title: "Secret update was not delivered",
        description:
          error instanceof Error
            ? error.message
            : "An unexpected error occurred.",
        variant: "destructive",
      });
    } finally {
      setSubmitting(false);
    }
  }, [
    account,
    clearSensitiveState,
    coordinator.advertisement,
    coordinator.repositoryStatus?.event.id,
    onOpenChange,
    onSubmitted,
    bunkerUri,
    removeBunker,
    removalNames,
    repo.dTag,
    repo.relays,
    rows,
    toast,
  ]);

  return (
    <Dialog open={open} onOpenChange={handleOpenChange}>
      <DialogContent className="max-h-[92vh] max-w-2xl overflow-y-auto p-0">
        <DialogHeader className="border-b border-border/60 px-5 py-4 sm:px-6">
          <DialogTitle className="flex items-center gap-2 text-lg">
            <LockKeyhole className="h-5 w-5 text-pink-500" />
            Repository secrets
          </DialogTitle>
          <DialogDescription className="text-left">
            Send one atomic, end-to-end encrypted update to
            <span className="mx-1 inline-flex align-middle">
              <CICoordinatorLink
                pubkey={coordinator.pubkey}
                avatarSize="xs"
                variant="inline"
              />
            </span>
            using its current one-time recipient.
          </DialogDescription>
        </DialogHeader>

        <div className="space-y-6 px-5 py-5 sm:px-6">
          <div className="flex gap-3 rounded-lg border border-pink-500/20 bg-pink-500/5 p-3 text-sm">
            <KeyRound className="mt-0.5 h-4 w-4 shrink-0 text-pink-500" />
            <p className="text-muted-foreground">
              Names and values are encrypted before signing and sent only to the
              coordinator&rsquo;s advertised inboxes. The temporary encryption
              key is discarded immediately. A relay acknowledgement confirms
              delivery only; repository status reports coordinator storage.
            </p>
          </div>

          {pendingChanges.length > 0 && (
            <section
              className="rounded-lg border border-amber-500/30 bg-amber-500/10 p-3"
              aria-live="polite"
            >
              <div className="flex items-start gap-2.5">
                <Clock3 className="mt-0.5 h-4 w-4 shrink-0 text-amber-600 dark:text-amber-300" />
                <div className="min-w-0 flex-1">
                  <h3 className="text-sm font-medium text-amber-900 dark:text-amber-100">
                    Awaiting coordinator confirmation
                  </h3>
                  <p className="mt-1 text-xs leading-relaxed text-amber-800 dark:text-amber-200">
                    These changes reached an inbox relay but remain pending
                    until a newer coordinator repository status reports them.
                  </p>
                  <ul className="mt-2 flex flex-wrap gap-1.5">
                    {pendingChanges.map((change) => (
                      <li key={`${change.eventId}:${change.name}`}>
                        <Badge
                          variant="outline"
                          className="border-amber-500/30 bg-background/60 font-mono text-[9px] font-normal text-amber-800 dark:text-amber-200"
                        >
                          {change.operation === "set" ? "Set" : "Remove"}{" "}
                          {change.name === CI_SECRETS_DECRYPTION_BUNKER_NAME
                            ? "decryption bunker"
                            : change.name}
                        </Badge>
                      </li>
                    ))}
                  </ul>
                </div>
              </div>
            </section>
          )}

          <section className="overflow-hidden rounded-xl border border-violet-500/25 bg-gradient-to-br from-violet-500/10 via-background to-pink-500/5">
            <div className="space-y-4 p-4 sm:p-5">
              <div className="flex items-start gap-3">
                <div className="rounded-lg border border-violet-500/20 bg-violet-500/10 p-2 text-violet-600 dark:text-violet-300">
                  <ShieldCheck className="h-4 w-4" />
                </div>
                <div className="min-w-0 flex-1">
                  <div className="flex flex-wrap items-center gap-2">
                    <h3 className="text-sm font-medium">At-rest sealing</h3>
                    <Badge
                      variant="outline"
                      className={
                        pendingBunkerChange
                          ? "border-amber-500/30 bg-amber-500/10 text-[10px] text-amber-800 dark:text-amber-200"
                          : bunkerBinding
                            ? "border-violet-500/30 bg-violet-500/10 text-[10px] text-violet-700 dark:text-violet-300"
                            : "bg-background/60 text-[10px] font-normal text-muted-foreground"
                      }
                    >
                      {pendingBunkerChange
                        ? pendingBunkerChange.operation === "set"
                          ? "Bunker update pending"
                          : "Bunker removal pending"
                        : bunkerBinding
                          ? "Binding reported by coordinator"
                          : "No maintainer bunker reported"}
                    </Badge>
                  </div>
                  <p className="mt-1 text-xs leading-relaxed text-muted-foreground">
                    Supply a NIP-46 bunker so the coordinator can choose to
                    store your secret values sealed against it. When it does,
                    authorized runs ask your bunker to unlock them once per
                    workflow, immediately before execution.
                  </p>
                </div>
              </div>

              {bunkerBinding && (
                <div className="flex flex-wrap items-center gap-x-1.5 text-[10px] text-muted-foreground">
                  <LockKeyhole className="h-3 w-3 text-violet-500" />
                  <span>Binding supplied by</span>
                  {bunkerBinding.sourcePubkey ? (
                    <UserLink
                      pubkey={bunkerBinding.sourcePubkey}
                      avatarSize="xs"
                      variant="inline"
                      nameClassName="max-w-28 truncate text-[10px]"
                    />
                  ) : (
                    <span>the coordinator operator</span>
                  )}
                  {bunkerBinding.createdAt && (
                    <span>
                      {formatDistanceToNow(
                        new Date(bunkerBinding.createdAt * 1000),
                        { addSuffix: true },
                      )}
                    </span>
                  )}
                </div>
              )}

              {removeBunker ? (
                <div className="space-y-3 rounded-lg border border-amber-500/30 bg-amber-500/10 p-3">
                  <p className="text-xs leading-relaxed text-amber-800 dark:text-amber-200">
                    This update will remove the bunker binding. Existing sealed
                    values may be unavailable until you bind a bunker again and
                    resubmit them.
                  </p>
                  <Button
                    type="button"
                    variant="outline"
                    size="sm"
                    onClick={() => setRemoveBunker(false)}
                    disabled={submitting}
                  >
                    Keep bunker binding
                  </Button>
                </div>
              ) : (
                <div className="space-y-2">
                  <Label htmlFor="ci-secrets-bunker-uri">
                    {bunkerBinding
                      ? "Replace decryption bunker"
                      : "Decryption bunker URI"}
                  </Label>
                  <div className="flex gap-2">
                    <Input
                      id="ci-secrets-bunker-uri"
                      type={showBunkerUri ? "text" : "password"}
                      value={bunkerUri}
                      onChange={(event) => setBunkerUri(event.target.value)}
                      placeholder="bunker://<remote-pubkey>?relay=wss%3A%2F%2F…"
                      autoCapitalize="none"
                      autoComplete="new-password"
                      spellCheck={false}
                      disabled={submitting}
                      className="min-w-0 font-mono text-xs"
                      aria-describedby="ci-secrets-bunker-help"
                    />
                    <Button
                      type="button"
                      variant="outline"
                      size="icon"
                      className="h-10 w-10 shrink-0"
                      aria-label={
                        showBunkerUri ? "Hide bunker URI" : "Show bunker URI"
                      }
                      onClick={() => setShowBunkerUri((visible) => !visible)}
                      disabled={submitting}
                    >
                      {showBunkerUri ? (
                        <EyeOff className="h-4 w-4" />
                      ) : (
                        <Eye className="h-4 w-4" />
                      )}
                    </Button>
                  </div>
                  <p
                    id="ci-secrets-bunker-help"
                    className="text-[11px] leading-relaxed text-muted-foreground"
                  >
                    The URI contains connection credentials. It is encrypted in
                    transit and is never injected into a workflow. Replacing a
                    bunker may require resubmitting values sealed to the old
                    one.
                  </p>
                  {bunkerBinding && (
                    <Button
                      type="button"
                      variant="ghost"
                      size="sm"
                      className="h-8 gap-1.5 px-2 text-xs text-muted-foreground hover:text-destructive"
                      onClick={() => {
                        setBunkerUri("");
                        setShowBunkerUri(false);
                        setRemoveBunker(true);
                      }}
                      disabled={submitting}
                    >
                      <Link2Off className="h-3.5 w-3.5" />
                      Remove bunker binding
                    </Button>
                  )}
                </div>
              )}
            </div>
          </section>

          {secretInventory.length > 0 && (
            <section className="space-y-2">
              <div>
                <h3 className="text-sm font-medium">Effective inventory</h3>
                <p className="text-xs text-muted-foreground">
                  The coordinator publishes names and provenance, never values.
                </p>
              </div>
              <div className="divide-y divide-border/60 overflow-hidden rounded-lg border">
                {secretInventory.map((secret) => (
                  <div
                    key={`${secret.name}:${secret.sourcePubkey ?? "operator"}`}
                    className="flex min-w-0 items-center gap-2 px-3 py-2"
                  >
                    <div className="min-w-0 flex-1">
                      <code className="block truncate text-xs font-medium">
                        {secret.name}
                      </code>
                      <div className="mt-0.5 flex min-w-0 flex-wrap items-center gap-x-1.5 text-[10px] text-muted-foreground">
                        {pendingByName.has(secret.name) && (
                          <Badge
                            variant="outline"
                            className="h-4 border-amber-500/30 bg-amber-500/10 px-1.5 text-[9px] font-normal text-amber-800 dark:text-amber-200"
                          >
                            {pendingByName.get(secret.name)?.operation === "set"
                              ? "Update pending"
                              : "Removal pending"}
                          </Badge>
                        )}
                        {secret.sealed && (
                          <Badge
                            variant="outline"
                            className="h-4 gap-1 border-violet-500/30 bg-violet-500/10 px-1.5 text-[9px] font-normal text-violet-700 dark:text-violet-300"
                          >
                            <LockKeyhole className="h-2.5 w-2.5" />
                            Bunker-sealed
                          </Badge>
                        )}
                        {secret.sourcePubkey ? (
                          <>
                            <span>from</span>
                            <UserLink
                              pubkey={secret.sourcePubkey}
                              avatarSize="xs"
                              variant="inline"
                              nameClassName="max-w-28 truncate text-[10px]"
                            />
                            {secret.createdAt && (
                              <span>
                                {formatDistanceToNow(
                                  new Date(secret.createdAt * 1000),
                                  { addSuffix: true },
                                )}
                              </span>
                            )}
                          </>
                        ) : (
                          <span>Operator-provisioned override</span>
                        )}
                      </div>
                    </div>
                    <Button
                      type="button"
                      variant="ghost"
                      size="sm"
                      className="h-7 px-2 text-xs text-muted-foreground"
                      onClick={() => queueRemoval(secret.name)}
                      disabled={submitting}
                    >
                      Remove
                    </Button>
                  </div>
                ))}
              </div>
            </section>
          )}

          <section className="space-y-3">
            <div className="flex items-center justify-between gap-3">
              <div>
                <h3 className="text-sm font-medium">Set or replace</h3>
                <p className="text-xs text-muted-foreground">
                  Values are never shown again after delivery.
                </p>
              </div>
              <Button
                type="button"
                variant="ghost"
                size="sm"
                className="h-8 gap-1.5 text-xs"
                onClick={() => setShowValues((visible) => !visible)}
                disabled={submitting}
              >
                {showValues ? (
                  <EyeOff className="h-3.5 w-3.5" />
                ) : (
                  <Eye className="h-3.5 w-3.5" />
                )}
                {showValues ? "Hide values" : "Show values"}
              </Button>
            </div>

            <div className="space-y-2">
              {rows.map((row, index) => (
                <div
                  key={row.id}
                  className="grid gap-2 rounded-lg border border-border/60 p-3 sm:grid-cols-[minmax(0,0.8fr)_minmax(0,1.2fr)_auto] sm:items-end"
                >
                  <div className="space-y-1.5">
                    <Label htmlFor={`ci-secret-name-${row.id}`}>
                      Name {rows.length > 1 ? index + 1 : ""}
                    </Label>
                    <Input
                      id={`ci-secret-name-${row.id}`}
                      value={row.name}
                      onChange={(event) =>
                        updateRow(row.id, {
                          name: event.target.value.toUpperCase(),
                        })
                      }
                      placeholder="DEPLOY_TOKEN"
                      autoCapitalize="characters"
                      autoComplete="off"
                      spellCheck={false}
                      disabled={submitting}
                      className="font-mono"
                    />
                  </div>
                  <div className="space-y-1.5">
                    <Label htmlFor={`ci-secret-value-${row.id}`}>Value</Label>
                    <Input
                      id={`ci-secret-value-${row.id}`}
                      type={showValues ? "text" : "password"}
                      value={row.value}
                      onChange={(event) =>
                        updateRow(row.id, { value: event.target.value })
                      }
                      placeholder="Secret value"
                      autoComplete="new-password"
                      spellCheck={false}
                      disabled={submitting}
                    />
                  </div>
                  <Button
                    type="button"
                    variant="ghost"
                    size="icon"
                    className="h-10 w-10 justify-self-end text-muted-foreground hover:text-destructive sm:justify-self-auto"
                    aria-label={`Remove secret row ${index + 1}`}
                    onClick={() =>
                      setRows((current) =>
                        current.length === 1
                          ? [{ ...current[0], name: "", value: "" }]
                          : current.filter((item) => item.id !== row.id),
                      )
                    }
                    disabled={submitting}
                  >
                    <Trash2 className="h-4 w-4" />
                  </Button>
                </div>
              ))}
            </div>
            <Button
              type="button"
              variant="outline"
              size="sm"
              className="gap-1.5"
              onClick={addRow}
              disabled={submitting || rows.length >= 100}
            >
              <Plus className="h-3.5 w-3.5" />
              Add secret
            </Button>
          </section>

          <section className="space-y-2">
            <div>
              <Label htmlFor="ci-secret-removals">Remove secret names</Label>
              <p className="mt-1 text-xs text-muted-foreground">
                One per line. Removals are ordered tombstones, so an older
                update cannot restore the value.
              </p>
            </div>
            <Textarea
              id="ci-secret-removals"
              value={removeText}
              onChange={(event) =>
                setRemoveText(event.target.value.toUpperCase())
              }
              placeholder={"OLD_DEPLOY_TOKEN\nLEGACY_API_KEY"}
              className="min-h-20 font-mono"
              autoCapitalize="characters"
              autoComplete="off"
              spellCheck={false}
              disabled={submitting}
            />
          </section>
        </div>

        <DialogFooter className="border-t border-border/60 bg-muted/20 px-5 py-4 sm:px-6">
          <Button
            type="button"
            variant="outline"
            onClick={() => handleOpenChange(false)}
            disabled={submitting}
          >
            Cancel
          </Button>
          <Button
            type="button"
            className="gap-2"
            onClick={() => void submit()}
            disabled={submitting || !account || !hasChanges}
          >
            {submitting ? (
              <Loader2 className="h-4 w-4 animate-spin" />
            ) : (
              <LockKeyhole className="h-4 w-4" />
            )}
            Send encrypted update
          </Button>
        </DialogFooter>
      </DialogContent>
    </Dialog>
  );
}
