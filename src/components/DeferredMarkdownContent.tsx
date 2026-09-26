import { lazy } from "react";
import type { MarkdownContentProps } from "@/components/MarkdownContent";
import {
  getLoadedMarkdownContent,
  loadMarkdownContent,
} from "@/lib/markdownContentLoader";

const LazyMarkdownContent = lazy(loadMarkdownContent);

/**
 * Render Markdown synchronously once preloaded, with Suspense-compatible lazy
 * loading as a fallback for consumers outside the repository route boundary.
 */
export default function DeferredMarkdownContent(props: MarkdownContentProps) {
  const MarkdownContent = getLoadedMarkdownContent();
  return MarkdownContent ? (
    <MarkdownContent {...props} />
  ) : (
    <LazyMarkdownContent {...props} />
  );
}
