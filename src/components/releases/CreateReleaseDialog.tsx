import {
  useCallback,
  useEffect,
  useId,
  useMemo,
  useRef,
  useState,
  type ChangeEvent,
  type DragEvent,
  type KeyboardEvent,
} from "react";
import { useActiveAccount } from "applesauce-react/hooks";
import type { NostrEvent } from "nostr-tools";
import {
  Check,
  ChevronDown,
  FileArchive,
  Loader2,
  Plus,
  Trash2,
  Upload,
  X,
} from "lucide-react";
import type { SoftwareApplication, SoftwareRelease } from "@/casts/Software";
import { CreateSoftwareApplicationDialog } from "@/components/releases/CreateSoftwareApplicationDialog";
import { Badge } from "@/components/ui/badge";
import { Button } from "@/components/ui/button";
import {
  Collapsible,
  CollapsibleContent,
  CollapsibleTrigger,
} from "@/components/ui/collapsible";
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
import { Progress } from "@/components/ui/progress";
import {
  Select,
  SelectContent,
  SelectItem,
  SelectSeparator,
  SelectTrigger,
  SelectValue,
} from "@/components/ui/select";
import { Textarea } from "@/components/ui/textarea";
import {
  SoftwareAssetFactory,
  SoftwareReleaseFactory,
} from "@/factories/SoftwareReleaseFactory";
import { useBlossomUpload, type Nip94Tags } from "@/hooks/useBlossomUpload";
import { useToast } from "@/hooks/useToast";
import { publish } from "@/services/nostr";

const CHANNEL_SUGGESTIONS = ["main", "beta", "nightly", "dev"];

const MIME_TYPE_SUGGESTIONS = [
  "application/vnd.android.package-archive",
  "application/vnd.apple.ipa",
  "application/x-apple-diskimage",
  "application/vnd.apple.installer+xml",
  "application/x-msi",
  "application/vnd.appimage",
  "application/vnd.flatpak",
  "application/x-executable",
  "application/x-mach-binary",
  "application/vnd.microsoft.portable-executable",
  "application/vnd.debian.binary-package",
  "application/x-rpm",
  "application/zip",
  "application/gzip",
  "application/x-tar",
  "application/octet-stream",
  "application/pgp-signature",
  "application/json",
  "application/wasm",
  "text/plain",
];

const PLATFORM_SUGGESTIONS = [
  "android-arm64-v8a",
  "android-armeabi-v7a",
  "android-x86",
  "android-x86_64",
  "darwin-arm64",
  "darwin-x86_64",
  "linux-aarch64",
  "linux-x86_64",
  "linux-armv7l",
  "linux-riscv64",
  "windows-aarch64",
  "windows-x86_64",
  "ios-arm64",
  "freebsd-x86_64",
  "freebsd-aarch64",
  "wasm32",
  "wasm64",
  "wasi-wasm32",
  "wasi-wasm64",
];

const VARIANT_SUGGESTIONS = [
  "installer",
  "portable",
  "offline",
  "minimal",
  "full",
  "debug",
];

const NIP_SUGGESTIONS = [
  "01",
  "05",
  "07",
  "09",
  "19",
  "22",
  "34",
  "44",
  "46",
  "57",
  "65",
  "82",
  "94",
];

const GIT_COMMIT_ID = /^[0-9a-f]{40}$/i;
const CUSTOM_VERSION_CHOICE = "custom";
const CUSTOM_CHANNEL_CHOICE = "custom";
const CUSTOM_MIME_TYPE_CHOICE = "custom";
const ADD_APPLICATION_CHOICE = "add-application";
const TAG_VERSION_PREFIX = "tag:";

function canonicalReleaseVersion(value: string): string {
  return value.trim().replace(/^[vV](?=\d)/, "");
}

type UploadStatus = "pending" | "queued" | "uploading" | "uploaded" | "error";
type PublishStage =
  | "editing"
  | "signing"
  | "publishing-release"
  | "publishing-assets";

interface UploadedAsset {
  url: string;
  sha256: string;
  size: number;
}

interface GitVersionOption {
  tagName: string;
  version: string;
  commitId: string;
}

interface ReleaseAssetDraft {
  id: string;
  file: File;
  filename: string;
  mimeType: string;
  platforms: string[];
  variant: string;
  commit: string;
  minPlatformVersion: string;
  targetPlatformVersion: string;
  supportedNips: string[];
  minAllowedVersion: string;
  versionCode: string;
  minAllowedVersionCode: string;
  apkCertificateHashes: string[];
  originalWebUrl: string;
  progress: number;
  stalled: boolean;
  status: UploadStatus;
  error?: string;
  uploaded?: UploadedAsset;
}

interface CreateReleaseDialogProps {
  open: boolean;
  onOpenChange: (open: boolean) => void;
  applications: SoftwareApplication[];
  existingReleases: SoftwareRelease[];
  gitTags: Array<{ name: string; commitId: string }>;
  repoCoordinates: string[];
  maintainerPubkeys: string[];
  relayHint?: string;
}

let nextAssetId = 0;

function inferMimeType(file: File): string {
  if (file.type) return file.type;
  const name = file.name.toLowerCase();
  if (name.endsWith(".tar.gz") || name.endsWith(".tgz")) {
    return "application/gzip";
  }
  const extension = name.slice(name.lastIndexOf("."));
  const byExtension: Record<string, string> = {
    ".apk": "application/vnd.android.package-archive",
    ".ipa": "application/vnd.apple.ipa",
    ".dmg": "application/x-apple-diskimage",
    ".pkg": "application/vnd.apple.installer+xml",
    ".msi": "application/x-msi",
    ".appimage": "application/vnd.appimage",
    ".flatpak": "application/vnd.flatpak",
    ".exe": "application/vnd.microsoft.portable-executable",
    ".deb": "application/vnd.debian.binary-package",
    ".rpm": "application/x-rpm",
    ".zip": "application/zip",
    ".gz": "application/gzip",
    ".tar": "application/x-tar",
    ".asc": "application/pgp-signature",
    ".sig": "application/pgp-signature",
    ".wasm": "application/wasm",
    ".json": "application/json",
    ".txt": "text/plain",
  };
  return byExtension[extension] ?? "application/octet-stream";
}

