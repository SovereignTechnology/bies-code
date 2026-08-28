import { describe, expect, it } from "vitest";

import { getRepositoryLeadRedirectPath } from "@/lib/repositoryLeadRoute";
import { repoToPath } from "@/lib/routeUtils";

const selected = "a".repeat(64);
const lead = "b".repeat(64);
const dTag = "repo/with spaces";
const relayHints = ["wss://relay.example.com/grasp"];
const pageSuffix = "/tree/feature%2Ftopic/src/file.ts";
const search = "?view=split&line=12";
const hash = "#discussion";

function redirect(
  source:
    | "explicit"
    | "legacy_inferred"
    | "implicit_sole"
    | "explicit_none"
    | "none"
    | "pending"
    | "conflict",
  announcementsSettled = true,
) {
  return getRepositoryLeadRedirectPath({
    selectedPubkey: selected,
    dTag,
    relayHints,
    pageSuffix,
    search,
    hash,
    leadResolution: {
      leadMaintainer: lead,
      source,
      path: [selected, lead],
    },
    announcementsSettled,
  });
}

describe("repository lead redirects", () => {
  it.each(["explicit", "legacy_inferred"] as const)(
    "preserves the complete URL for a settled %s lead",
    (source) => {
      expect(redirect(source)).toBe(
        `${repoToPath(lead, dTag, relayHints)}${pageSuffix}${search}${hash}`,
      );
    },
  );

  it.each(["explicit", "legacy_inferred"] as const)(
    "does not redirect an unsettled %s result",
    (source) => {
      expect(redirect(source, false)).toBeUndefined();
    },
  );

  it.each([
    "implicit_sole",
    "explicit_none",
    "none",
    "pending",
    "conflict",
  ] as const)("does not redirect a %s result", (source) => {
    expect(redirect(source)).toBeUndefined();
  });

  it("does not redirect when the selected coordinate is already the lead", () => {
    expect(
      getRepositoryLeadRedirectPath({
        selectedPubkey: lead,
        dTag,
        relayHints,
        pageSuffix,
        search,
        hash,
        leadResolution: {
          leadMaintainer: lead,
          source: "explicit",
          path: [lead],
        },
        announcementsSettled: true,
      }),
    ).toBeUndefined();
  });
});
