import { Link } from "react-router-dom";
import { GitBranch, HelpCircle } from "lucide-react";
import { eventIdToNevent } from "@/lib/routeUtils";
import { cn } from "@/lib/utils";
import type {
  InferredPRParent,
  InferredPRParentRelation,
} from "@/lib/inferredPRParents";

export function InferredPRStackMap({
  relation,
  items,
  currentRootId,
  repoPath,
  relayHints,
  layer,
  ambiguousChildren = [],
  branchedChildren = [],
}: {
  relation: InferredPRParentRelation | undefined;
  items: InferredPRParent[];
  currentRootId: string;
  repoPath: string;
  relayHints: string[];
  layer?: { position: number; size: number };
  ambiguousChildren?: InferredPRParent[];
  branchedChildren?: InferredPRParent[];
}) {
  const ambiguous = relation?.status === "ambiguous";
  const reverseAmbiguous = !ambiguous && ambiguousChildren.length > 0;
  const branched =
    !ambiguous && !reverseAmbiguous && branchedChildren.length > 1;
  const displayedItems = ambiguous
    ? relation.parents
    : reverseAmbiguous
      ? ambiguousChildren
      : branched
        ? [...items, ...branchedChildren]
        : items;

  return (
    <div
      className={
        ambiguous || reverseAmbiguous
          ? "border-b border-amber-500/30 bg-amber-500/5"
          : "border-b border-primary/20 bg-primary/5"
      }
    >
      <div className="container max-w-screen-xl px-4 py-3 md:px-8">
        <div className="grid gap-2 lg:grid-cols-[minmax(0,1fr)_auto] lg:items-center lg:gap-x-6">
          <div className="flex shrink-0 items-center gap-2 text-sm font-medium">
            {ambiguous || reverseAmbiguous ? (
              <HelpCircle className="h-4 w-4 text-amber-600 dark:text-amber-400" />
            ) : (
              <GitBranch className="h-4 w-4 text-muted-foreground" />
            )}
            <span>
              {ambiguous
                ? "Possible stack parents"
                : reverseAmbiguous
                  ? "Possible stacked children"
                  : branched
                    ? "Inferred stack branches"
                    : `Part of an inferred ${layer?.size ?? items.length}-PR stack`}
            </span>
            {!ambiguous && !reverseAmbiguous && !branched && layer && (
              <span className="font-normal text-muted-foreground">
                · {layer.position} of {layer.size}
              </span>
            )}
          </div>
          <ol
            className={cn(
              "flex min-w-0 flex-col items-start text-sm lg:col-span-2",
              ambiguous || reverseAmbiguous
                ? "gap-1.5 xl:flex-row xl:gap-4"
                : "xl:flex-row xl:items-center",
            )}
          >
            {displayedItems.map((item, index) => {
              const isCurrent = item.rootId === currentRootId;
              return (
                <li
                  key={item.rootId}
                  className={cn(
                    "flex min-w-0 flex-col items-start xl:flex-row xl:items-center xl:gap-2",
                    !ambiguous && !reverseAmbiguous && "xl:flex-auto",
                  )}
                >
                  <div
                    aria-current={isCurrent ? "step" : undefined}
                    className={cn(
                      "flex min-w-0 items-center gap-1.5 rounded-lg border border-transparent px-2 py-1",
                      isCurrent &&
                        !ambiguous &&
                        !reverseAmbiguous &&
                        "border-primary/30 bg-primary/10 shadow-sm",
                    )}
                  >
                    <span
                      className={cn(
                        "flex h-5 w-5 shrink-0 items-center justify-center rounded-full border font-mono text-[10px]",
                        ambiguous || reverseAmbiguous
                          ? "border-amber-500/30 bg-amber-500/10 text-amber-700 dark:text-amber-300"
                          : isCurrent
                            ? "border-primary bg-primary text-primary-foreground"
                            : "border-primary/20 bg-primary/10 text-foreground",
                      )}
                    >
                      {ambiguous || reverseAmbiguous
                        ? "?"
                        : branched && index >= items.length
                          ? "↳"
                          : index + 1}
                    </span>
                    {isCurrent ? (
                      <span className="min-w-0 max-w-64 truncate font-medium">
                        {item.subject}
                      </span>
                    ) : (
                      <Link
                        className="min-w-0 max-w-64 truncate font-medium text-foreground hover:underline"
                        to={`${repoPath}/prs/${eventIdToNevent(item.rootId, relayHints)}`}
                      >
                        {item.subject}
                      </Link>
                    )}
                  </div>
                  {!ambiguous &&
                    !reverseAmbiguous &&
                    !branched &&
                    index < displayedItems.length - 1 && (
                      <span
                        aria-hidden="true"
                        className="ml-4 h-1 w-px bg-primary/30 xl:hidden"
                      />
                    )}
                  {!ambiguous &&
                    !reverseAmbiguous &&
                    !branched &&
                    index < displayedItems.length - 1 && (
                      <span
                        aria-hidden="true"
                        className="hidden h-px min-w-4 flex-1 bg-primary/30 xl:block"
                      />
                    )}
                </li>
              );
            })}
          </ol>
          <p className="text-xs text-muted-foreground lg:col-start-2 lg:row-start-1 lg:text-right">
            {ambiguous
              ? "Multiple PRs advertise the matching Git commit."
              : reverseAmbiguous
                ? "This PR may be their parent; another root advertises the same commit."
                : branched
                  ? "Multiple PRs are built directly on this Git commit."
                  : "Based on Git commit topology"}
          </p>
        </div>
      </div>
    </div>
  );
}
