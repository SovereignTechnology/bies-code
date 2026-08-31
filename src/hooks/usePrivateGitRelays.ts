import { useCallback } from "react";

import { use$ } from "@/hooks/use$";
import {
  privateGitRelayList$,
  updatePrivateGitRelayList,
} from "@/services/privateGitRelays";

export function usePrivateGitRelays() {
  const state = use$(privateGitRelayList$);
  const save = useCallback(
    (baseRelayUrls: readonly string[], nextRelayUrls: readonly string[]) =>
      updatePrivateGitRelayList(state.generation, baseRelayUrls, nextRelayUrls),
    [state.generation],
  );

  return { state, save };
}
