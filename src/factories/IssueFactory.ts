/**
 * IssueFactory — NIP-34 git issue (kind 1621).
 *
 * Replaces v5 `IssueBlueprint` + `src/operations/issue.ts`.
 *
 * Usage:
 * ```ts
 * import { IssueFactory } from "@/factories/IssueFactory";
 *
 * const signed = await IssueFactory
 *   .create(repoCoords, subject, content, { labels: ["bug"] })
 *   .sign(signer);
 * ```
 */

import { blankEventTemplate, EventFactory } from "applesauce-core/factories";
import { includeContentHashtags } from "applesauce-core/operations/content";
import {
  addAddressPointerTag,
  addNameValueTag,
  addProfilePointerTag,
} from "applesauce-core/operations/tag/common";
import { ISSUE_KIND, pubkeyFromCoordinate } from "@/lib/nip34";
import { getPubkeyRelayHint } from "./hints";
import type { NostrTag } from "@/lib/nostrContentTags";
import type { KnownEventTemplate } from "applesauce-core/helpers/event";

export interface IssueOptions {
  /** Optional labels to attach as `t` tags */
  labels?: string[];
  /**
   * Extra tags derived from NIP-19 references in the issue body.
   * Use `extractContentTags(content)` to generate these.
   * Produces `p` tags for profile mentions and `q` tags for event/address references.
   */
  contentTags?: NostrTag[];
  /**
   * Additional raw tags to append verbatim (e.g. NIP-94 `imeta` tags from
   * Blossom uploads). Each element is a tag tuple like `["imeta", "url ...", ...]`.
   */
  extraTags?: string[][];
}

type IssueTemplate = KnownEventTemplate<typeof ISSUE_KIND>;

export class IssueFactory extends EventFactory<
  typeof ISSUE_KIND,
  IssueTemplate
> {
  /**
   * Create a new NIP-34 git issue factory.
   *
   * @param repoCoords - Ordered repository coordinates, selected maintainer first
   * @param subject    - Issue title / subject line
   * @param content    - Markdown body of the issue
   * @param options    - Optional: labels, contentTags, extraTags
   */
  static create(
    repoCoords: string[],
    subject: string,
    content: string,
    options?: IssueOptions,
  ): IssueFactory {
    const uniqueRepoCoords = [...new Set(repoCoords)];
    if (uniqueRepoCoords.length === 0) {
      throw new Error("At least one repository coordinate is required");
    }

    const ownerPubkeys = [
      ...new Set(
        uniqueRepoCoords
          .map(pubkeyFromCoordinate)
          .filter((pubkey): pubkey is string => pubkey !== undefined),
      ),
    ];

    let factory = new IssueFactory((resolve) =>
      resolve(blankEventTemplate(ISSUE_KIND)),
    )
      .content(content)
      .modifyPublicTags(
        ...uniqueRepoCoords.map((coord) =>
          addAddressPointerTag(coord, getPubkeyRelayHint),
        ),
        ...ownerPubkeys.map((pubkey) =>
          addProfilePointerTag(pubkey, getPubkeyRelayHint),
        ),
      )
      .modifyPublicTags((tags) => [...tags, ["subject", subject]])
      .chain(includeContentHashtags())
      .alt(`Git issue: ${subject}`);

    const labels = options?.labels ?? [];
    if (labels.length > 0) {
      factory = factory.modifyPublicTags(
        ...labels.map((label) => addNameValueTag(["t", label])),
      );
    }

    const contentTags = options?.contentTags ?? [];
    if (contentTags.length > 0) {
      factory = factory.modifyPublicTags((tags) => [...tags, ...contentTags]);
    }

    const extraTags = options?.extraTags ?? [];
    if (extraTags.length > 0) {
      factory = factory.modifyPublicTags((tags) => [...tags, ...extraTags]);
    }

    return factory;
  }

  /** Add a single label (`t` tag). */
  label(label: string): this {
    return this.modifyPublicTags(addNameValueTag(["t", label]));
  }

  /** Add raw tag tuples (e.g. NIP-94 `imeta` tags). */
  extraTags(extraTags: string[][]): this {
    if (extraTags.length === 0) return this;
    return this.modifyPublicTags((tags) => [...tags, ...extraTags]);
  }
}
