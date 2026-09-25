import type { ComponentType } from "react";
import type { MarkdownContentProps } from "@/components/MarkdownContent";

export type MarkdownContentModule = {
  default: ComponentType<MarkdownContentProps>;
};

let loadedModule: MarkdownContentModule | undefined;
let modulePromise: Promise<MarkdownContentModule> | undefined;

export function loadMarkdownContent(): Promise<MarkdownContentModule> {
  modulePromise ??= import("@/components/MarkdownContent").then((module) => {
    loadedModule = module;
    return module;
  });
  return modulePromise;
}

export function getLoadedMarkdownContent():
  | ComponentType<MarkdownContentProps>
  | undefined {
  return loadedModule?.default;
}

/** Warm the dedicated Markdown renderer chunk without rendering it. */
export async function preloadMarkdownContent(): Promise<void> {
  await loadMarkdownContent();
}
