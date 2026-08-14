import { EventCast } from "applesauce-common/casts/cast";
import type { CastRefEventStore } from "applesauce-common/casts/cast";
import { getOrComputeCachedValue } from "applesauce-core/helpers";
import { getTagValue, type KnownEvent } from "applesauce-core/helpers/event";
import type { NostrEvent } from "nostr-tools";
import {
  CI_COORDINATOR_ADVERTISEMENT_KIND,
  CI_REPOSITORY_STATUS_KIND,
  CI_REQUEST_READINESS_KIND,
  CI_SERVICE_REQUEST_KIND,
  CI_SERVICE_STOP_KIND,
} from "@/lib/ci";
import { normalizeUrl } from "@/lib/url";

type CoordinatorAdvertisementEvent = KnownEvent<
  typeof CI_COORDINATOR_ADVERTISEMENT_KIND
>;
type RequestReadinessEvent = KnownEvent<typeof CI_REQUEST_READINESS_KIND>;
type RepositoryStatusEvent = KnownEvent<typeof CI_REPOSITORY_STATUS_KIND>;
type ServiceControlEvent = KnownEvent<
  typeof CI_SERVICE_REQUEST_KIND | typeof CI_SERVICE_STOP_KIND
>;

export type CIAdmissionPolicy =
  | "operator-selected"
  | "maintainer-request"
  | "open";
export type CIExecutionPolicy = "automatic" | "request-required";
export type CIBillingPolicy = "not-required" | "out-of-band";

export interface CISecretsRecipient {
  pubkey: string;
  relays: string[];
}

export interface CISecretInventoryItem {
  name: string;
  sourcePubkey: string | undefined;
  createdAt: number | undefined;
}

const ExpirationSymbol = Symbol.for("ci-coordinator-expiration");
const FamiliesSymbol = Symbol.for("ci-coordinator-families");
const SelectorsSymbol = Symbol.for("ci-coordinator-selectors");
const SecretRecipientSymbol = Symbol.for("ci-coordinator-secret-recipient");
const ReadinessCoordsSymbol = Symbol.for("ci-readiness-coordinates");
const ReadinessPubkeysSymbol = Symbol.for("ci-readiness-pubkeys");
const StatusCoordsSymbol = Symbol.for("ci-status-coordinates");
const StatusPathsSymbol = Symbol.for("ci-status-workflow-paths");
const StatusSecretsSymbol = Symbol.for("ci-status-secrets");

function tagsNamed(event: NostrEvent, name: string): string[][] {
  return event.tags.filter(([tagName]) => tagName === name);
}

function parseInteger(value: string | undefined): number | undefined {
  if (!value || !/^\d+$/.test(value)) return undefined;
  const parsed = Number.parseInt(value, 10);
  return Number.isSafeInteger(parsed) ? parsed : undefined;
}

function hasValidExpiration(event: NostrEvent, maxLifetime: number): boolean {
  const tags = tagsNamed(event, "expiration");
  const expiration = parseInteger(tags[0]?.[1]);
  return (
    tags.length === 1 &&
    expiration !== undefined &&
    expiration > event.created_at &&
    expiration <= event.created_at + maxLifetime
  );
}

function parseRelayUrl(value: string): string | undefined {
  try {
    const url = new URL(value);
    if (url.protocol !== "ws:" && url.protocol !== "wss:") return undefined;
    return normalizeUrl(value);
  } catch {
    return undefined;
  }
}

function uniqueFoldedTagValues(event: NostrEvent, name: string): string[] {
  return [
    ...new Set(
      tagsNamed(event, name)
        .map((tag) => tag[1]?.toLowerCase())
        .filter((value): value is string => !!value),
    ),
  ];
}

