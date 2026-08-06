import type { CastRefEventStore } from "applesauce-common/casts/cast";
import { EventCast } from "applesauce-common/casts/cast";
import {
  getOrComputeCachedValue,
  parseReplaceableAddress,
} from "applesauce-core/helpers";
import { getTagValue, type KnownEvent } from "applesauce-core/helpers/event";
import type { NostrEvent } from "nostr-tools";

export const SOFTWARE_APPLICATION_KIND = 32267 as const;
export const SOFTWARE_RELEASE_KIND = 30063 as const;
export const SOFTWARE_ASSET_KIND = 3063 as const;

type SoftwareApplicationEvent = KnownEvent<typeof SOFTWARE_APPLICATION_KIND>;
type SoftwareReleaseEvent = KnownEvent<typeof SOFTWARE_RELEASE_KIND>;
type SoftwareAssetEvent = KnownEvent<typeof SOFTWARE_ASSET_KIND>;

const ApplicationIdSymbol = Symbol.for("software-application-id");
const ApplicationNameSymbol = Symbol.for("software-application-name");
const ApplicationRepoCoordsSymbol = Symbol.for(
  "software-application-repo-coords",
);
const ApplicationCoordinateSymbol = Symbol.for(
  "software-application-coordinate",
);
const ReleaseAppIdSymbol = Symbol.for("software-release-app-id");
const ReleaseApplicationCoordinateSymbol = Symbol.for(
  "software-release-application-coordinate",
);
const ReleaseVersionSymbol = Symbol.for("software-release-version");
const ReleaseChannelSymbol = Symbol.for("software-release-channel");
const ReleaseAssetsSymbol = Symbol.for("software-release-assets");
const AssetAppIdSymbol = Symbol.for("software-asset-app-id");
const AssetVersionSymbol = Symbol.for("software-asset-version");
const AssetMimeTypeSymbol = Symbol.for("software-asset-mime-type");
const AssetHashSymbol = Symbol.for("software-asset-hash");
const AssetPlatformsSymbol = Symbol.for("software-asset-platforms");
const AssetSizeSymbol = Symbol.for("software-asset-size");
const AssetUrlSymbol = Symbol.for("software-asset-url");
const AssetFilenameSymbol = Symbol.for("software-asset-filename");
const HEX_64 = /^[0-9a-f]{64}$/i;
const DIGITS_ONLY = /^\d+$/;

export interface SoftwareAssetPointer {
  id: string;
  relayHint?: string;
}

function repeatedTagValues(event: NostrEvent, name: string): string[] {
  return event.tags
    .filter(([tagName, value]) => tagName === name && !!value)
    .map(([, value]) => value);
}

function isHex64(value: string | undefined): value is string {
  return !!value && HEX_64.test(value);
}

function safeHttpUrl(value: string | undefined): string | undefined {
  if (!value) return undefined;
  try {
    const url = new URL(value);
    return url.protocol === "https:" || url.protocol === "http:"
      ? url.href
      : undefined;
  } catch {
    return undefined;
  }
}

function extensionForMimeType(mimeType: string): string {
  switch (mimeType) {
    case "application/vnd.android.package-archive":
      return ".apk";
    case "application/vnd.apple.ipa":
      return ".ipa";
    case "application/x-apple-diskimage":
      return ".dmg";
    case "application/vnd.appimage":
      return ".AppImage";
    case "application/wasm":
      return ".wasm";
    default:
      return "";
  }
}

export function isValidSoftwareApplication(
  event: NostrEvent,
): event is SoftwareApplicationEvent {
  return (
    event.kind === SOFTWARE_APPLICATION_KIND &&
    !!getTagValue(event, "d") &&
    !!getTagValue(event, "name")
  );
}

export function isValidSoftwareRelease(
  event: NostrEvent,
): event is SoftwareReleaseEvent {
  const appId = getTagValue(event, "i");
  const version = getTagValue(event, "version");
  return (
    event.kind === SOFTWARE_RELEASE_KIND &&
    !!appId &&
    !!version &&
    getTagValue(event, "d") === `${appId}@${version}` &&
    !!getTagValue(event, "c") &&
    event.tags.some(([name, id]) => name === "e" && isHex64(id))
  );
}

export function isValidSoftwareAsset(
  event: NostrEvent,
): event is SoftwareAssetEvent {
  return (
    event.kind === SOFTWARE_ASSET_KIND &&
    !!getTagValue(event, "i") &&
    !!getTagValue(event, "version") &&
    !!getTagValue(event, "m") &&
    isHex64(getTagValue(event, "x"))
  );
}

/** Typed view of a NIP-82 kind:32267 Software Application event. */
export class SoftwareApplication extends EventCast<SoftwareApplicationEvent> {
  constructor(event: NostrEvent, store: CastRefEventStore) {
    if (!isValidSoftwareApplication(event)) {
      throw new Error("Invalid software application event");
    }
    super(event, store);
  }

  get pubkey(): string {
    return this.event.pubkey;
  }

  get appId(): string {
    return getOrComputeCachedValue(
      this.event,
      ApplicationIdSymbol,
      () => getTagValue(this.event, "d")!,
    );
  }

