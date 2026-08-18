import { useMemo, type ReactNode } from "react";
import { ExternalLink, Globe2, ShieldAlert } from "lucide-react";
import { Button } from "@/components/ui/button";
import { Card, CardContent } from "@/components/ui/card";
import type { PRCIChecks } from "@/hooks/useCI";
import { findNsitePreview, type NsitePreview } from "@/lib/ciOutputs";
import { cn } from "@/lib/utils";

interface PRNsitePreviewProps {
  checks: PRCIChecks;
  className?: string;
}

/** Compact external link used beside commits and collapsed workflow rows. */
export function NsitePreviewLink({
  preview,
  children = "Open nsite preview",
  className,
}: {
  preview: NsitePreview;
  children?: ReactNode;
  className?: string;
}) {
  return (
    <a
      href={preview.url}
      target="_blank"
      rel="noopener noreferrer"
      data-ci-output={preview.name}
      className={cn(
        "inline-flex items-center gap-1 text-xs font-medium text-pink-600 underline-offset-2 hover:text-pink-700 hover:underline dark:text-pink-400 dark:hover:text-pink-300",
        className,
      )}
    >
      {children}
      <ExternalLink className="h-3 w-3 shrink-0" aria-hidden="true" />
    </a>
  );
}

/** Prominent PR-level link for an nsite published by the latest successful CI. */
export function PRNsitePreview({ checks, className }: PRNsitePreviewProps) {
  const preview = useMemo(
    () => findNsitePreview(checks.currentRuns),
    [checks.currentRuns],
  );
  if (!preview) return null;

  return (
    <Card
      className={cn(
        "overflow-hidden border-pink-500/25 bg-gradient-to-br from-pink-500/[0.09] via-background to-violet-500/[0.07] shadow-sm",
        className,
      )}
    >
      <CardContent className="p-4 sm:p-5">
        <div className="flex flex-col gap-4 sm:flex-row sm:items-center">
          <div className="flex min-w-0 flex-1 items-start gap-3">
            <div className="flex h-10 w-10 shrink-0 items-center justify-center rounded-xl border border-pink-500/20 bg-gradient-to-br from-pink-500/20 to-violet-500/15 text-pink-600 dark:text-pink-400">
              <Globe2 className="h-5 w-5" aria-hidden="true" />
            </div>
            <div className="min-w-0">
              <p className="font-semibold text-foreground">
                Pull request preview
              </p>
              <p className="mt-0.5 text-sm text-muted-foreground">
                CI published the current pull request build as an nsite.
              </p>
              <p className="mt-1 truncate font-mono text-xs text-muted-foreground/80">
                {preview.hostname}
              </p>
            </div>
          </div>

          <Button asChild className="w-full gap-2 sm:w-auto">
            <a
              href={preview.url}
              target="_blank"
              rel="noopener noreferrer"
              data-ci-output={preview.name}
            >
              Open nsite preview
              <ExternalLink className="h-4 w-4" aria-hidden="true" />
            </a>
          </Button>
        </div>

        <div className="mt-4 flex items-start gap-2 border-t border-amber-500/20 pt-3 text-xs leading-relaxed text-muted-foreground">
          <ShieldAlert
            className="mt-0.5 h-4 w-4 shrink-0 text-amber-600 dark:text-amber-400"
            aria-hidden="true"
          />
          <p>
            This preview contains contributor-controlled code and content. Open
            it as an untrusted external site.
          </p>
        </div>
      </CardContent>
    </Card>
  );
}
