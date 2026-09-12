import { ManualRetryAction } from "@/components/ErrorRetryAction";
import { useEffect, useId, useState } from "react";
import type { CastRefEventStore } from "applesauce-common/casts/cast";
import { useActiveAccount } from "applesauce-react/hooks";
import { KeyRound, Loader2 } from "lucide-react";
import { SoftwareApplication } from "@/casts/Software";
import { UserLink } from "@/components/UserAvatar";
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
import { Button } from "@/components/ui/button";
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
import { SoftwareApplicationFactory } from "@/factories/SoftwareApplicationFactory";
import { useEventStore } from "@/hooks/useEventStore";
import type { SoftwarePublisherPreflight } from "@/hooks/useSoftwarePublisherPreflight";
import { useToast } from "@/hooks/useToast";
import { publish } from "@/services/nostr";

interface CreateSoftwareApplicationDialogProps {
  open: boolean;
  onOpenChange: (open: boolean) => void;
  existingApplications: SoftwareApplication[];
  repoCoordinates: string[];
  maintainerPubkeys: string[];
  relayHint?: string;
  application?: SoftwareApplication;
  publisherPreflight?: SoftwarePublisherPreflight;
  onPublished?: (application: SoftwareApplication) => void;
}

function commaSeparatedValues(value: string): string[] {
  return value
    .split(",")
    .map((item) => item.trim())
    .filter(Boolean);
}

function lineSeparatedValues(value: string): string[] {
  return value
    .split(/\r?\n/)
    .map((item) => item.trim())
    .filter(Boolean);
}

function isHttpUrl(value: string): boolean {
  try {
    const url = new URL(value);
    return url.protocol === "https:" || url.protocol === "http:";
  } catch {
    return false;
  }
}

