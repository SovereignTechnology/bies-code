import { useCallback } from "react";
import { useRecoveryToast } from "@/hooks/useRecoveryToast";

/** Clipboard access requires a user gesture, including after a failed attempt. */
export function useCopyToClipboard() {
  const { toast } = useRecoveryToast();
  return useCallback(
    async (value: string | (() => Promise<void>), onCopied?: () => void) => {
      const copy = async () => {
        if (typeof value === "string")
          await navigator.clipboard.writeText(value);
        else await value();
        onCopied?.();
      };
      try {
        await copy();
      } catch {
        toast({
          title: "Could not copy to clipboard",
          description:
            "Allow clipboard access and retry, or copy the displayed content manually.",
          variant: "destructive",
          recovery: { action: copy },
        });
      }
    },
    [toast],
  );
}