  get name(): string {
    return getOrComputeCachedValue(
      this.event,
      ApplicationNameSymbol,
      () => getTagValue(this.event, "name")!,
    );
  }

  get repoCoords(): string[] {
    return getOrComputeCachedValue(
      this.event,
      ApplicationRepoCoordsSymbol,
      () => repeatedTagValues(this.event, "a"),
    );
  }

  get coordinate(): string {
    return getOrComputeCachedValue(
      this.event,
      ApplicationCoordinateSymbol,
      () => `${SOFTWARE_APPLICATION_KIND}:${this.pubkey}:${this.appId}`,
    );
  }
}

/** Typed view of a NIP-82 kind:30063 Software Release event. */
export class SoftwareRelease extends EventCast<SoftwareReleaseEvent> {
  constructor(event: NostrEvent, store: CastRefEventStore) {
    if (!isValidSoftwareRelease(event)) {
      throw new Error("Invalid software release event");
    }
    super(event, store);
  }

  get pubkey(): string {
    return this.event.pubkey;
  }

  get appId(): string {
    return getOrComputeCachedValue(
      this.event,
      ReleaseAppIdSymbol,
      () => getTagValue(this.event, "i")!,
    );
  }

  get applicationCoordinate(): string {
    return getOrComputeCachedValue(
      this.event,
      ReleaseApplicationCoordinateSymbol,
      () => {
        for (const [name, address] of this.event.tags) {
          if (name !== "a" || !address) continue;
          const pointer = parseReplaceableAddress(address, true);
          if (
            pointer?.kind === SOFTWARE_APPLICATION_KIND &&
            pointer.identifier === this.appId
          ) {
            return `${SOFTWARE_APPLICATION_KIND}:${pointer.pubkey.toLowerCase()}:${pointer.identifier}`;
          }
        }

        return `${SOFTWARE_APPLICATION_KIND}:${this.pubkey}:${this.appId}`;
      },
    );
  }

  get version(): string {
    return getOrComputeCachedValue(
      this.event,
      ReleaseVersionSymbol,
      () => getTagValue(this.event, "version")!,
    );
  }

  get channel(): string {
    return getOrComputeCachedValue(
      this.event,
      ReleaseChannelSymbol,
      () => getTagValue(this.event, "c")!,
    );
  }

  get notes(): string {
    return this.event.content;
  }

  get assets(): SoftwareAssetPointer[] {
    return getOrComputeCachedValue(this.event, ReleaseAssetsSymbol, () =>
      this.event.tags.flatMap(([name, id, relayHint]) =>
        name === "e" && isHex64(id)
          ? [{ id, relayHint: relayHint || undefined }]
          : [],
      ),
    );
  }
}

/** Typed view of a NIP-82 kind:3063 Software Asset event. */
export class SoftwareAsset extends EventCast<SoftwareAssetEvent> {
  constructor(event: NostrEvent, store: CastRefEventStore) {
    if (!isValidSoftwareAsset(event)) {
      throw new Error("Invalid software asset event");
    }
    super(event, store);
  }

  get appId(): string {
    return getOrComputeCachedValue(
      this.event,
      AssetAppIdSymbol,
      () => getTagValue(this.event, "i")!,
    );
  }

  get version(): string {
    return getOrComputeCachedValue(
      this.event,
      AssetVersionSymbol,
      () => getTagValue(this.event, "version")!,
    );
  }

  get mimeType(): string {
    return getOrComputeCachedValue(
      this.event,
      AssetMimeTypeSymbol,
      () => getTagValue(this.event, "m")!,
    );
  }

  get sha256(): string {
    return getOrComputeCachedValue(
      this.event,
      AssetHashSymbol,
      () => getTagValue(this.event, "x")!,
    );
  }

  get platforms(): string[] {
    return getOrComputeCachedValue(this.event, AssetPlatformsSymbol, () =>
      repeatedTagValues(this.event, "f"),
    );
  }

  get size(): number | undefined {
    return getOrComputeCachedValue(this.event, AssetSizeSymbol, () => {
      const value = getTagValue(this.event, "size");
      if (!value || !DIGITS_ONLY.test(value)) return undefined;
      const parsed = Number(value);
      return Number.isSafeInteger(parsed) && parsed >= 0 ? parsed : undefined;
    });
  }

  get downloadUrl(): string | undefined {
    return getOrComputeCachedValue(this.event, AssetUrlSymbol, () =>
      safeHttpUrl(getTagValue(this.event, "url")),
    );
  }

  get filename(): string {
    return getOrComputeCachedValue(this.event, AssetFilenameSymbol, () => {
      const explicit = getTagValue(this.event, "filename");
      if (explicit) return explicit;

      if (this.downloadUrl) {
        try {
          const pathPart = new URL(this.downloadUrl).pathname.split("/").pop();
          if (pathPart && pathPart !== this.sha256) {
            return decodeURIComponent(pathPart);
          }
        } catch {
          // downloadUrl has already been validated; use the stable fallback.
        }
      }

      return `${this.appId}-${this.version}${extensionForMimeType(this.mimeType)}`;
    });
  }
}