function createAssetDraft(
  file: File,
  defaultCommit?: string,
): ReleaseAssetDraft {
  nextAssetId += 1;
  return {
    id: `release-asset-${nextAssetId}`,
    file,
    filename: file.name,
    mimeType: inferMimeType(file),
    platforms: [],
    variant: "",
    commit: defaultCommit ?? "",
    minPlatformVersion: "",
    targetPlatformVersion: "",
    supportedNips: [],
    minAllowedVersion: "",
    versionCode: "",
    minAllowedVersionCode: "",
    apkCertificateHashes: [],
    originalWebUrl: "",
    progress: 0,
    stalled: false,
    status: "pending",
  };
}

function fileIdentity(file: File): string {
  return `${file.name}:${file.size}:${file.lastModified}`;
}

function formatFileSize(bytes: number): string {
  if (bytes < 1024) return `${bytes} B`;
  const units = ["KB", "MB", "GB", "TB"];
  let value = bytes / 1024;
  let unit = units[0];
  for (let index = 1; index < units.length && value >= 1024; index++) {
    value /= 1024;
    unit = units[index];
  }
  return `${value >= 10 ? value.toFixed(0) : value.toFixed(1)} ${unit}`;
}

function uploadTag(tags: Nip94Tags, name: string): string | undefined {
  return tags.find(([tagName]) => tagName === name)?.[1];
}

function SuggestedTagInput({
  label,
  values,
  onChange,
  suggestions,
  placeholder,
  disabled,
  autoFocus = false,
  recommended = false,
  required = false,
}: {
  label: string;
  values: string[];
  onChange: (values: string[]) => void;
  suggestions: string[];
  placeholder: string;
  disabled: boolean;
  autoFocus?: boolean;
  recommended?: boolean;
  required?: boolean;
}) {
  const [input, setInput] = useState("");
  const listId = useId();
  const inputId = useId();
  const descriptionId = useId();
  const inputRef = useRef<HTMLInputElement>(null);

  useEffect(() => {
    if (autoFocus) inputRef.current?.focus();
  }, [autoFocus]);

  const addValue = () => {
    const value = input.trim();
    if (!value) return;
    if (!values.includes(value)) onChange([...values, value]);
    setInput("");
  };
  const handleKeyDown = (event: KeyboardEvent<HTMLInputElement>) => {
    if (event.key !== "Enter" && event.key !== ",") return;
    event.preventDefault();
    addValue();
  };

  return (
    <div
      onBlur={(event) => {
        if (
          event.relatedTarget instanceof Node &&
          event.currentTarget.contains(event.relatedTarget)
        ) {
          return;
        }
        addValue();
      }}
      className={
        recommended
          ? "space-y-2 rounded-lg border border-primary/40 bg-primary/5 p-3"
          : "space-y-2"
      }
    >
      <div className="flex flex-wrap items-center gap-2">
        <Label htmlFor={inputId}>
          {label}
          {required && (
            <span className="text-destructive" aria-hidden="true">
              {" "}
              *
            </span>
          )}
        </Label>
        {recommended && (
          <Badge variant="outline" className="border-primary/40 text-primary">
            Recommended
          </Badge>
        )}
      </div>
      {recommended && (
        <p id={descriptionId} className="text-xs text-muted-foreground">
          Select every platform this file supports.
        </p>
      )}
      {values.length > 0 && (
        <div className="flex flex-wrap gap-1.5">
          {values.map((value) => (
            <Badge key={value} variant="secondary" className="gap-1 pr-1">
              {value}
              <button
                type="button"
                className="rounded-sm focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-ring"
                aria-label={`Remove ${value}`}
                disabled={disabled}
                onClick={() =>
                  onChange(values.filter((item) => item !== value))
                }
              >
                <X className="h-3 w-3" />
              </button>
            </Badge>
          ))}
        </div>
      )}
      <div className="flex gap-2">
        <Input
          ref={inputRef}
          id={inputId}
          value={input}
          onChange={(event) => setInput(event.target.value)}
          onKeyDown={handleKeyDown}
          list={listId}
          placeholder={placeholder}
          disabled={disabled}
          aria-describedby={recommended ? descriptionId : undefined}
          aria-required={required}
        />
        <Button
          type="button"
          variant="outline"
          onClick={addValue}
          disabled={disabled || !input.trim()}
        >
          Add
        </Button>
      </div>
      <datalist id={listId}>
        {suggestions.map((suggestion) => (
          <option key={suggestion} value={suggestion} />
        ))}
      </datalist>
    </div>
  );
}

