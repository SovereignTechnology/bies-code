import { ManualRetryAction } from "@/components/ErrorRetryAction";
import { useEffect, useState } from "react";
import { useActiveAccount } from "applesauce-react/hooks";
import { Link2, Loader2, Package } from "lucide-react";
import { nip19 } from "nostr-tools";
import type { SoftwareApplication } from "@/casts/Software";
import { RepoBadge } from "@/components/RepoBadge";
import {
  AlertDialog,
  AlertDialogAction,
  AlertDialogCancel,
  AlertDialogContent,
  AlertDialogDescription,
  AlertDialogFooter,
  AlertDialogHeader,
  AlertDialogTitle,
} from "@/components/ui/alert-dialog";
import { Badge } from "@/components/ui/badge";
import { Button } from "@/components/ui/button";
import {
  Dialog,
  DialogContent,
  DialogDescription,
  DialogFooter,
  DialogHeader,
  DialogTitle,
} from "@/components/ui/dialog";
import { Label } from "@/components/ui/label";
import { RadioGroup, RadioGroupItem } from "@/components/ui/radio-group";
import { Skeleton } from "@/components/ui/skeleton";
import { SoftwareApplicationFactory } from "@/factories/SoftwareApplicationFactory";
import type { SoftwarePublisherPreflight } from "@/hooks/useSoftwarePublisherPreflight";
import { useToast } from "@/hooks/useToast";
import { parseRepoCoordinate, REPO_KIND } from "@/lib/nip34";
import { parseUpstreamInput } from "@/lib/repoUpstreamInput";
import { repoToPath } from "@/lib/routeUtils";
import { cn } from "@/lib/utils";
import { publish } from "@/services/nostr";

interface LinkSoftwareApplicationDialogProps {
  open: boolean;
  onOpenChange: (open: boolean) => void;
  applications: SoftwareApplication[];
  settled: boolean;
  repoCoordinates: string[];
  relayHint?: string;
  publisherPreflight?: SoftwarePublisherPreflight;
  onLinked?: (application: SoftwareApplication) => void;
}

function applicationLinksRepository(
  application: SoftwareApplication,
  repoCoordinates: string[],
): boolean {
  const coordinates = new Set(repoCoordinates);
  return application.repoCoords.some((coordinate) =>
    coordinates.has(coordinate),
  );
}

function compactSource(source: string): string {
  try {
    const url = new URL(source);
    return `${url.host}${url.pathname.replace(/\/$/, "")}`;
  } catch {
    return source;
  }
}

