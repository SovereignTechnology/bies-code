import { useCallback } from "react";
import { useActiveAccount } from "applesauce-react/hooks";

import { use$ } from "@/hooks/use$";
import { useAction } from "@/hooks/useAction";
import { useRobustReplaceableAction } from "@/hooks/useRobustReplaceableAction";
import { ReplacePrivateGitRelayListFromPreflight } from "@/actions/privateGitRelayActions";
import { PRIVATE_GIT_RELAY_LIST_KIND } from "@/lib/private-git-relays";
import {
  privateGitRelayList$,
  retryPrivateGitRelayList,
} from "@/services/privateGitRelays";

export function usePrivateGitRelays() {
  const account = useActiveAccount();
  const state = use$(privateGitRelayList$);
  const { execute } = useRobustReplaceableAction();
  const { run: replacePrivateGitRelayList } = useAction(
    ReplacePrivateGitRelayListFromPreflight,
  );
  const save = useCallback(
    (nextRelayUrls: readonly string[], expectedEventId: string | undefined) => {
      if (!account) return Promise.reject(new Error("Not logged in."));
      return execute(
        PRIVATE_GIT_RELAY_LIST_KIND,
        ({ event, outboxes }) =>
          replacePrivateGitRelayList(
            account.pubkey,
            event,
            outboxes,
            nextRelayUrls,
          ),
        { expectedEventId: expectedEventId ?? null },
      );
    },
    [account, execute, replacePrivateGitRelayList],
  );
  const retry = useCallback(
    () => retryPrivateGitRelayList(state.generation),
    [state.generation],
  );

  return { state, retry, save };
}
