import { useState, type ReactNode } from "react";
import { Link } from "react-router-dom";
import { ChevronDown } from "lucide-react";
import type { GitGraspPool } from "@/lib/git-grasp-pool";
import { cn } from "@/lib/utils";
import { Button } from "@/components/ui/button";
import {
  Collapsible,
  CollapsibleContent,
  CollapsibleTrigger,
} from "@/components/ui/collapsible";
import { TagMessage } from "@/components/TagMessage";

/** Navigation and disclosure share a full-width hover surface, with separate actions. */
export function TagListRow({
  name,
  href,
  tagOid,
  pool,
  children,
  checks,
}: {
  name: string;
  href: string;
  tagOid?: string;
  pool: GitGraspPool | null;
  children: ReactNode;
  checks?: ReactNode;
}) {
  const [open, setOpen] = useState(false);
  return (
    <Collapsible open={open} onOpenChange={setOpen}>
      <div className="flex items-center pr-2 sm:pr-4 hover:bg-accent/50 focus-within:bg-accent/50 motion-safe:transition-colors">
        <Link
          to={href}
          className="min-w-0 flex-1 rounded-sm focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-inset focus-visible:ring-ring"
        >
          {children}
        </Link>
        <div className="flex shrink-0 items-center gap-1 sm:gap-3">
          {checks}
          {tagOid && pool && (
            <CollapsibleTrigger asChild>
              <Button
                variant="ghost"
                className="h-11 min-w-11 gap-2 px-3 text-muted-foreground hover:text-foreground"
                aria-label={`${open ? "Hide" : "Show"} message for ${name}`}
                title={open ? "Hide tag message" : "Show tag message"}
              >
                <span className="hidden sm:inline text-xs font-medium">
                  Message
                </span>
                <ChevronDown
                  aria-hidden="true"
                  className={cn(
                    "h-4 w-4 motion-safe:transition-transform motion-safe:duration-200",
                    open && "rotate-180",
                  )}
                />
              </Button>
            </CollapsibleTrigger>
          )}
        </div>
      </div>
      {tagOid && pool && (
        <CollapsibleContent>
          {open && <TagMessage key={tagOid} pool={pool} tagOid={tagOid} />}
        </CollapsibleContent>
      )}
    </Collapsible>
  );
}