function AssetEditor({
  asset,
  onChange,
  onRemove,
  onRetry,
  onCancelUpload,
  disabled,
  commitDisabled,
  showCommitInput,
  focusPlatforms,
}: {
  asset: ReleaseAssetDraft;
  onChange: (changes: Partial<ReleaseAssetDraft>) => void;
  onRemove: () => void;
  onRetry: () => void;
  onCancelUpload: () => void;
  disabled: boolean;
  commitDisabled: boolean;
  showCommitInput: boolean;
  focusPlatforms: boolean;
}) {
  const variantListId = useId();
  const isApk = asset.mimeType === "application/vnd.android.package-archive";
  const suggestedMimeType = MIME_TYPE_SUGGESTIONS.includes(asset.mimeType);
  const mimeTypeChoice = suggestedMimeType
    ? asset.mimeType
    : CUSTOM_MIME_TYPE_CHOICE;

  return (
    <div className="rounded-xl border bg-card">
      <div className="flex items-start gap-3 p-4">
        <div className="rounded-lg bg-muted p-2">
          {asset.status === "uploaded" ? (
            <Check className="h-5 w-5 text-emerald-600" />
          ) : asset.status === "uploading" ? (
            <Loader2 className="h-5 w-5 animate-spin text-pink-500" />
          ) : (
            <FileArchive className="h-5 w-5 text-muted-foreground" />
          )}
        </div>
        <div className="min-w-0 flex-1">
          <p className="break-all font-medium">{asset.file.name}</p>
          <p className="text-sm text-muted-foreground">
            {formatFileSize(asset.file.size)}
          </p>
        </div>
        <div className="flex items-center gap-1">
          {asset.status === "error" && (
            <Button
              type="button"
              variant="outline"
              size="sm"
              onClick={onRetry}
              disabled={disabled}
            >
              Retry
            </Button>
          )}
          {asset.status === "uploading" && asset.stalled && (
            <Button
              type="button"
              variant="outline"
              size="sm"
              onClick={onCancelUpload}
              disabled={disabled}
            >
              Cancel upload
            </Button>
          )}
          <Button
            type="button"
            variant="ghost"
            size="icon"
            onClick={onRemove}
            disabled={disabled}
            aria-label={`Remove ${asset.file.name}`}
          >
            <Trash2 className="h-4 w-4" />
          </Button>
        </div>
      </div>

      {(asset.status !== "pending" || asset.error) && (
        <div className="space-y-1.5 px-4 pb-4">
          <div className="flex justify-between text-xs text-muted-foreground">
            <span>
              {asset.status === "uploaded"
                ? "Uploaded to Blossom"
                : asset.status === "error"
                  ? asset.error
                  : asset.status === "queued"
                    ? "Waiting to upload to Blossom"
                    : asset.stalled
                      ? "Upload appears stalled"
                      : "Uploading to Blossom"}
            </span>
            <span>{asset.progress}%</span>
          </div>
          <Progress value={asset.progress} className="h-2" />
        </div>
      )}

      <div className="grid gap-4 border-t p-4 md:grid-cols-2">
        <div className="space-y-2">
          <Label htmlFor={`${asset.id}-filename`}>Download filename</Label>
          <Input
            id={`${asset.id}-filename`}
            value={asset.filename}
            onChange={(event) => onChange({ filename: event.target.value })}
            disabled={disabled}
            placeholder="Optional"
          />
        </div>
        <div className="space-y-2">
          <Label htmlFor={`${asset.id}-mime`}>
            MIME type{" "}
            <span className="text-destructive" aria-hidden="true">
              *
            </span>
          </Label>
          <Select
            value={mimeTypeChoice}
            onValueChange={(choice) =>
              onChange({
                mimeType: choice === CUSTOM_MIME_TYPE_CHOICE ? "" : choice,
              })
            }
            disabled={disabled}
          >
            <SelectTrigger id={`${asset.id}-mime`} aria-required="true">
              <SelectValue />
            </SelectTrigger>
            <SelectContent>
              {MIME_TYPE_SUGGESTIONS.map((mimeType) => (
                <SelectItem key={mimeType} value={mimeType}>
                  {mimeType}
                </SelectItem>
              ))}
              <SelectSeparator />
              <SelectItem value={CUSTOM_MIME_TYPE_CHOICE}>
                Custom MIME type…
              </SelectItem>
            </SelectContent>
          </Select>
          {!suggestedMimeType && (
            <Input
              value={asset.mimeType}
              onChange={(event) => onChange({ mimeType: event.target.value })}
              placeholder="Enter a MIME type, e.g. image/png"
              disabled={disabled}
              required
              aria-label="Custom MIME type"
            />
          )}
        </div>
        <SuggestedTagInput
          label="Platforms"
          values={asset.platforms}
          onChange={(platforms) => onChange({ platforms })}
          suggestions={PLATFORM_SUGGESTIONS}
          placeholder="Select or enter a platform"
          disabled={disabled}
          autoFocus={focusPlatforms}
          recommended
        />
        <div className="space-y-2">
          <Label htmlFor={`${asset.id}-variant`}>Variant</Label>
          <Input
            id={`${asset.id}-variant`}
            value={asset.variant}
            onChange={(event) => onChange({ variant: event.target.value })}
            list={variantListId}
            disabled={disabled}
            placeholder="Optional, e.g. portable"
          />
          <datalist id={variantListId}>
            {VARIANT_SUGGESTIONS.map((variant) => (
              <option key={variant} value={variant} />
            ))}
          </datalist>
        </div>
      </div>

      <Collapsible>
        <CollapsibleTrigger className="group flex w-full items-center gap-2 border-t px-4 py-3 text-sm font-medium hover:bg-accent/40 focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-inset focus-visible:ring-ring">
          Optional compatibility and provenance
          <ChevronDown className="ml-auto h-4 w-4 transition-transform group-data-[state=open]:rotate-180" />
        </CollapsibleTrigger>
        <CollapsibleContent>
          <div className="grid gap-4 border-t bg-muted/20 p-4 md:grid-cols-2">
            {showCommitInput && (
              <div className="space-y-2 md:col-span-2">
                <Label htmlFor={`${asset.id}-commit`}>
                  Build commit override
                </Label>
                <Input
                  id={`${asset.id}-commit`}
                  value={asset.commit}
                  onChange={(event) => onChange({ commit: event.target.value })}
                  disabled={disabled || commitDisabled}
                  aria-invalid={
                    asset.commit.trim().length > 0 &&
                    !GIT_COMMIT_ID.test(asset.commit.trim())
                  }
                  placeholder="Use the release build commit"
                />
                {asset.commit.trim().length > 0 &&
                  !GIT_COMMIT_ID.test(asset.commit.trim()) && (
                    <p className="text-xs text-destructive">
                      Enter a full 40-character Git commit ID.
                    </p>
                  )}
              </div>
            )}
            <div className="space-y-2">
              <Label htmlFor={`${asset.id}-min-platform`}>
                Minimum platform version
              </Label>
              <Input
                id={`${asset.id}-min-platform`}
                value={asset.minPlatformVersion}
                onChange={(event) =>
                  onChange({ minPlatformVersion: event.target.value })
                }
                disabled={disabled}
                placeholder="Optional"
              />
            </div>
            <div className="space-y-2">
              <Label htmlFor={`${asset.id}-target-platform`}>
                Target platform version
              </Label>
              <Input
                id={`${asset.id}-target-platform`}
                value={asset.targetPlatformVersion}
                onChange={(event) =>
                  onChange({ targetPlatformVersion: event.target.value })
                }
                disabled={disabled}
                placeholder="Optional"
              />
            </div>
            <div className="space-y-2">
              <Label htmlFor={`${asset.id}-min-allowed`}>
                Minimum allowed asset version
              </Label>
              <Input
                id={`${asset.id}-min-allowed`}
                value={asset.minAllowedVersion}
                onChange={(event) =>
                  onChange({ minAllowedVersion: event.target.value })
                }
                disabled={disabled}
                placeholder="Optional"
              />
            </div>
            <div className="space-y-2">
              <Label htmlFor={`${asset.id}-web-url`}>
                Original web content URL
              </Label>
              <Input
                id={`${asset.id}-web-url`}
                type="url"
                value={asset.originalWebUrl}
                onChange={(event) =>
                  onChange({ originalWebUrl: event.target.value })
                }
                disabled={disabled}
                placeholder="Optional PWA or web content URL"
              />
            </div>
            <div className="md:col-span-2">
              <SuggestedTagInput
                label="Supported NIPs"
                values={asset.supportedNips}
                onChange={(supportedNips) => onChange({ supportedNips })}
                suggestions={NIP_SUGGESTIONS}
                placeholder="Select or enter a NIP number"
                disabled={disabled}
              />
            </div>

            {isApk && (
              <>
                <div className="space-y-2">
                  <Label htmlFor={`${asset.id}-version-code`}>
                    Android version code{" "}
                    <span className="text-destructive" aria-hidden="true">
                      *
                    </span>
                  </Label>
                  <Input
                    id={`${asset.id}-version-code`}
                    inputMode="numeric"
                    value={asset.versionCode}
                    onChange={(event) =>
                      onChange({ versionCode: event.target.value })
                    }
                    disabled={disabled}
                    required
                  />
                </div>
                <div className="space-y-2">
                  <Label htmlFor={`${asset.id}-min-version-code`}>
                    Minimum allowed version code
                  </Label>
                  <Input
                    id={`${asset.id}-min-version-code`}
                    inputMode="numeric"
                    value={asset.minAllowedVersionCode}
                    onChange={(event) =>
                      onChange({ minAllowedVersionCode: event.target.value })
                    }
                    disabled={disabled}
                    placeholder="Optional"
                  />
                </div>
                <div className="md:col-span-2">
                  <SuggestedTagInput
                    label="APK certificate hashes"
                    values={asset.apkCertificateHashes}
                    onChange={(apkCertificateHashes) =>
                      onChange({ apkCertificateHashes })
                    }
                    suggestions={[]}
                    placeholder="Required SHA-256 certificate hash"
                    disabled={disabled}
                    required
                  />
                </div>
              </>
            )}
          </div>
        </CollapsibleContent>
      </Collapsible>
    </div>
  );
}

