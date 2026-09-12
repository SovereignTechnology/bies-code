import { useEffect, useRef, useState } from "react";
import { Loader2, RotateCcw } from "lucide-react";
import { Button } from "@/components/ui/button";
import type { ErrorRetryState } from "@/hooks/useErrorRetry";

/** Shared recovery actions; scheduling belongs to the operation owner. */
export function ErrorRetryAction({
  recovery,
  label = "Retry now",
}: {
  recovery: ErrorRetryState;
  label?: string;
}) {
  return (
    <span className="inline-flex flex-wrap items-center gap-3 text-sm">
      <Button
        variant="outline"
        size="sm"
        disabled={recovery.retrying}
        onClick={(event) => {
          event.preventDefault();
          event.stopPropagation();
          recovery.retry();
        }}
      >
        {recovery.retrying ? (
          <Loader2 className="h-4 w-4 mr-2 animate-spin" />
        ) : (
          <RotateCcw className="h-4 w-4 mr-2" />
        )}
        {recovery.retrying ? "Retrying…" : label}
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
          <Button
            variant="ghost"
            size="sm"
            onClick={(event) => {
              event.preventDefault();
              event.stopPropagation();
              recovery.pause();
            }}
          >
            Pause retries
          </Button>
        )}
    </span>
  );
}

/** Manual actions share the retry UI without timers or online/visibility listeners. */
export function ManualRetryAction({
  onRetry,
  busy = false,
  label,
}: {
  onRetry: () => void | Promise<unknown>;
  busy?: boolean;
  label?: string;
}) {
  const [pending, setPending] = useState(false);
  const [error, setError] = useState<string>();
  const running = useRef(false);
  const mounted = useRef(false);
  useEffect(() => {
    mounted.current = true;
    return () => {
      mounted.current = false;
    };
  }, []);
  return (
    <span className="inline-flex flex-wrap items-center gap-2">
      <ErrorRetryAction
        label={label}
        recovery={{
          retry: () => {
            if (busy || running.current) return;
            running.current = true;
            setPending(true);
            setError(undefined);
            Promise.resolve()
              .then(onRetry)
              .catch((caught: unknown) => {
                if (mounted.current)
                  setError(
                    caught instanceof Error
                      ? caught.message
                      : "Retry failed. Please try again.",
                  );
              })
              .finally(() => {
                running.current = false;
                if (mounted.current) setPending(false);
              });
          },
          retrying: busy || pending,
          secondsRemaining: null,
          automatic: false,
          exhausted: false,
          waiting: false,
          paused: false,
          pause: () => {},
        }}
      />
      {error && (
        <span role="alert" className="text-sm text-destructive">
          {error}
        </span>
      )}
    </span>
  );
}
