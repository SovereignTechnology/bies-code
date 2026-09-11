import { Loader2, RotateCcw } from "lucide-react";
import { Button } from "@/components/ui/button";
import type { ErrorRetryState } from "@/hooks/useErrorRetry";

/** Shared recovery actions; scheduling belongs to the operation owner. */
export function ErrorRetryAction({ recovery }: { recovery: ErrorRetryState }) {
  return (
    <div className="flex flex-wrap items-center gap-3 text-sm">
      <Button
        variant="outline"
        size="sm"
        disabled={recovery.retrying}
        onClick={recovery.retry}
      >
        {recovery.retrying ? (
          <Loader2 className="h-4 w-4 mr-2 animate-spin" />
        ) : (
          <RotateCcw className="h-4 w-4 mr-2" />
        )}
        {recovery.retrying ? "Retrying…" : "Retry now"}
      </Button>
      <span className="text-muted-foreground">
        {recovery.secondsRemaining !== null
          ? `Retrying in ${recovery.secondsRemaining}s`
          : recovery.exhausted
            ? "Automatic retries finished. You can retry manually."
            : recovery.paused
              ? "Automatic retries paused."
              : recovery.waiting
                ? "Automatic retry waits until you're online and this page is visible."
                : null}
      </span>
      {recovery.automatic &&
        !recovery.paused &&
        !recovery.exhausted &&
        !recovery.retrying && (
          <Button variant="ghost" size="sm" onClick={recovery.pause}>
            Pause retries
          </Button>
        )}
    </div>
  );
}
