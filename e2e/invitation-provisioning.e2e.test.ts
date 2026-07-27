/**
 * Invitation provisioning recovery.
 *
 * The invitation UI starts watching the invitee's clone URL immediately after
 * publishing their announcement. The first smart-HTTP probe therefore races
 * GRASP's creation of the bare repository and may legitimately receive a 404.
 * This exercises the exact transition that previously left the UI at 0/N:
 *
 *   absent endpoint -> announcement/state/push -> aligned advertised refs
 */

import { afterAll, beforeAll, describe, expect, it } from "vitest";
import { BehaviorSubject } from "rxjs";
import {
  GraspServer,
  RelayClient,
  TestSigner,
  graspBinaryAvailable,
  seedRepo,
  type SeededRepo,
} from "./harness";
import {
  GitGraspPool,
  type PoolState,
  type StateEventInput,
} from "@/lib/git-grasp-pool";

const describeIfGrasp = graspBinaryAvailable() ? describe : describe.skip;

describeIfGrasp("e2e — invitation GRASP provisioning", () => {
  let server: GraspServer;
  let relay: RelayClient;
  let signer: TestSigner;
  let pool: GitGraspPool;
  let stateEvent$: BehaviorSubject<StateEventInput>;
  let unsubscribe: (() => void) | undefined;

  beforeAll(async () => {
    server = await GraspServer.start({ role: "invitation-provisioning" });
    relay = await RelayClient.connect(server.relayUrl);
    signer = new TestSigner();
    stateEvent$ = new BehaviorSubject<StateEventInput>(undefined);
    pool = new GitGraspPool({
      cloneUrls: [server.cloneUrl(signer.npub, "invitation-provisioning-repo")],
      stateEvent$: stateEvent$.asObservable(),
      corsProxyBase: null,
      expectRepositoryProvisioning: true,
    });
  });

  afterAll(async () => {
    unsubscribe?.();
    pool?.dispose();
    stateEvent$?.complete();
    relay?.close();
    await server?.stop();
  });

  it("recovers after the first probe reaches an absent repository", async () => {
    const cloneUrl = server.cloneUrl(
      signer.npub,
      "invitation-provisioning-repo",
    );
    let latestState: PoolState | undefined;
    unsubscribe = pool.subscribe((state) => {
      latestState = state;
    });

    await waitFor(
      () => latestState?.urls[cloneUrl]?.status === "error",
      "initial absent endpoint to remain retryable",
    );
    expect(latestState?.urls[cloneUrl]?.status).not.toBe("permanent-failure");

    const repo: SeededRepo = await seedRepo(server, relay, signer, {
      identifier: "invitation-provisioning-repo",
      name: "Invitation provisioning repo",
    });
    stateEvent$.next({
      headCommitId: repo.headCommit,
      refs: [
        {
          name: `refs/heads/${repo.branch}`,
          commitId: repo.headCommit,
        },
      ],
      createdAt: repo.state.created_at,
    });

    await waitFor(
      () =>
        latestState?.urls[cloneUrl]?.infoRefs?.refs[
          `refs/heads/${repo.branch}`
        ] === repo.headCommit,
      "provisioned endpoint to advertise the canonical ref",
      20_000,
    );

    expect(latestState?.urls[cloneUrl]?.status).toBe("ok");
  });
});

async function waitFor(
  predicate: () => boolean,
  description: string,
  timeoutMs = 10_000,
): Promise<void> {
  const deadline = Date.now() + timeoutMs;
  while (Date.now() < deadline) {
    if (predicate()) return;
    await new Promise((resolve) => setTimeout(resolve, 50));
  }
  throw new Error(`Timed out waiting for ${description}`);
}