function hasValidCapabilities(event: NostrEvent): boolean {
  const families = uniqueFoldedTagValues(event, "W");
  const selectors = uniqueFoldedTagValues(event, "R");
  if (families.length === 0 || selectors.length === 0) return false;

  const selectorFamilies = new Set<string>();
  for (const selector of selectors) {
    const separator = selector.indexOf(":");
    if (separator <= 0 || separator === selector.length - 1) return false;
    const family = selector.slice(0, separator);
    if (!families.includes(family)) return false;
    selectorFamilies.add(family);
  }
  return families.every((family) => selectorFamilies.has(family));
}

function isExactSingleValueTag(event: NostrEvent, name: string): boolean {
  const tags = tagsNamed(event, name);
  return tags.length === 1 && tags[0].length === 2 && !!tags[0][1];
}

/** Structural validation for a kind:19843 live coordinator advertisement. */
export function isValidCICoordinatorAdvertisement(
  event: NostrEvent,
): event is CoordinatorAdvertisementEvent {
  if (
    event.kind !== CI_COORDINATOR_ADVERTISEMENT_KIND ||
    event.content !== "" ||
    tagsNamed(event, "d").length > 0 ||
    !isExactSingleValueTag(event, "M") ||
    !isExactSingleValueTag(event, "X") ||
    tagsNamed(event, "B").length > 1 ||
    tagsNamed(event, "secrets-key").length > 1 ||
    !hasValidExpiration(event, 30 * 60) ||
    !hasValidCapabilities(event)
  ) {
    return false;
  }

  const billing = tagsNamed(event, "B")[0];
  if (billing && (billing.length !== 2 || !billing[1])) return false;

  const secret = tagsNamed(event, "secrets-key")[0];
  if (!secret) return true;
  const secretRelays = secret.slice(3);
  const normalizedRelays = secretRelays.map(parseRelayUrl);
  return (
    secret.length >= 4 &&
    secret[1] === "nip44-v2" &&
    /^[0-9a-f]{64}$/.test(secret[2] ?? "") &&
    normalizedRelays.every(
      (relay, index) => relay !== undefined && relay === secretRelays[index],
    ) &&
    new Set(normalizedRelays).size === normalizedRelays.length
  );
}

export class CICoordinatorAdvertisement extends EventCast<CoordinatorAdvertisementEvent> {
  constructor(event: NostrEvent, store: CastRefEventStore) {
    if (!isValidCICoordinatorAdvertisement(event)) {
      throw new Error("Invalid CI coordinator advertisement");
    }
    super(event, store);
  }

  get pubkey(): string {
    return this.event.pubkey;
  }

  get expiration(): number {
    return getOrComputeCachedValue(
      this.event,
      ExpirationSymbol,
      () => parseInteger(getTagValue(this.event, "expiration"))!,
    );
  }

  get isLive(): boolean {
    return this.expiration > Math.floor(Date.now() / 1000);
  }

  get runnerFamilies(): string[] {
    return getOrComputeCachedValue(this.event, FamiliesSymbol, () =>
      uniqueFoldedTagValues(this.event, "W"),
    );
  }

  get runnerSelectors(): string[] {
    return getOrComputeCachedValue(this.event, SelectorsSymbol, () =>
      uniqueFoldedTagValues(this.event, "R"),
    );
  }

  get admissionPolicy(): CIAdmissionPolicy | undefined {
    const policy = getTagValue(this.event, "M");
    return policy === "operator-selected" ||
      policy === "maintainer-request" ||
      policy === "open"
      ? policy
      : undefined;
  }

  get executionPolicy(): CIExecutionPolicy | undefined {
    const policy = getTagValue(this.event, "X");
    return policy === "automatic" || policy === "request-required"
      ? policy
      : undefined;
  }

  get billingPolicy(): CIBillingPolicy | undefined {
    const policy = getTagValue(this.event, "B");
    return policy === "not-required" || policy === "out-of-band"
      ? policy
      : undefined;
  }

  get software(): string | undefined {
    return tagsNamed(this.event, "software")[0]?.[1];
  }

  get version(): string | undefined {
    return tagsNamed(this.event, "software")[0]?.[2];
  }

