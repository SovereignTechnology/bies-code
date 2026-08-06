import { blankEventTemplate, EventFactory } from "applesauce-core/factories";
import type { KnownEventTemplate } from "applesauce-core/helpers/event";
import { includeSingletonTag } from "applesauce-core/operations/tags";
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
}

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
  static create(input: SoftwareApplicationInput): SoftwareApplicationFactory {
    const appId = input.appId.trim();
    const name = input.name.trim();
    if (!appId) throw new Error("Application ID is required");
    if (!name) throw new Error("Application name is required");

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

    return new SoftwareApplicationFactory((resolve) =>
      resolve(blankEventTemplate(SOFTWARE_APPLICATION_KIND)),
    )
      .content(input.description)
      .created(input.createdAt)
      .chain(includeSingletonTag(["d", appId], true))
      .modifyPublicTags((tags) => [
        ...tags,
        ["name", name],
        ...optionalTags,
        ...uniqueValues(input.images).map((image) => ["image", image]),
        ...uniqueValues(input.topics).map((topic) => ["t", topic]),
        ...repoCoordinates.map((coordinate) =>
          input.relayHint
            ? ["a", coordinate, input.relayHint]
            : ["a", coordinate],
        ),
        ...uniqueValues(input.platforms).map((platform) => ["f", platform]),
      ])
      .alt(`Software application: ${name}`);
  }
}
