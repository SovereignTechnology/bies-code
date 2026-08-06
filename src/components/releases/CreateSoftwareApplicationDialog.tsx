import { useEffect, useId, useState } from "react";
import { useActiveAccount } from "applesauce-react/hooks";
import { Loader2 } from "lucide-react";
import type { SoftwareApplication } from "@/casts/Software";
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
import { useToast } from "@/hooks/useToast";
import { publish } from "@/services/nostr";

interface CreateSoftwareApplicationDialogProps {
  open: boolean;
  onOpenChange: (open: boolean) => void;
  existingApplications: SoftwareApplication[];
  repoCoordinates: string[];
  relayHint?: string;
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
  relayHint,
}: CreateSoftwareApplicationDialogProps) {
  const account = useActiveAccount();
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
  const [error, setError] = useState<string>();

  useEffect(() => {
    if (!open) return;
    setAppId("");
    setName("");
    setSummary("");
    setDescription("");
    setIcon("");
    setImages("");
    setWebsite("");
    setRepository("");
    setLicense("");
    setTopics("");
    setPlatforms("");
    setPublishing(false);
    setError(undefined);
  }, [open]);

  const validate = (): string | undefined => {
    if (!appId.trim()) return "Enter an application ID.";
    if (!name.trim()) return "Enter an application name.";
    if (
      account &&
      existingApplications.some(
        (application) =>
          application.pubkey === account.pubkey &&
          application.appId === appId.trim(),
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

    setPublishing(true);
    setError(undefined);
    try {
      const application = await SoftwareApplicationFactory.create({
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
      }).sign(account.signer);
      await publish(application, repoCoordinates);
      toast({
        title: "Application published",
        description: `${name.trim()} can now receive software releases.`,
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

  const fieldId = (name: string) => `${fieldPrefix}-${name}`;

  return (
    <Dialog
      open={open}
      onOpenChange={(nextOpen) => {
        if (!publishing) onOpenChange(nextOpen);
      }}
    >
      <DialogContent className="max-h-[92vh] max-w-2xl overflow-y-auto">
        <DialogHeader>
          <DialogTitle>Add a software application</DialogTitle>
          <DialogDescription>
            Applications hold the shared name, description, artwork, and
            platform metadata for their releases.
          </DialogDescription>
        </DialogHeader>

        <div className="grid gap-4 py-2 sm:grid-cols-2">
          <div className="space-y-2">
            <Label htmlFor={fieldId("name")}>Name</Label>
            <Input
              id={fieldId("name")}
              value={name}
              onChange={(event) => setName(event.target.value)}
              placeholder="GitWorkshop"
              disabled={publishing}
              autoFocus
            />
          </div>
          <div className="space-y-2">
            <Label htmlFor={fieldId("app-id")}>Application ID</Label>
            <Input
              id={fieldId("app-id")}
              value={appId}
              onChange={(event) => setAppId(event.target.value)}
              placeholder="dev.gitworkshop.app"
              disabled={publishing}
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

        {error && <p className="text-sm text-destructive">{error}</p>}

        <DialogFooter>
          <Button
            type="button"
            variant="outline"
            onClick={() => onOpenChange(false)}
            disabled={publishing}
          >
            Cancel
          </Button>
          <Button type="button" onClick={handleSubmit} disabled={publishing}>
            {publishing && <Loader2 className="mr-2 h-4 w-4 animate-spin" />}
            Publish application
          </Button>
        </DialogFooter>
      </DialogContent>
    </Dialog>
  );
}
