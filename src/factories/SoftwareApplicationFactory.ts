import { blankEventTemplate, EventFactory } from "applesauce-core/factories";
import {
  getTagValue,
  type KnownEventTemplate,
} from "applesauce-core/helpers/event";
import type { NostrEvent } from "nostr-tools";
import { SOFTWARE_APPLICATION_KIND } from "@/casts/Software";

type SoftwareApplicationTemplate = KnownEventTemplate<
  typeof SOFTWARE_APPLICATION_KIND
>;

export interface SoftwareApplicationInput {
  appId: string;
  name: string;
  description: string;
  summary?: string;
  icon?: string;
  images?: string[];
  topics?: string[];
  website?: string;
  repository?: string;
  repoCoordinates: string[];
  relayHint?: string;
  platforms?: string[];
  license?: string;
  createdAt: number;
  /** Existing addressable event whose unrecognised metadata must be retained. */
  baseEvent?: NostrEvent;
}

const MANAGED_APPLICATION_TAGS = new Set([
  "d",
  "name",
  "summary",
  "icon",
  "image",
  "t",
  "url",
  "repository",
  "a",
  "f",
  "license",
  "alt",
]);

function trimmed(value: string | undefined): string | undefined {
  return value?.trim() || undefined;
}

function uniqueValues(values: string[] | undefined): string[] {
  return [
    ...new Set((values ?? []).map((value) => value.trim()).filter(Boolean)),
  ];
}

export class SoftwareApplicationFactory extends EventFactory<
  typeof SOFTWARE_APPLICATION_KIND,
  SoftwareApplicationTemplate
> {
  static linkRepositories(
    event: NostrEvent,
    repoCoordinates: string[],
    relayHint: string | undefined,
    createdAt: number,
  ): SoftwareApplicationFactory {
    if (
      event.kind !== SOFTWARE_APPLICATION_KIND ||
      !getTagValue(event, "d") ||
      !getTagValue(event, "name")
    ) {
      throw new Error("Invalid software application event");
    }

    const tags = event.tags.map((tag) => [...tag]);
    const linkedCoordinates = new Set(
      tags
        .filter(([tagName, coordinate]) => tagName === "a" && !!coordinate)
        .map(([, coordinate]) => coordinate),
    );
    for (const coordinate of uniqueValues(repoCoordinates)) {
      if (linkedCoordinates.has(coordinate)) continue;
      tags.push(relayHint ? ["a", coordinate, relayHint] : ["a", coordinate]);
    }

    return new SoftwareApplicationFactory((resolve) =>
      resolve(blankEventTemplate(SOFTWARE_APPLICATION_KIND)),
    )
      .content(event.content)
      .created(createdAt)
      .modifyPublicTags(() => tags);
  }

  static create(input: SoftwareApplicationInput): SoftwareApplicationFactory {
    const appId = input.appId.trim();
    const name = input.name.trim();
    if (!appId) throw new Error("Application ID is required");
    if (!name) throw new Error("Application name is required");
    if (
      input.baseEvent &&
      (input.baseEvent.kind !== SOFTWARE_APPLICATION_KIND ||
        getTagValue(input.baseEvent, "d") !== appId)
    ) {
      throw new Error("Existing application coordinate does not match");
    }

    const repoCoordinates = uniqueValues(input.repoCoordinates);
    if (repoCoordinates.length === 0) {
      throw new Error("At least one repository coordinate is required");
    }

    const optionalTags: string[][] = [];
    const addOptionalTag = (tagName: string, value: string | undefined) => {
      const clean = trimmed(value);
      if (clean) optionalTags.push([tagName, clean]);
    };
    addOptionalTag("summary", input.summary);
    addOptionalTag("icon", input.icon);
    addOptionalTag("url", input.website);
    addOptionalTag("repository", input.repository);
    addOptionalTag("license", input.license);

    const repositoryTags = new Map<string, string[]>();
    for (const tag of input.baseEvent?.tags ?? []) {
      if (tag[0] === "a" && tag[1]) repositoryTags.set(tag[1], [...tag]);
    }
    for (const coordinate of repoCoordinates) {
      if (!repositoryTags.has(coordinate)) {
        repositoryTags.set(
          coordinate,
          input.relayHint
            ? ["a", coordinate, input.relayHint]
            : ["a", coordinate],
        );
      }
    }

    const preservedTags = (input.baseEvent?.tags ?? [])
      .filter(([tagName]) => !MANAGED_APPLICATION_TAGS.has(tagName))
      .map((tag) => [...tag]);

    return new SoftwareApplicationFactory((resolve) =>
      resolve(blankEventTemplate(SOFTWARE_APPLICATION_KIND)),
    )
      .content(input.description)
      .created(input.createdAt)
      .modifyPublicTags(() => [
        ["d", appId],
        ["name", name],
        ...optionalTags,
        ...uniqueValues(input.images).map((image) => ["image", image]),
        ...uniqueValues(input.topics).map((topic) => ["t", topic]),
        ...repositoryTags.values(),
        ...uniqueValues(input.platforms).map((platform) => ["f", platform]),
        ...preservedTags,
      ])
      .alt(`Software application: ${name}`);
  }
}
