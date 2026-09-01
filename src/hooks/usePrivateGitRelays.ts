import { useCallback } from "react";

import { use$ } from "@/hooks/use$";
import {
  privateGitRelayList$,
  retryPrivateGitRelayList,
  updatePrivateGitRelayList,
} from "@/services/privateGitRelays";

export function usePrivateGitRelays() {
  const state = use$(privateGitRelayList$);
  const save = useCallback(
    (baseRelayUrls: readonly string[], nextRelayUrls: readonly string[]) =>
      updatePrivateGitRelayList(state.generation, baseRelayUrls, nextRelayUrls),
    [state.generation],
  );
  const retry = useCallback(
    () => retryPrivateGitRelayList(state.generation),
    [state.generation],
  );

  return { state, retry, save };
}
