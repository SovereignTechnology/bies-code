import { useEffect, useState } from "react";
import { fetchGraspServerInformation, type Nip11Document } from "@/lib/grasp";

export type GraspServerInfoState =
  | { status: "loading" }
  | { status: "found"; document: Nip11Document }
  | { status: "error"; message: string };

/** Fetch a domain's NIP-11 document with cancellation and a bounded timeout. */
export function useGraspServerInfo(
  domain: string | undefined,
): GraspServerInfoState | undefined {
  const [state, setState] = useState<GraspServerInfoState | undefined>(
    domain ? { status: "loading" } : undefined,
  );

  useEffect(() => {
    if (!domain) {
      setState(undefined);
      return;
    }

    const controller = new AbortController();
    let disposed = false;
    const timeout = window.setTimeout(() => controller.abort(), 8000);
    setState({ status: "loading" });

    void fetchGraspServerInformation(domain, controller.signal)
      .then((document) => {
        if (!disposed) setState({ status: "found", document });
      })
      .catch((error: unknown) => {
        if (disposed) return;
        if (controller.signal.aborted) {
          setState({ status: "error", message: "Server did not respond" });
          return;
        }
        setState({
          status: "error",
          message: error instanceof Error ? error.message : "Request failed",
        });
      })
      .finally(() => window.clearTimeout(timeout));

    return () => {
      disposed = true;
      window.clearTimeout(timeout);
      controller.abort();
    };
  }, [domain]);

  return state;
}
