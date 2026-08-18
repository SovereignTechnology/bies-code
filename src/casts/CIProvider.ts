import { EventCast } from "applesauce-common/casts/cast";
import type { CastRefEventStore } from "applesauce-common/casts/cast";
import { getOrComputeCachedValue } from "applesauce-core/helpers";
import type { KnownEvent } from "applesauce-core/helpers/event";
import type { NostrEvent } from "nostr-tools";
import { CI_NIX_PROVIDER_ADVERTISEMENT_KIND } from "@/lib/ci";

type CIProviderAdvertisementEvent = KnownEvent<
  typeof CI_NIX_PROVIDER_ADVERTISEMENT_KIND
>;

const ExpirationSymbol = Symbol.for("ci-provider-expiration");
const FamiliesSymbol = Symbol.for("ci-provider-families");
const SelectorsSymbol = Symbol.for("ci-provider-selectors");

function tagValues(event: NostrEvent, name: string): string[] {
  return [
    ...new Set(
      event.tags
        .filter(([tagName, value]) => tagName === name && !!value)
        .map(([, value]) => value.toLowerCase()),
    ),
  ];
}

function parseExpiration(event: NostrEvent): number | undefined {
  const tags = event.tags.filter(([name]) => name === "expiration");
  if (tags.length !== 1 || !/^\d+$/.test(tags[0][1] ?? "")) return undefined;
  const expiration = Number.parseInt(tags[0][1], 10);
  return Number.isSafeInteger(expiration) && expiration > event.created_at
    ? expiration
    : undefined;
}

/** Structural validation for a kind:19845 Nix provider advertisement. */
export function isValidCIProviderAdvertisement(
  event: NostrEvent,
): event is CIProviderAdvertisementEvent {
  if (
    event.kind !== CI_NIX_PROVIDER_ADVERTISEMENT_KIND ||
    event.content !== "" ||
    parseExpiration(event) === undefined
  ) {
    return false;
  }

  const families = tagValues(event, "W");
  const selectors = tagValues(event, "R");
  return families.length > 0 && selectors.length > 0;
}

export class CIProviderAdvertisement extends EventCast<CIProviderAdvertisementEvent> {
  constructor(event: NostrEvent, store: CastRefEventStore) {
    if (!isValidCIProviderAdvertisement(event)) {
      throw new Error("Invalid CI provider advertisement");
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
      () => parseExpiration(this.event)!,
    );
  }

  get isLive(): boolean {
    return this.expiration > Math.floor(Date.now() / 1000);
  }

  get runnerFamilies(): string[] {
    return getOrComputeCachedValue(this.event, FamiliesSymbol, () =>
      tagValues(this.event, "W"),
    );
  }

  get runnerSelectors(): string[] {
    return getOrComputeCachedValue(this.event, SelectorsSymbol, () =>
      tagValues(this.event, "R"),
    );
  }
}