  get secretsRecipient(): CISecretsRecipient | undefined {
    return getOrComputeCachedValue(this.event, SecretRecipientSymbol, () => {
      const tag = tagsNamed(this.event, "secrets-key")[0];
      if (!tag) return undefined;
      const relays = tag
        .slice(3)
        .map(parseRelayUrl)
        .filter((relay): relay is string => !!relay);
      return { pubkey: tag[2], relays };
    });
  }
}

export function isValidCIRequestReadiness(
  event: NostrEvent,
): event is RequestReadinessEvent {
  const items = event.tags.filter(([name]) => name === "a" || name === "p");
  const validItems = items.every(([name, value, relay, ...rest]) => {
    if (!value || rest.length > 0) return false;
    if (name === "a" && !/^30617:[0-9a-f]{64}:.+$/.test(value)) return false;
    if (name === "p" && !/^[0-9a-f]{64}$/.test(value)) return false;
    return relay === undefined || parseRelayUrl(relay) === relay;
  });
  return (
    event.kind === CI_REQUEST_READINESS_KIND &&
    event.content === "" &&
    tagsNamed(event, "d").length === 0 &&
    validItems &&
    new Set(items.map((tag) => JSON.stringify(tag))).size === items.length &&
    hasValidExpiration(event, 24 * 60 * 60)
  );
}

export class CIRequestReadiness extends EventCast<RequestReadinessEvent> {
  constructor(event: NostrEvent, store: CastRefEventStore) {
    if (!isValidCIRequestReadiness(event)) {
      throw new Error("Invalid CI request-readiness list");
    }
    super(event, store);
  }

  get pubkey(): string {
    return this.event.pubkey;
  }

  get expiration(): number {
    return parseInteger(getTagValue(this.event, "expiration"))!;
  }

  get repositoryCoordinates(): string[] {
    return getOrComputeCachedValue(this.event, ReadinessCoordsSymbol, () =>
      tagsNamed(this.event, "a")
        .filter((tag) => tag.length === 2 || tag.length === 3)
        .map((tag) => tag[1])
        .filter((value): value is string => !!value),
    );
  }

  get repositoryPubkeys(): string[] {
    return getOrComputeCachedValue(this.event, ReadinessPubkeysSymbol, () =>
      tagsNamed(this.event, "p")
        .filter((tag) => tag.length === 2 || tag.length === 3)
        .map((tag) => tag[1])
        .filter((value): value is string => /^[0-9a-f]{64}$/.test(value)),
    );
  }

  supportsRepository(coordinates: string[], maintainers: string[]): boolean {
    const coordinateSet = new Set(coordinates);
    const maintainerSet = new Set(maintainers);
    return (
      this.repositoryCoordinates.some((coord) => coordinateSet.has(coord)) ||
      this.repositoryPubkeys.some((pubkey) => maintainerSet.has(pubkey))
    );
  }
}

export function isValidCIRepositoryStatus(
  event: NostrEvent,
): event is RepositoryStatusEvent {
  const dTags = tagsNamed(event, "d");
  const statusTags = tagsNamed(event, "s");
  const coordinates = tagsNamed(event, "a");
  const secrets = tagsNamed(event, "secret");
  const validSecrets = secrets.every(([, name, source, createdAt, ...rest]) => {
    if (!name || !/^[A-Z_][A-Z0-9_]*$/.test(name) || rest.length > 0) {
      return false;
    }
    if (source === undefined) return createdAt === undefined;
    return (
      /^[0-9a-f]{64}$/.test(source) && parseInteger(createdAt) !== undefined
    );
  });
  return (
    event.kind === CI_REPOSITORY_STATUS_KIND &&
    event.content === "" &&
    dTags.length === 1 &&
    !!dTags[0][1] &&
    statusTags.length === 1 &&
    statusTags[0][1] === "acting" &&
    coordinates.length > 0 &&
    coordinates[0][1] === dTags[0][1] &&
    validSecrets &&
    hasValidExpiration(event, 24 * 60 * 60) &&
    hasValidCapabilities(event)
  );
}

