import { useCallback, useEffect, useRef } from "react";
import { useActiveAccount } from "applesauce-react/hooks";
import { useToast } from "@/hooks/useToast";
import { ToastAction } from "@/components/ui/toast";
import { ManualRetryAction } from "@/components/ErrorRetryAction";

/** User-triggered recovery for action errors; never schedules or signs on its own. */
export function useRecoveryToast() {
  const { toast: showToast } = useToast();
  const account = useActiveAccount();
  const currentAccount = useRef(account?.pubkey);
  currentAccount.current = account?.pubkey;
  const mounted = useRef(false);
  const dismissals = useRef(new Set<() => void>());
  useEffect(() => {
    mounted.current = true;
    const owned = dismissals.current;
    return () => {
      mounted.current = false;
      for (const dismiss of owned) dismiss();
      owned.clear();
    };
  }, []);
  const toast = useCallback(
    ({
      recovery,
      ...props
    }: Parameters<typeof showToast>[0] & {
      recovery?: { action: () => void | Promise<unknown>; label?: string };
    }) => {
      if (!recovery) return showToast(props);
      const pubkey = currentAccount.current;
      const location = window.location.href;
      const label = recovery.label ?? "Retry now";
      const result: ReturnType<typeof showToast> = showToast({
        ...props,
        duration: Infinity,
        container: Array.from(
          document.querySelectorAll<HTMLElement>(
            '[role="dialog"][data-state="open"]',
          ),
        )
          .filter((node) => node.getAttribute("aria-hidden") !== "true")
          .at(-1),
        action: (
          <ToastAction
            altText={label}
            asChild
            className="contents border-0 p-0"
          >
            <span>
              <ManualRetryAction
                label={label}
                onRetry={async () => {
                  if (
                    !mounted.current ||
                    currentAccount.current !== pubkey ||
                    window.location.href !== location
                  ) {
                    throw new Error(
                      "This action belongs to a previous page or account. Reopen it to try again.",
                    );
                  }
                  await recovery.action();
                  result.dismiss();
                  dismissals.current.delete(result.dismiss);
                }}
              />
            </span>
          </ToastAction>
        ),
      });
      // Only one toast is displayed; do not retain callbacks for replaced errors.
      dismissals.current.clear();
      dismissals.current.add(result.dismiss);
      return result;
    },
    [showToast],
  );
  return { toast };
}
