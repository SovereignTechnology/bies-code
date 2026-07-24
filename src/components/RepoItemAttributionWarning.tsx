import { Link } from "react-router-dom";
import { AlertTriangle, UsersRound } from "lucide-react";

import { Alert, AlertDescription, AlertTitle } from "@/components/ui/alert";
import { Button } from "@/components/ui/button";
import { cn } from "@/lib/utils";

export function RepoItemAttributionWarning({
  basePath,
  repoName,
  itemLabel,
  count,
  className,
}: {
  basePath: string;
  repoName: string;
  itemLabel: "issue" | "pull request" | "patch";
  count?: number;
  className?: string;
}) {
  const detail = count === undefined;
  const label =
    count === undefined
      ? `${itemLabel[0].toUpperCase()}${itemLabel.slice(1)}`
      : `${count} ${count === 1 ? "item has" : "items have"}`;

  return (
    <Alert
      className={cn(
        "border-amber-500/50 bg-gradient-to-r from-amber-500/10 via-background to-orange-500/10 text-foreground shadow-sm [&>svg]:text-amber-600 dark:[&>svg]:text-amber-400",
        className,
      )}
    >
      <AlertTriangle className="h-4 w-4" />
      <AlertTitle className="text-amber-950 dark:text-amber-100">
        {label} unconfirmed repository attribution
      </AlertTitle>
      <AlertDescription className="space-y-3 text-muted-foreground">
        <p>
          {detail ? "This item references" : "These items reference"} only an
          invited maintainer’s repository coordinate.{" "}
          {detail ? "It is" : "They are"} visible because Nostr discovery
          follows the full recursive maintainer graph, but the referenced
          maintainer has not linked back to the accepted maintainer group for{" "}
          <span className="font-medium text-foreground">{repoName}</span>. It
          may belong to a different repository with the same identifier.
        </p>
        <div className="flex flex-col gap-3 sm:flex-row sm:items-center sm:justify-between">
          <p className="text-xs leading-relaxed">
            To confirm the attribution, the invited maintainer must accept the
            relationship. If the invitation was unintended, the selected
            maintainer should remove it in repository settings.
          </p>
          <Button
            asChild
            variant="outline"
            size="sm"
            className="shrink-0 border-amber-500/50 bg-background/80"
          >
            <Link to={`${basePath}/about`}>
              <UsersRound className="mr-2 h-4 w-4" />
              Review maintainers
            </Link>
          </Button>
        </div>
      </AlertDescription>
    </Alert>
  );
}