export class CIRepositoryStatus extends EventCast<RepositoryStatusEvent> {
  constructor(event: NostrEvent, store: CastRefEventStore) {
    if (!isValidCIRepositoryStatus(event)) {
      throw new Error("Invalid CI repository status");
    }
    super(event, store);
  }

  get pubkey(): string {
    return this.event.pubkey;
  }

  get expiration(): number {
    return getOrComputeCachedValue(
      this.event,
      ExpirationSymbol,
      () => parseInteger(getTagValue(this.event, "expiration"))!,
    );
  }

  get selectedCoordinate(): string {
    return getTagValue(this.event, "d")!;
  }

  get repositoryCoordinates(): string[] {
    return getOrComputeCachedValue(this.event, StatusCoordsSymbol, () =>
      tagsNamed(this.event, "a")
        .map((tag) => tag[1])
        .filter((value): value is string => !!value),
    );
  }

  get runnerFamilies(): string[] {
    return getOrComputeCachedValue(this.event, FamiliesSymbol, () =>
      uniqueFoldedTagValues(this.event, "W"),
    );
  }

  get runnerSelectors(): string[] {
    return getOrComputeCachedValue(this.event, SelectorsSymbol, () =>
      uniqueFoldedTagValues(this.event, "R"),
    );
  }

  get workflowPaths(): string[] {
    return getOrComputeCachedValue(this.event, StatusPathsSymbol, () => [
      ...new Set(
        tagsNamed(this.event, "workflow-path")
          .map((tag) => tag[1])
          .filter((value): value is string => !!value),
      ),
    ]);
  }

  get secrets(): CISecretInventoryItem[] {
    return getOrComputeCachedValue(this.event, StatusSecretsSymbol, () =>
      tagsNamed(this.event, "secret").flatMap((tag) => {
        const name = tag[1];
        if (!name) return [];
        const sourcePubkey = /^[0-9a-f]{64}$/.test(tag[2] ?? "")
          ? tag[2]
          : undefined;
        const createdAt = sourcePubkey ? parseInteger(tag[3]) : undefined;
        return [{ name, sourcePubkey, createdAt }];
      }),
    );
  }

  matchesRepository(coordinates: string[]): boolean {
    const coordinateSet = new Set(coordinates);
    return this.repositoryCoordinates.some((coord) => coordinateSet.has(coord));
  }
}

export function isValidCIServiceControl(
  event: NostrEvent,
): event is ServiceControlEvent {
  const repoTags = tagsNamed(event, "a");
  const coordinatorTags = tagsNamed(event, "p");
  return (
    (event.kind === CI_SERVICE_REQUEST_KIND ||
      event.kind === CI_SERVICE_STOP_KIND) &&
    event.content === "" &&
    repoTags.length === 1 &&
    (repoTags[0].length === 2 || repoTags[0].length === 3) &&
    /^30617:[0-9a-f]{64}:.+$/.test(repoTags[0][1] ?? "") &&
    (repoTags[0][2] === undefined ||
      parseRelayUrl(repoTags[0][2]) === repoTags[0][2]) &&
    coordinatorTags.length === 1 &&
    coordinatorTags[0].length === 2 &&
    /^[0-9a-f]{64}$/.test(coordinatorTags[0][1] ?? "") &&
    tagsNamed(event, "d").length === 0 &&
    tagsNamed(event, "expiration").length === 0
  );
}

export class CIServiceControl extends EventCast<ServiceControlEvent> {
  constructor(event: NostrEvent, store: CastRefEventStore) {
    if (!isValidCIServiceControl(event)) {
      throw new Error("Invalid CI service control");
    }
    super(event, store);
  }

  get coordinatorPubkey(): string {
    return getTagValue(this.event, "p")!;
  }

  get repositoryCoordinate(): string {
    return getTagValue(this.event, "a")!;
  }

  get isRequest(): boolean {
    return this.event.kind === CI_SERVICE_REQUEST_KIND;
  }
}