export function CreateSoftwareApplicationDialog({
  open,
  onOpenChange,
  existingApplications,
  repoCoordinates,
  maintainerPubkeys,
  relayHint,
  application,
  publisherPreflight,
  onPublished,
}: CreateSoftwareApplicationDialogProps) {
  const account = useActiveAccount();
  const store = useEventStore();
  const { toast } = useToast();
  const fieldPrefix = useId();
  const [appId, setAppId] = useState("");
  const [name, setName] = useState("");
  const [summary, setSummary] = useState("");
  const [description, setDescription] = useState("");
  const [icon, setIcon] = useState("");
  const [images, setImages] = useState("");
  const [website, setWebsite] = useState("");
  const [repository, setRepository] = useState("");
  const [license, setLicense] = useState("");
  const [topics, setTopics] = useState("");
  const [platforms, setPlatforms] = useState("");
  const [publishing, setPublishing] = useState(false);
  const [confirmPublisher, setConfirmPublisher] = useState(false);
  const [error, setError] = useState<string>();
  const editing = !!application;

  useEffect(() => {
    if (!open) return;
    setAppId(application?.appId ?? "");
    setName(application?.name ?? "");
    setSummary(application?.summary ?? "");
    setDescription(application?.description ?? "");
    setIcon(application?.icon ?? "");
    setImages(application?.images.join("\n") ?? "");
    setWebsite(application?.website ?? "");
    setRepository(application?.repository ?? "");
    setLicense(application?.license ?? "");
    setTopics(application?.topics.join(", ") ?? "");
    setPlatforms(application?.platforms.join(", ") ?? "");
    setPublishing(false);
    setConfirmPublisher(false);
    setError(undefined);
  }, [
    application?.appId,
    application?.description,
    application?.event.id,
    application?.icon,
    application?.images,
    application?.license,
    application?.name,
    application?.platforms,
    application?.repository,
    application?.summary,
    application?.topics,
    application?.website,
    open,
  ]);

  const validate = (): string | undefined => {
    if (!account) return "Log in with a repository maintainer account.";
    if (!maintainerPubkeys.includes(account.pubkey)) {
      return "Select a repository maintainer account to publish this application.";
    }
    if (!appId.trim()) return "Enter an application ID.";
    if (!name.trim()) return "Enter an application name.";
    if (
      account &&
      existingApplications.some(
        (existingApplication) =>
          existingApplication.pubkey === account.pubkey &&
          existingApplication.appId === appId.trim() &&
          existingApplication.coordinate !== application?.coordinate,
      )
    ) {
      return "This account already has an application with that ID.";
    }
    if (icon.trim() && !isHttpUrl(icon.trim())) {
      return "Enter a valid HTTP or HTTPS icon URL.";
    }
    const invalidImage = lineSeparatedValues(images).find(
      (image) => !isHttpUrl(image),
    );
    if (invalidImage) return `Invalid screenshot URL: ${invalidImage}`;
    if (website.trim() && !isHttpUrl(website.trim())) {
      return "Enter a valid HTTP or HTTPS website URL.";
    }
    return undefined;
  };

  const handleSubmit = async () => {
    const validationError = validate();
    if (validationError) {
      setError(validationError);
      return;
    }
    if (!account) return;
    if (application && application.pubkey !== account.pubkey) {
      setError("Only the application publisher can edit it.");
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
        appId.trim(),
        application?.event.id ?? null,
        async ({ event }) => {
          const signedApplication = await SoftwareApplicationFactory.create({
            appId,
            name,
            summary,
            description,
            icon,
            images: lineSeparatedValues(images),
            website,
            repository,
            license,
            topics: commaSeparatedValues(topics),
            platforms: commaSeparatedValues(platforms),
            repoCoordinates,
            relayHint,
            createdAt: Math.floor(Date.now() / 1000),
            baseEvent: event,
          }).sign(account.signer);
          await publish(signedApplication, repoCoordinates);
          onPublished?.(
            new SoftwareApplication(
              signedApplication,
              store as unknown as CastRefEventStore,
            ),
          );
        },
      );
      toast({
        title: editing ? "Application updated" : "Application published",
        description: editing
          ? `${name.trim()} has been updated.`
          : `${name.trim()} can now receive software releases.`,
      });
      onOpenChange(false);
    } catch (caught) {
      setError(
        caught instanceof Error
          ? caught.message
          : "Failed to publish application",
      );
      setPublishing(false);
    }
  };

  const handleSubmitRequest = () => {
    const validationError = validate();
    if (validationError) {
      setError(validationError);
      return;
    }
    if (editing) {
      void handleSubmit();
    } else {
      setConfirmPublisher(true);
    }
  };

  const fieldId = (name: string) => `${fieldPrefix}-${name}`;

  return (
    <Dialog
      open={open}
      onOpenChange={(nextOpen) => {
        if (!publishing && !confirmPublisher) onOpenChange(nextOpen);
      }}
    >
      <DialogContent className="max-h-[92vh] max-w-2xl overflow-y-auto">
        <DialogHeader>
          <DialogTitle>
            {editing
              ? "Edit software application"
              : "Add a software application"}
          </DialogTitle>
          <DialogDescription>
            {editing
              ? "Update the shared metadata used across this application's releases."
              : "Applications hold the shared name, description, artwork, and platform metadata for their releases."}
          </DialogDescription>
        </DialogHeader>

        {account && (
          <div className="flex items-start gap-3 rounded-xl border border-amber-500/30 bg-amber-500/10 p-4">
            <KeyRound className="mt-0.5 h-4 w-4 shrink-0 text-amber-700 dark:text-amber-300" />
            <div className="min-w-0 text-sm">
              <p className="font-medium">Application publisher</p>
              <div className="mt-1">
                <UserLink
                  pubkey={application?.pubkey ?? account.pubkey}
                  noLink
                />
              </div>
              <p className="mt-2 text-muted-foreground">
                Only this pubkey can edit the application or publish its
                releases and software assets. Repository maintainers do not
                share that authority.
              </p>
            </div>
          </div>
        )}

        <div className="grid gap-4 py-2 sm:grid-cols-2">
          <div className="space-y-2">
            <Label htmlFor={fieldId("name")}>
              Name{" "}
              <span className="text-destructive" aria-hidden="true">
                *
              </span>
            </Label>
            <Input
              id={fieldId("name")}
              value={name}
              onChange={(event) => setName(event.target.value)}
              placeholder="GitWorkshop"
              disabled={publishing}
              autoFocus
              required
            />
          </div>
          <div className="space-y-2">
            <Label htmlFor={fieldId("app-id")}>
              Application ID{" "}
              <span className="text-destructive" aria-hidden="true">
                *
              </span>
            </Label>
            <Input
              id={fieldId("app-id")}
              value={appId}
              onChange={(event) => setAppId(event.target.value)}
              placeholder="dev.gitworkshop.app"
              disabled={publishing || editing}
              required
            />
          </div>
          <div className="space-y-2 sm:col-span-2">
            <Label htmlFor={fieldId("summary")}>Summary</Label>
            <Input
              id={fieldId("summary")}
              value={summary}
              onChange={(event) => setSummary(event.target.value)}
              placeholder="A short, plain-text description"
              disabled={publishing}
            />
          </div>
          <div className="space-y-2 sm:col-span-2">
            <Label htmlFor={fieldId("description")}>Description</Label>
            <Textarea
              id={fieldId("description")}
              value={description}
              onChange={(event) => setDescription(event.target.value)}
              placeholder="Full description in Markdown"
              className="min-h-32"
              disabled={publishing}
            />
          </div>
          <div className="space-y-2">
            <Label htmlFor={fieldId("icon")}>Icon URL</Label>
            <Input
              id={fieldId("icon")}
              type="url"
              value={icon}
              onChange={(event) => setIcon(event.target.value)}
              placeholder="https://…"
              disabled={publishing}
            />
          </div>
          <div className="space-y-2">
            <Label htmlFor={fieldId("website")}>Website</Label>
            <Input
              id={fieldId("website")}
              type="url"
              value={website}
              onChange={(event) => setWebsite(event.target.value)}
              placeholder="https://…"
              disabled={publishing}
            />
          </div>
          <div className="space-y-2">
            <Label htmlFor={fieldId("repository")}>Source repository</Label>
            <Input
              id={fieldId("repository")}
              value={repository}
              onChange={(event) => setRepository(event.target.value)}
              placeholder="https://… or git clone URL"
              disabled={publishing}
            />
          </div>
          <div className="space-y-2">
            <Label htmlFor={fieldId("license")}>SPDX license</Label>
            <Input
              id={fieldId("license")}
              value={license}
              onChange={(event) => setLicense(event.target.value)}
              placeholder="MIT"
              disabled={publishing}
            />
          </div>
          <div className="space-y-2">
            <Label htmlFor={fieldId("topics")}>Topics</Label>
            <Input
              id={fieldId("topics")}
              value={topics}
              onChange={(event) => setTopics(event.target.value)}
              placeholder="nostr, developer-tools"
              disabled={publishing}
            />
          </div>
          <div className="space-y-2">
            <Label htmlFor={fieldId("platforms")}>Platforms</Label>
            <Input
              id={fieldId("platforms")}
              value={platforms}
              onChange={(event) => setPlatforms(event.target.value)}
              placeholder="linux-x86_64, darwin-arm64"
              disabled={publishing}
            />
          </div>
          <div className="space-y-2 sm:col-span-2">
            <Label htmlFor={fieldId("images")}>Screenshot URLs</Label>
            <Textarea
              id={fieldId("images")}
              value={images}
              onChange={(event) => setImages(event.target.value)}
              placeholder={
                "https://…/screenshot-1.png\nhttps://…/screenshot-2.png"
              }
              disabled={publishing}
            />
            <p className="text-xs text-muted-foreground">One URL per line.</p>
          </div>
        </div>

        {error && (
          <div className="space-y-2">
            <p role="alert" className="text-sm text-destructive">
              {error}
            </p>
            <ManualRetryAction
              onRetry={handleSubmitRequest}
              busy={publishing}
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
            onClick={handleSubmitRequest}
            disabled={publishing}
          >
            {publishing && <Loader2 className="mr-2 h-4 w-4 animate-spin" />}
            {editing ? "Save changes" : "Publish application"}
          </Button>
        </DialogFooter>

        <AlertDialog
          open={confirmPublisher}
          onOpenChange={(nextOpen) => {
            if (!publishing) setConfirmPublisher(nextOpen);
          }}
        >
          <AlertDialogContent>
            <AlertDialogHeader>
              <AlertDialogTitle>Publish with this account?</AlertDialogTitle>
              <AlertDialogDescription asChild>
                <div className="space-y-3">
                  <UserLink pubkey={account?.pubkey ?? ""} noLink />
                  <p>
                    This pubkey alone will control the application and publish
                    its releases and software assets. Other repository
                    maintainers will not be able to do so.
                  </p>
                </div>
              </AlertDialogDescription>
            </AlertDialogHeader>
            <AlertDialogFooter>
              <AlertDialogCancel disabled={publishing}>
                Go back
              </AlertDialogCancel>
              <AlertDialogAction
                disabled={publishing || !account}
                onClick={() => void handleSubmit()}
              >
                Publish application
              </AlertDialogAction>
            </AlertDialogFooter>
          </AlertDialogContent>
        </AlertDialog>
      </DialogContent>
    </Dialog>
  );
}