function stageLabel(stage: PublishStage): string {
  switch (stage) {
    case "signing":
      return "Signing release events";
    case "publishing-release":
      return "Publishing release";
    case "publishing-assets":
      return "Publishing asset metadata";
    default:
      return "";
  }
}

export function CreateReleaseDialog({
  open,
  onOpenChange,
  applications,
  existingReleases,
  gitTags,
  repoCoordinates,
  maintainerPubkeys,
  relayHint,
}: CreateReleaseDialogProps) {
  const account = useActiveAccount();
  const { uploadFile } = useBlossomUpload();
  const { toast } = useToast();
  const fileInputRef = useRef<HTMLInputElement>(null);
  const wasOpenRef = useRef(false);
  const startedUploadsRef = useRef(new Set<string>());
  const cancelledUploadsRef = useRef(new Set<string>());
  const uploadControllersRef = useRef(new Map<string, AbortController>());
  const selectedFileIdsRef = useRef(new Set<string>());
  const uploadQueueRef = useRef(Promise.resolve());
  const [createApplicationOpen, setCreateApplicationOpen] = useState(false);
  const [createdApplication, setCreatedApplication] =
    useState<SoftwareApplication>();
  const [applicationCoordinate, setApplicationCoordinate] = useState("");
  const [versionChoice, setVersionChoice] = useState("");
  const [version, setVersion] = useState("");
  const [channelChoice, setChannelChoice] = useState("main");
  const [channel, setChannel] = useState("main");
  const [buildCommit, setBuildCommit] = useState("");
  const [notes, setNotes] = useState("");
  const [assets, setAssets] = useState<ReleaseAssetDraft[]>([]);
  const [platformFocusAssetId, setPlatformFocusAssetId] = useState<string>();
  const [stage, setStage] = useState<PublishStage>("editing");
  const [error, setError] = useState<string>();
  const busy = stage !== "editing";

  const availableApplications = useMemo(
    () =>
      createdApplication &&
      !applications.some(
        (application) =>
          application.coordinate === createdApplication.coordinate,
      )
        ? [...applications, createdApplication]
        : applications,
    [applications, createdApplication],
  );
  const ownedApplications = useMemo(
    () =>
      availableApplications.filter(
        (application) => application.pubkey === account?.pubkey,
      ),
    [account?.pubkey, availableApplications],
  );
  const selectedApplication = ownedApplications.find(
    (application) => application.coordinate === applicationCoordinate,
  );
  const customVersionSelected = versionChoice === CUSTOM_VERSION_CHOICE;
  const existingVersions = useMemo(
    () =>
      new Set(
        existingReleases
          .filter(
            (release) =>
              release.pubkey === account?.pubkey &&
              release.appId === selectedApplication?.appId,
          )
          .map((release) => canonicalReleaseVersion(release.version)),
      ),
    [account?.pubkey, existingReleases, selectedApplication?.appId],
  );
  const gitVersionOptions = useMemo(() => {
    const options = new Map<string, GitVersionOption>();
    for (const tag of gitTags) {
      const tagVersion = canonicalReleaseVersion(tag.name);
      const existing = options.get(tagVersion);
      if (!existing || tag.name === tagVersion) {
        options.set(tagVersion, {
          tagName: tag.name,
          version: tagVersion,
          commitId: tag.commitId,
        });
      }
    }
    return [...options.values()];
  }, [gitTags]);
  const selectedGitVersion = gitVersionOptions.find(
    (option) => versionChoice === `${TAG_VERSION_PREFIX}${option.tagName}`,
  );
  const selectedGitCommit = selectedGitVersion?.commitId;
  const matchingGitVersionForCustom = customVersionSelected
    ? gitVersionOptions.find(
        (option) => option.version === canonicalReleaseVersion(version),
      )
    : undefined;
  const versionsWithoutGitTags = useMemo(() => {
    const gitVersions = new Set(
      gitVersionOptions.map((option) => option.version),
    );
    return [...existingVersions].filter((version) => !gitVersions.has(version));
  }, [existingVersions, gitVersionOptions]);
  const releaseVersion = canonicalReleaseVersion(version);
  const versionAlreadyExists = existingVersions.has(releaseVersion);
  const buildCommitInvalid =
    buildCommit.trim().length > 0 && !GIT_COMMIT_ID.test(buildCommit.trim());
  const assetCommitInvalid = assets.some(
    (asset) =>
      asset.commit.trim().length > 0 &&
      !GIT_COMMIT_ID.test(asset.commit.trim()),
  );
  const uploadsIncomplete = assets.some(
    (asset) => asset.status !== "uploaded" || !asset.uploaded,
  );

  useEffect(() => {
    if (!open || !selectedGitCommit) return;
    // Git refs remain live while the dialog is open. Keep the hidden asset
    // provenance synchronized with the commit shown beneath the selected tag.
    setBuildCommit(selectedGitCommit);
    setAssets((current) =>
      current.map((asset) =>
        asset.commit === selectedGitCommit
          ? asset
          : { ...asset, commit: selectedGitCommit },
      ),
    );
  }, [open, selectedGitCommit]);

  useEffect(() => {
    const justOpened = open && !wasOpenRef.current;
    wasOpenRef.current = open;
    if (!justOpened) return;
    setVersionChoice("");
    setVersion("");
    setChannelChoice("main");
    setChannel("main");
    setBuildCommit("");
    setNotes("");
    setAssets([]);
    selectedFileIdsRef.current.clear();
    setPlatformFocusAssetId(undefined);
    setCreateApplicationOpen(false);
    setStage("editing");
    setError(undefined);
  }, [open]);

  useEffect(() => {
    if (!open) return;
    setApplicationCoordinate((current) =>
      ownedApplications.some(
        (application) => application.coordinate === current,
      )
        ? current
        : (ownedApplications[0]?.coordinate ?? ""),
    );
  }, [open, ownedApplications]);

  useEffect(() => {
    if (createdApplication && createdApplication.pubkey !== account?.pubkey) {
      setCreatedApplication(undefined);
    }
  }, [account?.pubkey, createdApplication]);

  const updateApplicationChoice = (coordinate: string) => {
    if (coordinate === ADD_APPLICATION_CHOICE) {
      setCreateApplicationOpen(true);
      return;
    }
    setApplicationCoordinate(coordinate);
  };

  const updateBuildCommit = (nextCommit: string, forceAssets = false) => {
    setAssets((current) =>
      current.map((asset) =>
        forceAssets || asset.commit === buildCommit
          ? { ...asset, commit: nextCommit }
          : asset,
      ),
    );
    setBuildCommit(nextCommit);
  };

  const applyGitVersion = (tag: GitVersionOption) => {
    setVersionChoice(`${TAG_VERSION_PREFIX}${tag.tagName}`);
    setVersion(tag.version);
    updateBuildCommit(tag.commitId, true);
  };

  const updateVersionChoice = (nextChoice: string) => {
    const nextGitTag = gitVersionOptions.find(
      (tag) => nextChoice === `${TAG_VERSION_PREFIX}${tag.tagName}`,
    );
    if (nextGitTag) {
      applyGitVersion(nextGitTag);
    } else {
      setVersionChoice(nextChoice);
      setVersion("");
      updateBuildCommit("", true);
    }
  };

  const commitCustomVersion = (value: string) => {
    const normalized = canonicalReleaseVersion(value);
    const matchingTag = gitVersionOptions.find(
      (option) => option.version === normalized,
    );
    if (matchingTag) {
      applyGitVersion(matchingTag);
    } else {
      setVersion(normalized);
    }
  };

  const updateChannelChoice = (nextChoice: string) => {
    setChannelChoice(nextChoice);
    setChannel(nextChoice === CUSTOM_CHANNEL_CHOICE ? "" : nextChoice);
  };

  const updateAsset = useCallback(
    (assetId: string, changes: Partial<ReleaseAssetDraft>) => {
      setAssets((current) =>
        current.map((asset) =>
          asset.id === assetId ? { ...asset, ...changes } : asset,
        ),
      );
    },
    [],
  );

  const uploadAsset = useCallback(
    async (asset: ReleaseAssetDraft) => {
      const controller = new AbortController();
      uploadControllersRef.current.set(asset.id, controller);
      updateAsset(asset.id, {
        status: "uploading",
        progress: 0,
        stalled: false,
        error: undefined,
      });

      const uploadFileWithMime =
        asset.file.type === asset.mimeType
          ? asset.file
          : new File([asset.file], asset.file.name, {
              type: asset.mimeType,
              lastModified: asset.file.lastModified,
            });
      let tags: Nip94Tags | null;
      try {
        tags = await uploadFile(uploadFileWithMime, {
          onProgress: (progress) => updateAsset(asset.id, { progress }),
          onStalled: (stalled) => updateAsset(asset.id, { stalled }),
          preserveOriginal: true,
          signal: controller.signal,
        });
      } finally {
        if (uploadControllersRef.current.get(asset.id) === controller) {
          uploadControllersRef.current.delete(asset.id);
        }
      }
      if (controller.signal.aborted) throw new Error("Upload cancelled");
      const url = tags ? uploadTag(tags, "url") : undefined;
      const sha256 = tags ? uploadTag(tags, "x") : undefined;
      const sizeValue = tags ? uploadTag(tags, "size") : undefined;
      const size = sizeValue ? Number(sizeValue) : asset.file.size;

      if (!url || !sha256 || !Number.isSafeInteger(size)) {
        throw new Error(
          `Blossom returned incomplete metadata for ${asset.file.name}`,
        );
      }

      updateAsset(asset.id, {
        uploaded: { url, sha256, size },
        status: "uploaded",
        progress: 100,
        stalled: false,
      });
    },
    [updateAsset, uploadFile],
  );

  useEffect(() => {
    if (!open) return;

    for (const asset of assets) {
      if (
        asset.status !== "pending" ||
        startedUploadsRef.current.has(asset.id)
      ) {
        continue;
      }

      startedUploadsRef.current.add(asset.id);
      updateAsset(asset.id, { status: "queued", error: undefined });
      uploadQueueRef.current = uploadQueueRef.current
        .catch(() => undefined)
        .then(() => {
          if (cancelledUploadsRef.current.has(asset.id)) return;
          return uploadAsset(asset);
        })
        .catch((caught: unknown) => {
          const message =
            caught instanceof Error ? caught.message : "Upload failed";
          updateAsset(asset.id, {
            status: "error",
            error: message,
          });
        });
    }
  }, [assets, open, updateAsset, uploadAsset]);

  useEffect(() => {
    if (open) return;
    for (const asset of assets) {
      cancelledUploadsRef.current.add(asset.id);
      uploadControllersRef.current.get(asset.id)?.abort();
    }
  }, [assets, open]);

  const addFiles = useCallback(
    (files: File[]) => {
      if (files.length === 0) return;
      const additions: ReleaseAssetDraft[] = [];
      for (const file of files) {
        const identity = fileIdentity(file);
        if (selectedFileIdsRef.current.has(identity)) continue;
        selectedFileIdsRef.current.add(identity);
        additions.push(createAssetDraft(file, buildCommit));
      }
      if (additions.length === 0) return;

      setAssets((current) => [...current, ...additions]);
      setPlatformFocusAssetId(additions[0].id);
    },
    [buildCommit],
  );

  const handleFileInput = (event: ChangeEvent<HTMLInputElement>) => {
    addFiles(Array.from(event.target.files ?? []));
    event.target.value = "";
  };
  const handleDrop = (event: DragEvent<HTMLDivElement>) => {
    event.preventDefault();
    if (busy) return;
    addFiles(Array.from(event.dataTransfer.files));
  };
  const retryUpload = (assetId: string) => {
    cancelledUploadsRef.current.delete(assetId);
    startedUploadsRef.current.delete(assetId);
    updateAsset(assetId, {
      status: "pending",
      progress: 0,
      stalled: false,
      error: undefined,
    });
  };
  const cancelUpload = (assetId: string) => {
    uploadControllersRef.current.get(assetId)?.abort();
  };
  const removeAsset = (asset: ReleaseAssetDraft) => {
    cancelledUploadsRef.current.add(asset.id);
    uploadControllersRef.current.get(asset.id)?.abort();
    selectedFileIdsRef.current.delete(fileIdentity(asset.file));
    setAssets((current) =>
      current.filter((currentAsset) => currentAsset.id !== asset.id),
    );
  };

  const validate = (): string | undefined => {
    if (!account) return "Log in to publish a release.";
    if (!selectedApplication || selectedApplication.pubkey !== account.pubkey) {
      return "Select an application you publish.";
    }
    if (!releaseVersion) return "Enter a release version.";
    if (versionAlreadyExists) {
      return `${selectedApplication.name} already has a ${releaseVersion} release.`;
    }
    if (matchingGitVersionForCustom) {
      return `Use the ${matchingGitVersionForCustom.tagName} Git tag for this version.`;
    }
    if (!channel.trim()) return "Enter a release channel.";
    if (buildCommitInvalid) {
      return "The build commit must be a full 40-character Git commit ID.";
    }
    if (assets.length === 0) return "Add at least one release file.";
    if (uploadsIncomplete) {
      return "Wait for every release file to finish uploading to Blossom.";
    }
    for (const asset of assets) {
      if (
        asset.commit.trim().length > 0 &&
        !GIT_COMMIT_ID.test(asset.commit.trim())
      ) {
        return `${asset.file.name} has an invalid build commit ID.`;
      }
      if (!asset.mimeType.trim()) {
        return `${asset.file.name} needs a MIME type.`;
      }
      if (asset.mimeType === "application/vnd.android.package-archive") {
        // Intentional tradeoff: require APK provenance fields without claiming
        // to verify publisher-supplied Android build metadata. Consumers and
        // package managers remain responsible for validating version-code and
        // certificate-hash formats before installation.
        if (
          !asset.versionCode.trim() ||
          asset.apkCertificateHashes.length === 0
        ) {
          return `${asset.file.name} needs an Android version code and APK certificate hash.`;
        }
      }
    }
    return undefined;
  };

  const handleSubmit = async () => {
    const validationError = validate();
    if (validationError) {
      setError(validationError);
      return;
    }
    if (!account || !selectedApplication) return;

    setError(undefined);
    try {
      const uploadedAssets: Array<{
        draft: ReleaseAssetDraft;
        uploaded: UploadedAsset;
      }> = [];

      for (const asset of assets) {
        if (!asset.uploaded) {
          throw new Error(`${asset.file.name} has not finished uploading.`);
        }
        uploadedAssets.push({ draft: asset, uploaded: asset.uploaded });
      }

      setStage("signing");
      const createdAt = Math.floor(Date.now() / 1000);
      const signedAssets: NostrEvent[] = [];
      for (const { draft, uploaded } of uploadedAssets) {
        signedAssets.push(
          await SoftwareAssetFactory.create({
            appId: selectedApplication.appId,
            version: releaseVersion,
            url: uploaded.url,
            filename: draft.filename,
            mimeType: draft.mimeType,
            sha256: uploaded.sha256,
            size: uploaded.size,
            platforms: draft.platforms,
            minPlatformVersion: draft.minPlatformVersion,
            targetPlatformVersion: draft.targetPlatformVersion,
            supportedNips: draft.supportedNips,
            variant: draft.variant,
            commit: draft.commit,
            minAllowedVersion: draft.minAllowedVersion,
            versionCode: draft.versionCode,
            minAllowedVersionCode: draft.minAllowedVersionCode,
            apkCertificateHashes: draft.apkCertificateHashes,
            originalWebUrl: draft.originalWebUrl,
            createdAt,
          }).sign(account.signer),
        );
      }

      const release = await SoftwareReleaseFactory.create({
        applicationCoordinate: selectedApplication.coordinate,
        appId: selectedApplication.appId,
        version: releaseVersion,
        channel: channel.trim(),
        notes,
        assets: signedAssets.map((asset, index) => ({
          eventId: asset.id,
          relayHint,
          platforms: uploadedAssets[index].draft.platforms,
        })),
        relayHint,
        createdAt,
      }).sign(account.signer);

      setStage("publishing-release");
      await publish(release, repoCoordinates);

      setStage("publishing-assets");
      await Promise.all(
        signedAssets.map((asset) => publish(asset, repoCoordinates)),
      );

      toast({
        title: "Release published",
        description: `${selectedApplication.name} ${releaseVersion} is now available.`,
      });
      onOpenChange(false);
    } catch (caught) {
      const message =
        caught instanceof Error ? caught.message : "Failed to publish release";
      setError(message);
      setStage("editing");
      setAssets((current) =>
        current.map((asset) =>
          asset.status === "uploading"
            ? { ...asset, status: "error", error: message }
            : asset,
        ),
      );
    }
  };

  return (
    <Dialog
      open={open}
      onOpenChange={(nextOpen) => {
        if (!busy) {
          if (!nextOpen) setCreateApplicationOpen(false);
          onOpenChange(nextOpen);
        }
      }}
    >
      <DialogContent className="max-h-[92vh] max-w-4xl overflow-y-auto p-0">
        <DialogHeader className="border-b px-5 py-5 pr-12 md:px-6">
          <DialogTitle>Publish a software release</DialogTitle>
          <DialogDescription>
            Each release belongs to an application—the product this repository
            builds. This keeps releases separate when a repository contains more
            than one product. Files upload to Blossom as soon as you select
            them.
          </DialogDescription>
        </DialogHeader>

        <div className="space-y-6 px-5 md:px-6">
          {ownedApplications.length === 0 ? (
            <div className="rounded-xl border border-dashed p-6 text-center">
              <p className="font-medium">
                No applications controlled by this account
              </p>
              <p className="mx-auto mt-1 max-w-lg text-sm text-muted-foreground">
                Only the pubkey that created an application can publish its
                releases and software assets. Add an application with this
                maintainer account, or go back and switch accounts.
              </p>
              <Button
                type="button"
                variant="outline"
                className="mt-4"
                onClick={() => setCreateApplicationOpen(true)}
                disabled={busy}
              >
                <Plus className="mr-2 h-4 w-4" />
                Add application
              </Button>
            </div>
          ) : (
            <div className="grid gap-4 md:grid-cols-3">
              <div className="space-y-2">
                <Label htmlFor="release-application">
                  Application{" "}
                  <span className="text-destructive" aria-hidden="true">
                    *
                  </span>
                </Label>
                <Select
                  value={applicationCoordinate}
                  onValueChange={updateApplicationChoice}
                  disabled={busy}
                >
                  <SelectTrigger id="release-application" aria-required="true">
                    <SelectValue placeholder="Select an application" />
                  </SelectTrigger>
                  <SelectContent>
                    {availableApplications.map((application) => (
                      <SelectItem
                        key={application.coordinate}
                        value={application.coordinate}
                        disabled={application.pubkey !== account?.pubkey}
                      >
                        {application.name} ({application.appId})
                        {application.pubkey !== account?.pubkey
                          ? " — another publisher"
                          : ""}
                      </SelectItem>
                    ))}
                    <SelectSeparator />
                    <SelectItem value={ADD_APPLICATION_CHOICE}>
                      Add another application…
                    </SelectItem>
                  </SelectContent>
                </Select>
                <p className="text-xs text-muted-foreground">
                  Only the application publisher can sign its releases and
                  software assets.
                </p>
              </div>
              <div className="space-y-2">
                <Label htmlFor="release-version-choice">
                  Version / Git tag{" "}
                  <span className="text-destructive" aria-hidden="true">
                    *
                  </span>
                </Label>
                <Select
                  value={versionChoice}
                  onValueChange={updateVersionChoice}
                  disabled={busy}
                >
                  <SelectTrigger
                    id="release-version-choice"
                    aria-invalid={versionAlreadyExists}
                    aria-required="true"
                  >
                    <SelectValue placeholder="Select version" />
                  </SelectTrigger>
                  <SelectContent>
                    {gitVersionOptions.map((tag) => {
                      const alreadyReleased = existingVersions.has(tag.version);
                      return (
                        <SelectItem
                          key={tag.tagName}
                          value={`${TAG_VERSION_PREFIX}${tag.tagName}`}
                          disabled={alreadyReleased}
                        >
                          {tag.version}
                          {alreadyReleased ? " (release exists)" : ""}
                        </SelectItem>
                      );
                    })}
                    {versionsWithoutGitTags.map((existingVersion) => (
                      <SelectItem
                        key={existingVersion}
                        value={`existing:${existingVersion}`}
                        disabled
                      >
                        {existingVersion} (release exists)
                      </SelectItem>
                    ))}
                    {(gitVersionOptions.length > 0 ||
                      versionsWithoutGitTags.length > 0) && <SelectSeparator />}
                    <SelectItem value={CUSTOM_VERSION_CHOICE}>
                      Custom version…
                    </SelectItem>
                  </SelectContent>
                </Select>
                {selectedGitVersion && (
                  <p
                    className="text-xs text-muted-foreground"
                    title={selectedGitVersion.commitId}
                  >
                    commit{" "}
                    <span className="font-mono">
                      {selectedGitVersion.commitId.slice(0, 7)}
                    </span>
                  </p>
                )}
                {customVersionSelected && (
                  <Input
                    id="release-version"
                    value={version}
                    onChange={(event) => setVersion(event.target.value)}
                    onBlur={(event) =>
                      commitCustomVersion(event.currentTarget.value)
                    }
                    placeholder="Enter a version"
                    disabled={busy}
                    aria-invalid={versionAlreadyExists}
                    required
                  />
                )}
                {versionAlreadyExists && (
                  <p className="text-xs text-destructive">
                    This application already has a {releaseVersion} release.
                  </p>
                )}
              </div>
              <div className="space-y-2">
                <Label htmlFor="release-channel-choice">
                  Channel{" "}
                  <span className="text-destructive" aria-hidden="true">
                    *
                  </span>
                </Label>
                <Select
                  value={channelChoice}
                  onValueChange={updateChannelChoice}
                  disabled={busy}
                >
                  <SelectTrigger
                    id="release-channel-choice"
                    aria-required="true"
                  >
                    <SelectValue />
                  </SelectTrigger>
                  <SelectContent>
                    {CHANNEL_SUGGESTIONS.map((suggestion) => (
                      <SelectItem key={suggestion} value={suggestion}>
                        {suggestion}
                      </SelectItem>
                    ))}
                    <SelectItem value={CUSTOM_CHANNEL_CHOICE}>
                      Custom channel…
                    </SelectItem>
                  </SelectContent>
                </Select>
                {channelChoice === CUSTOM_CHANNEL_CHOICE && (
                  <Input
                    id="release-channel"
                    value={channel}
                    onChange={(event) => setChannel(event.target.value)}
                    placeholder="Enter a channel"
                    disabled={busy}
                    required
                  />
                )}
              </div>
              {customVersionSelected && (
                <div className="space-y-2 md:col-span-3">
                  <Label
                    htmlFor="release-build-commit"
                    className="text-muted-foreground"
                  >
                    Build commit
                  </Label>
                  <Input
                    id="release-build-commit"
                    value={buildCommit}
                    onChange={(event) => updateBuildCommit(event.target.value)}
                    disabled={busy || !releaseVersion}
                    aria-invalid={buildCommitInvalid}
                    placeholder="Optional commit used to build these files"
                    className="font-mono text-xs"
                  />
                  {buildCommitInvalid && (
                    <p className="text-xs text-destructive">
                      Enter a full 40-character Git commit ID.
                    </p>
                  )}
                </div>
              )}
              <div className="space-y-2 md:col-span-3">
                <Label htmlFor="release-notes">Release notes</Label>
                <Textarea
                  id="release-notes"
                  value={notes}
                  onChange={(event) => setNotes(event.target.value)}
                  placeholder="What changed? Markdown is supported."
                  disabled={busy}
                  rows={5}
                />
              </div>
            </div>
          )}

          <div className="space-y-3">
            <div className="flex items-center justify-between gap-3">
              <div>
                <h3 className="font-semibold">
                  Release files{" "}
                  <span className="text-destructive" aria-hidden="true">
                    *
                  </span>
                  <span className="sr-only"> (required)</span>
                </h3>
                <p className="text-sm text-muted-foreground">
                  Add binaries, packages, signatures, checksums, or other
                  release artifacts.
                </p>
              </div>
              <Button
                type="button"
                variant="outline"
                onClick={() => fileInputRef.current?.click()}
                disabled={busy}
              >
                <Plus className="mr-2 h-4 w-4" />
                Add files
              </Button>
              <input
                ref={fileInputRef}
                type="file"
                multiple
                className="hidden"
                onChange={handleFileInput}
                disabled={busy}
              />
            </div>

            {assets.length === 0 ? (
              <div
                className="rounded-xl border-2 border-dashed p-8 text-center outline-none transition-colors hover:bg-muted/30 focus-visible:ring-2 focus-visible:ring-ring"
                tabIndex={0}
                role="button"
                aria-label="Add release files"
                onClick={() => fileInputRef.current?.click()}
                onKeyDown={(event) => {
                  if (event.key === "Enter" || event.key === " ") {
                    event.preventDefault();
                    fileInputRef.current?.click();
                  }
                }}
                onDragOver={(event) => event.preventDefault()}
                onDrop={handleDrop}
              >
                <Upload className="mx-auto h-8 w-8 text-muted-foreground" />
                <p className="mt-3 font-medium">Choose or drop release files</p>
                <p className="mt-1 text-sm text-muted-foreground">
                  MIME types are inferred and remain editable.
                </p>
              </div>
            ) : (
              <div className="space-y-4">
                {assets.map((asset) => (
                  <AssetEditor
                    key={asset.id}
                    asset={asset}
                    onChange={(changes) => updateAsset(asset.id, changes)}
                    onRetry={() => retryUpload(asset.id)}
                    onCancelUpload={() => cancelUpload(asset.id)}
                    onRemove={() => removeAsset(asset)}
                    disabled={busy}
                    commitDisabled={!releaseVersion}
                    showCommitInput={customVersionSelected}
                    focusPlatforms={asset.id === platformFocusAssetId}
                  />
                ))}
              </div>
            )}
          </div>

          {busy && (
            <div className="rounded-xl border bg-muted/30 p-4">
              <div className="mb-2 flex items-center gap-2 text-sm font-medium">
                <Loader2 className="h-4 w-4 animate-spin text-pink-500" />
                {stageLabel(stage)}
              </div>
              <Progress value={100} className="h-2" />
            </div>
          )}

          {error && (
            <p
              className="rounded-lg border border-destructive/40 bg-destructive/10 px-4 py-3 text-sm text-destructive"
              role="alert"
            >
              {error}
            </p>
          )}
        </div>

        <DialogFooter className="sticky bottom-0 border-t bg-background px-5 py-4 md:px-6">
          <Button
            type="button"
            variant="outline"
            onClick={() => onOpenChange(false)}
            disabled={busy}
          >
            Cancel
          </Button>
          <Button
            type="button"
            onClick={handleSubmit}
            disabled={
              busy ||
              ownedApplications.length === 0 ||
              versionAlreadyExists ||
              buildCommitInvalid ||
              assetCommitInvalid ||
              uploadsIncomplete
            }
          >
            {busy ? (
              <Loader2 className="mr-2 h-4 w-4 animate-spin" />
            ) : (
              <Upload className="mr-2 h-4 w-4" />
            )}
            Publish release
          </Button>
        </DialogFooter>
        <CreateSoftwareApplicationDialog
          open={createApplicationOpen}
          onOpenChange={setCreateApplicationOpen}
          existingApplications={availableApplications}
          repoCoordinates={repoCoordinates}
          maintainerPubkeys={maintainerPubkeys}
          relayHint={relayHint}
          onPublished={(application) => {
            setCreatedApplication(application);
            setApplicationCoordinate(application.coordinate);
          }}
        />
      </DialogContent>
    </Dialog>
  );
}
