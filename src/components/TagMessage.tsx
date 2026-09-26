import { useCallback, useEffect, useMemo, useState } from "react";
import type { GitGraspPool } from "@/lib/git-grasp-pool";
import { useErrorRetry } from "@/hooks/useErrorRetry";
import { ErrorRetryAction } from "@/components/ErrorRetryAction";
import { Skeleton } from "@/components/ui/skeleton";

/** Mounted only while the annotation is expanded; requests stop on collapse. */
export function TagMessage({
  pool,
  tagOid,
}: {
  pool: GitGraspPool;
  tagOid: string;
}) {
  const [message, setMessage] = useState<string | null>(null);
  const [error, setError] = useState<string | null>(null);
  const [loading, setLoading] = useState(true);
  const resourceKey = useMemo(() => ({ pool, tagOid }), [pool, tagOid]);
  const load = useCallback(
    async (signal: AbortSignal) => {
      setLoading(true);
      setError(null);
      try {
        const result = await pool.getTagMessage(tagOid, signal);
        if (signal.aborted) return;
        if (result === null)
          throw new Error(
            "The tag message could not be loaded from the repository's Git servers.",
          );
        setMessage(result);
      } catch (cause) {
        if (!signal.aborted)
          setError(
            cause instanceof Error
              ? cause.message
              : "Could not load the tag message.",
          );
      } finally {
        if (!signal.aborted) setLoading(false);
      }
    },
    [pool, tagOid],
  );
  useEffect(() => {
    const controller = new AbortController();
    setMessage(null);
    void load(controller.signal);
    return () => controller.abort();
  }, [load]);
  const recovery = useErrorRetry({
    resourceKey,
    failed: !!error,
    busy: loading,
    onRetry: async (signal) => {
      await pool.retryReads({ refreshRefs: false });
      if (!signal.aborted) await load(signal);
    },
  });
  // Git appends armored signatures to the annotation. Keep complete trailing
  // blocks inspectable, without treating them as message text or verified trust.
  // https://git-scm.com/docs/gitformat-signature
  const signature = message?.match(
    /(?:^|\n)(-----BEGIN (PGP SIGNATURE|PGP MESSAGE|SSH SIGNATURE|SIGNED MESSAGE)-----\r?\n[\s\S]*?\r?\n-----END \2-----)(?:\r?\n)*$/,
  );
  const body = signature
    ? message?.slice(0, signature.index).trimEnd()
    : message;

  return (
    <div className="min-w-0 pb-5 pl-11 pr-4 sm:pr-6" aria-live="polite">
      {loading ? (
        <Skeleton className="h-16 w-full" />
      ) : error ? (
        <div className="space-y-2 text-sm">
          <p className="text-destructive">{error}</p>
          <ErrorRetryAction recovery={recovery} />
        </div>
      ) : body?.trim() ? (
        <pre className="whitespace-pre-wrap break-words border-t border-border/40 pt-4 font-sans text-sm leading-relaxed text-foreground/90">
          {body}
        </pre>
      ) : (
        <p className="text-sm text-muted-foreground">
          This annotated tag has no message.
        </p>
      )}
      {!loading && !error && signature && (
        <details className="mt-4 text-xs text-muted-foreground">
          <summary className="w-fit cursor-pointer rounded-sm py-2 hover:text-foreground focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-ring">
            Signature (not verified)
          </summary>
          <pre className="mt-2 whitespace-pre-wrap break-all font-mono leading-relaxed">
            {signature[1]}
          </pre>
        </details>
      )}
    </div>
  );
}
