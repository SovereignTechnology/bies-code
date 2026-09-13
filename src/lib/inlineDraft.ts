import { z } from "zod";
import type { InlineCommentLocation } from "@/factories/InlineCommentFactory";

const locationSchema = z.tuple([
  z.string(),
  z.string(),
  z.string(),
  z.enum(["", "del"]),
]);

export function inlineDraftPrefix(rootId: string, parentId: string) {
  return `inline:${rootId}:${parentId}:`;
}

export function inlineDraftScope(
  rootId: string,
  parentId: string,
  location: InlineCommentLocation,
) {
  return (
    inlineDraftPrefix(rootId, parentId) +
    JSON.stringify([
      location.filePath,
      location.commitId ?? "",
      location.line ?? "",
      location.lineSide ?? "",
    ])
  );
}

export function parseInlineDraftLocation(
  scope: string,
): InlineCommentLocation | null {
  try {
    const [filePath, commitId, line, lineSide] = locationSchema.parse(
      JSON.parse(scope.slice(scope.indexOf("["))),
    );
    return {
      filePath,
      commitId: commitId || undefined,
      line: line || undefined,
      lineSide: lineSide || undefined,
    };
  } catch {
    return null;
  }
}
