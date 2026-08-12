import { blankEventTemplate, EventFactory } from "applesauce-core/factories";
import { parseReplaceableAddress } from "applesauce-core/helpers";
import type { KnownEventTemplate } from "applesauce-core/helpers/event";
import { includeSingletonTag } from "applesauce-core/operations/tags";
import {
  SOFTWARE_APPLICATION_KIND,
  SOFTWARE_ASSET_KIND,
  SOFTWARE_RELEASE_KIND,
} from "@/casts/Software";

type SoftwareAssetTemplate = KnownEventTemplate<typeof SOFTWARE_ASSET_KIND>;
type SoftwareReleaseTemplate = KnownEventTemplate<typeof SOFTWARE_RELEASE_KIND>;

export interface SoftwareAssetInput {
  applicationCoordinate: string;
  appId: string;
  relayHint?: string;
  version: string;
  url?: string;
  filename?: string;
  mimeType: string;
  sha256: string;
  size?: number;
  platforms?: string[];
  minPlatformVersion?: string;
  targetPlatformVersion?: string;
  supportedNips?: string[];
  variant?: string;
  commit?: string;
  minAllowedVersion?: string;
  versionCode?: string;
  minAllowedVersionCode?: string;
  apkCertificateHashes?: string[];
  originalWebUrl?: string;
  createdAt: number;
}

export interface SoftwareReleaseAssetInput {
  eventId: string;
  relayHint?: string;
  platforms?: string[];
}

export interface SoftwareReleaseInput {
  applicationCoordinate: string;
  appId: string;
  version: string;
  channel: string;
  notes: string;
  assets: SoftwareReleaseAssetInput[];
  relayHint?: string;
  createdAt: number;
}

function trimmed(value: string | undefined): string | undefined {
  const result = value?.trim();
  return result || undefined;
}

function uniqueValues(values: string[] | undefined): string[] {
  return [
    ...new Set((values ?? []).map((value) => value.trim()).filter(Boolean)),
  ];
}

export class SoftwareAssetFactory extends EventFactory<
  typeof SOFTWARE_ASSET_KIND,
  SoftwareAssetTemplate
> {
  static create(input: SoftwareAssetInput): SoftwareAssetFactory {
    const appId = input.appId.trim();
    const application = parseReplaceableAddress(
      input.applicationCoordinate,
      true,
    );
    if (
      application?.kind !== SOFTWARE_APPLICATION_KIND ||
      application.identifier !== appId
    ) {
      throw new Error("Asset application coordinate does not match its ID");
    }
    if (!input.version.trim()) throw new Error("Asset version is required");
    if (!input.mimeType.trim()) throw new Error("Asset MIME type is required");
    if (!/^[0-9a-f]{64}$/i.test(input.sha256)) {
      throw new Error("Asset SHA-256 hash is invalid");
    }

    const url = trimmed(input.url);
    const filename = trimmed(input.filename);
    const applicationTag = input.relayHint
      ? ["a", input.applicationCoordinate, input.relayHint]
      : ["a", input.applicationCoordinate];
    const metadataTags: string[][] = [];
    const addOptionalTag = (name: string, value: string | undefined) => {
      const clean = trimmed(value);
      if (clean) metadataTags.push([name, clean]);
    };

    if (input.size !== undefined) metadataTags.push(["size", `${input.size}`]);
    for (const platform of uniqueValues(input.platforms)) {
      metadataTags.push(["f", platform]);
    }
    addOptionalTag("min_platform_version", input.minPlatformVersion);
    addOptionalTag("target_platform_version", input.targetPlatformVersion);
    for (const nip of uniqueValues(input.supportedNips)) {
      metadataTags.push(["supported_nip", nip]);
    }
    addOptionalTag("variant", input.variant);
    addOptionalTag("commit", input.commit);
    addOptionalTag("min_allowed_version", input.minAllowedVersion);
    addOptionalTag("version_code", input.versionCode);
    addOptionalTag("min_allowed_version_code", input.minAllowedVersionCode);
    for (const hash of uniqueValues(input.apkCertificateHashes)) {
      metadataTags.push(["apk_certificate_hash", hash]);
    }
    addOptionalTag("r", input.originalWebUrl);

    return new SoftwareAssetFactory((resolve) =>
      resolve(blankEventTemplate(SOFTWARE_ASSET_KIND)),
    )
      .content("")
      .created(input.createdAt)
      .modifyPublicTags((tags) => [
        ...tags,
        applicationTag,
        ["i", appId],
        ...(url ? [["url", url]] : []),
        ...(filename ? [["filename", filename]] : []),
        ["m", input.mimeType.trim()],
        ["x", input.sha256.toLowerCase()],
        ...metadataTags,
        ["version", input.version.trim()],
      ])
      .alt(`Software release asset: ${trimmed(input.filename) ?? input.appId}`);
  }
}

export class SoftwareReleaseFactory extends EventFactory<
  typeof SOFTWARE_RELEASE_KIND,
  SoftwareReleaseTemplate
> {
  static create(input: SoftwareReleaseInput): SoftwareReleaseFactory {
    const appId = input.appId.trim();
    const version = input.version.trim();
    const channel = input.channel.trim();
    const application = parseReplaceableAddress(
      input.applicationCoordinate,
      true,
    );
    if (
      application?.kind !== SOFTWARE_APPLICATION_KIND ||
      application.identifier !== appId
    ) {
      throw new Error("Release application coordinate does not match its ID");
    }
    if (!version) throw new Error("Release version is required");
    if (!channel) throw new Error("Release channel is required");
    if (input.assets.length === 0) {
      throw new Error("At least one release asset is required");
    }

    const applicationTag = input.relayHint
      ? ["a", input.applicationCoordinate, input.relayHint]
      : ["a", input.applicationCoordinate];
    const assetTags = input.assets.map(({ eventId, relayHint }) =>
      relayHint ? ["e", eventId, relayHint] : ["e", eventId],
    );
    const platforms = uniqueValues(
      input.assets.flatMap((asset) => asset.platforms ?? []),
    );

    return new SoftwareReleaseFactory((resolve) =>
      resolve(blankEventTemplate(SOFTWARE_RELEASE_KIND)),
    )
      .content(input.notes)
      .created(input.createdAt)
      .chain(includeSingletonTag(["d", `${appId}@${version}`], true))
      .modifyPublicTags((tags) => [
        ...tags,
        applicationTag,
        ["i", appId],
        ["version", version],
        ["c", channel],
        ...assetTags,
        ...platforms.map((platform) => ["f", platform]),
      ])
      .alt(`Software release: ${appId} ${version}`);
  }
}