export function LinkSoftwareApplicationDialog({
  open,
  onOpenChange,
  applications,
  settled,
  repoCoordinates,
  relayHint,
  publisherPreflight,
  onLinked,
}: LinkSoftwareApplicationDialogProps) {
  const account = useActiveAccount();
  const { toast } = useToast();
  const [selectedCoordinate, setSelectedCoordinate] = useState("");
  const [showSourceChoice, setShowSourceChoice] = useState(false);
  const [publishing, setPublishing] = useState(false);
  const [error, setError] = useState<string>();
  const selectedApplication = applications.find(
    (application) => application.coordinate === selectedCoordinate,
  );
  const repository = repoCoordinates
    .map((coordinate) => parseRepoCoordinate(coordinate))
    .find((candidate) => !!candidate);
  const repositoryNaddr = repository
    ? nip19.naddrEncode({
        kind: REPO_KIND,
        pubkey: repository.pubkey,
        identifier: repository.identifier,
        relays: relayHint ? [relayHint] : undefined,
      })
    : undefined;
  const selectedSourceCoordinate = selectedApplication?.repository
    ? parseUpstreamInput(selectedApplication.repository).upstream.repository
    : undefined;
  const sourceAlreadyMatches = !!(
    selectedSourceCoordinate &&
    repoCoordinates.includes(selectedSourceCoordinate)
  );
  const canReplaceSource = !!repositoryNaddr && !sourceAlreadyMatches;

  useEffect(() => {
    if (!open) return;
    setSelectedCoordinate("");
    setShowSourceChoice(false);
    setPublishing(false);
    setError(undefined);
  }, [open]);

  useEffect(() => {
    setShowSourceChoice(false);
  }, [selectedCoordinate]);

  const handleLink = async (replacementRepository?: string) => {
    if (!account || !selectedApplication) return;
    if (selectedApplication.pubkey !== account.pubkey) {
      setError("Only the application publisher can link it.");
      return;
    }
    if (applicationLinksRepository(selectedApplication, repoCoordinates)) {
      setError("This application is already linked to the repository.");
      return;
    }
    if (!publisherPreflight) {
      setError("Software publication checks are not ready yet.");
      return;
    }

    setPublishing(true);
    setError(undefined);
    try {
      await publisherPreflight.executeApplication(
        selectedApplication.appId,
        selectedApplication.event.id,
        async ({ event }) => {
          if (!event) {
            throw new Error(
              "This software application is no longer available to link.",
            );
          }
          const updatedApplication =
            await SoftwareApplicationFactory.linkRepositories(
              event,
              repoCoordinates,
              relayHint,
              Math.floor(Date.now() / 1000),
              replacementRepository,
            ).sign(account.signer);
          await publish(updatedApplication, repoCoordinates);
        },
      );
      toast({
        title: "Application linked",
        description: `${selectedApplication.name} now appears in this repository's releases.`,
      });
      onLinked?.(selectedApplication);
      onOpenChange(false);
    } catch (caught) {
      setError(
        caught instanceof Error ? caught.message : "Failed to link application",
      );
      setPublishing(false);
    }
  };

  const handleLinkRequest = () => {
    if (canReplaceSource) {
      setShowSourceChoice(true);
      return;
    }
    void handleLink();
  };

  return (
    <Dialog
      open={open}
      onOpenChange={(nextOpen) => {
        if (!publishing && !showSourceChoice) onOpenChange(nextOpen);
      }}
    >
      <DialogContent className="max-h-[88vh] min-w-0 max-w-2xl overflow-x-hidden overflow-y-auto">
        <DialogHeader>
          <DialogTitle>All your applications</DialogTitle>
          <DialogDescription>
            Choose an application you already publish to associate it with this
            repository. Existing releases and application metadata are kept
            unless you choose to replace its source link.
          </DialogDescription>
        </DialogHeader>

        {!settled && applications.length === 0 ? (
          <div className="space-y-3 py-2">
            {[0, 1, 2].map((index) => (
              <Skeleton key={index} className="h-20 w-full rounded-xl" />
            ))}
          </div>
        ) : applications.length === 0 ? (
          <div className="rounded-xl border border-dashed px-6 py-10 text-center">
            <Package className="mx-auto h-8 w-8 text-muted-foreground" />
            <p className="mt-3 font-medium">No applications found</p>
            <p className="mx-auto mt-1 max-w-md text-sm text-muted-foreground">
              No software applications published by this account were found on
              its outbox relays or Zapstore.
            </p>
          </div>
        ) : (
          <RadioGroup
            value={selectedCoordinate}
            onValueChange={setSelectedCoordinate}
            className="gap-3 py-2"
            aria-label="Software application"
          >
            {applications.map((application) => {
              const linked = applicationLinksRepository(
                application,
                repoCoordinates,
              );
              const inputId = `link-application-${application.event.id}`;
              const sourceUpstream = application.repository
                ? parseUpstreamInput(application.repository).upstream
                : undefined;
              const sourceCoordinate = sourceUpstream?.repository;
              const sourceRepository = parseRepoCoordinate(sourceCoordinate);
              return (
                <div
                  key={application.coordinate}
                  className={cn(
                    "flex min-w-0 items-start gap-3 rounded-xl border p-4 transition-colors",
                    linked
                      ? "bg-muted/30"
                      : "hover:border-primary/50 hover:bg-muted/20",
                  )}
                >
                  <RadioGroupItem
                    id={inputId}
                    value={application.coordinate}
                    disabled={linked || publishing}
                    className="mt-1 shrink-0"
                  />
                  {application.icon ? (
                    <img
                      src={application.icon}
                      alt=""
                      className="h-11 w-11 shrink-0 rounded-lg border bg-muted object-cover"
                    />
                  ) : (
                    <div className="flex h-11 w-11 shrink-0 items-center justify-center rounded-lg border bg-muted">
                      <Package className="h-5 w-5 text-muted-foreground" />
                    </div>
                  )}
                  <div className="min-w-0 flex-1">
                    <Label
                      htmlFor={inputId}
                      className={cn(
                        "block min-w-0",
                        linked ? "cursor-default" : "cursor-pointer",
                      )}
                    >
                      <span className="flex min-w-0 items-center gap-2">
                        <span className="truncate font-medium">
                          {application.name}
                        </span>
                        {linked && <Badge variant="secondary">Linked</Badge>}
                      </span>
                      <span className="mt-0.5 block truncate font-mono text-xs font-normal text-muted-foreground">
                        {application.appId}
                      </span>
                    </Label>
                    {application.repository && (
                      <div className="mt-1 min-w-0 max-w-full">
                        {sourceRepository && sourceCoordinate ? (
                          <RepoBadge
                            coord={sourceCoordinate}
                            to={repoToPath(
                              sourceRepository.pubkey,
                              sourceRepository.identifier,
                              sourceUpstream?.relayHint
                                ? [sourceUpstream.relayHint]
                                : [],
                            )}
                            className="max-w-full overflow-hidden [&>span]:min-w-0 [&>span]:truncate"
                          />
                        ) : (
                          <span
                            className="block max-w-full truncate text-xs font-normal text-muted-foreground"
                            title={application.repository}
                          >
                            {application.repository}
                          </span>
                        )}
                      </div>
                    )}
                  </div>
                </div>
              );
            })}
          </RadioGroup>
        )}

        {error && (
          <div className="space-y-2">
            <p className="text-sm text-destructive" role="alert">
              {error}
            </p>
            <ManualRetryAction
              onRetry={handleLinkRequest}
              busy={publishing || !selectedApplication}
            />
          </div>
        )}

        <DialogFooter>
          <Button
            type="button"
            variant="outline"
            onClick={() => onOpenChange(false)}
            disabled={publishing}
          >
            Cancel
          </Button>
          <Button
            type="button"
            onClick={handleLinkRequest}
            disabled={!selectedApplication || publishing}
          >
            {publishing ? (
              <Loader2 className="mr-2 h-4 w-4 animate-spin" />
            ) : (
              <Link2 className="mr-2 h-4 w-4" />
            )}
            Link to repository
          </Button>
        </DialogFooter>
      </DialogContent>

      <AlertDialog
        open={showSourceChoice}
        onOpenChange={(nextOpen) => {
          if (!publishing) setShowSourceChoice(nextOpen);
        }}
      >
        <AlertDialogContent className="min-w-0 max-w-xl overflow-hidden">
          <AlertDialogHeader>
            <AlertDialogTitle>
              {selectedApplication?.repository
                ? "Replace application link?"
                : "Link application?"}
            </AlertDialogTitle>
            <AlertDialogDescription className="min-w-0">
              {selectedApplication?.repository ? (
                <>
                  Replace link to “
                  <span
                    className="break-all font-medium text-foreground"
                    title={selectedApplication.repository}
                  >
                    {compactSource(selectedApplication.repository)}
                  </span>
                  ” with this Nostr Git repository?
                </>
              ) : (
                <>Link this application to this Nostr Git repository?</>
              )}
            </AlertDialogDescription>
          </AlertDialogHeader>
          <AlertDialogFooter className="flex-col-reverse gap-2 sm:flex-col-reverse sm:space-x-0">
            <AlertDialogCancel disabled={publishing}>Go back</AlertDialogCancel>
            <AlertDialogAction
              disabled={publishing || !repositoryNaddr}
              className="min-w-0 whitespace-normal"
              onClick={() => void handleLink(repositoryNaddr)}
            >
              {selectedApplication?.repository
                ? "Replace link"
                : "Link repository"}
            </AlertDialogAction>
          </AlertDialogFooter>
        </AlertDialogContent>
      </AlertDialog>
    </Dialog>
  );
}
