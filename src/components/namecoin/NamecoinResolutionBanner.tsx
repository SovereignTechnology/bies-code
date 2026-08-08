import { AlertTriangle, Info, Link2, Loader2 } from "lucide-react";

import type { NamecoinResolutionStatus } from "@/hooks/useNamecoinSearchResolution";

interface NamecoinResolutionBannerProps {
  status: NamecoinResolutionStatus;
  query: string;
  pubkey?: string;
}

export function NamecoinResolutionBanner({
  status,
  query,
  pubkey,
}: NamecoinResolutionBannerProps) {
  if (status === "idle") return null;

  if (status === "resolving") {
    return (
      <div
        role="status"
        className="flex items-center gap-2 text-xs text-muted-foreground border border-border/60 rounded-md px-3 py-2 bg-muted/30"
        data-testid="namecoin-banner"
      >
        <Loader2 className="h-3.5 w-3.5 animate-spin text-pink-500" />
        <span>
          Resolving <span className="font-mono">{query}</span> via Namecoin…
        </span>
      </div>
    );
  }

  if (status === "resolved" && pubkey) {
    return (
      <div
        role="status"
        className="flex items-center gap-2 text-xs text-muted-foreground border border-border/60 rounded-md px-3 py-2 bg-muted/30"
        data-testid="namecoin-banner"
      >
        <Link2 className="h-3.5 w-3.5 text-emerald-500" />
        <span>
          <span className="font-mono">{query}</span> resolved via Namecoin.
        </span>
      </div>
    );
  }

  if (status === "unavailable") {
    return (
      <div
        role="alert"
        className="flex items-center gap-2 text-xs text-amber-600 dark:text-amber-400 border border-amber-500/40 rounded-md px-3 py-2 bg-amber-500/10"
        data-testid="namecoin-banner"
      >
        <AlertTriangle className="h-3.5 w-3.5" />
        <span>
          Namecoin resolver unavailable — could not reach any ElectrumX server.
          Try again in a moment.
        </span>
      </div>
    );
  }

  return (
    <div
      role="status"
      className="flex items-center gap-2 text-xs text-muted-foreground border border-border/60 rounded-md px-3 py-2 bg-muted/30"
      data-testid="namecoin-banner"
    >
      <Info className="h-3.5 w-3.5" />
      <span>
        <span className="font-mono">{query}</span> is not registered on
        Namecoin.
      </span>
    </div>
  );
}
