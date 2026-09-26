import type { CIWorkflowRun } from "@/lib/ci";

export interface NsitePreview {
  name: string;
  url: string;
  hostname: string;
  run: CIWorkflowRun;
  job: CIWorkflowRun["jobs"][number];
}

const NSITE_OUTPUT_NAME_RE = /^nsite(?:_|$)/;

/** Parse an untrusted public output as a credential-free web URL. */
export function parsePublicOutputUrl(value: string): URL | undefined {
  try {
    const url = new URL(value);
    if (
      (url.protocol !== "https:" && url.protocol !== "http:") ||
      url.username.length > 0 ||
      url.password.length > 0
    ) {
      return undefined;
    }
    return url;
  } catch {
    return undefined;
  }
}

/** Find the newest successful nsite output in a newest-first run list. */
export function findNsitePreview(
  runs: readonly CIWorkflowRun[],
): NsitePreview | undefined {
  for (const run of runs) {
    for (const job of run.jobs) {
      const { result } = job;
      if (result.status !== "success") continue;

      for (const output of result.outputs) {
        if (!NSITE_OUTPUT_NAME_RE.test(output.name)) continue;

        const url = parsePublicOutputUrl(output.value);
        if (!url || url.protocol !== "https:") continue;

        return {
          name: output.name,
          url: url.toString(),
          hostname: url.hostname,
          run,
          job,
        };
      }
    }
  }

  return undefined;
}

/** Index the newest successful nsite preview for every commit with CI runs. */
export function indexNsitePreviewsByCommit(
  runs: readonly CIWorkflowRun[],
): ReadonlyMap<string, NsitePreview> {
  const previews = new Map<string, NsitePreview>();
  for (const run of runs) {
    if (!run.commitId || previews.has(run.commitId)) continue;
    const preview = findNsitePreview([run]);
    if (preview) previews.set(run.commitId, preview);
  }
  return previews;
}
