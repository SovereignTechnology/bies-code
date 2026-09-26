import type { ISigner } from "applesauce-signers";
import { finalizeEvent, generateSecretKey, getPublicKey } from "nostr-tools";
import { afterEach, describe, expect, it, vi } from "vitest";

import {
  canonicalGitRepositoryUrl,
  createGitHttpAuthorizationProvider,
  getOrCreateGitHttpAuthorizationProvider,
  UnverifiedPrivateGitRootError,
} from "@/lib/git-http-auth";

function createTestSigner(): { pubkey: string; signer: ISigner } {
  const key = generateSecretKey();
  const pubkey = getPublicKey(key);
  return {
    pubkey,
    signer: {
      getPublicKey: async () => pubkey,
      signEvent: async (template) => finalizeEvent(template, key),
    },
  };
}

describe("private Git HTTP authorization", () => {
  afterEach(() => vi.useRealTimers());

  it("canonicalizes only the announced repository root", () => {
    expect(
      canonicalGitRepositoryUrl(
        "https://user:secret@example.com/git/owner/repo///?token=nope#part",
      ),
    ).toBe("https://example.com/git/owner/repo");
  });

  it("refuses credentials for an unverified sibling root", async () => {
    const { signer, pubkey } = createTestSigner();
    const provider = createGitHttpAuthorizationProvider(
      pubkey,
      signer,
      ["https://example.com/git/owner/repo"],
      "test",
    );

    expect(provider.canAuthorize("https://example.com/git/owner/repo/")).toBe(
      true,
    );
    expect(provider.canAuthorize("https://example.com/git/owner/fork")).toBe(
      false,
    );
    await expect(
      provider.getAuthorization("https://example.com/git/owner/fork"),
    ).rejects.toBeInstanceOf(UnverifiedPrivateGitRootError);
  });

  it("shares signing without letting one caller abort the other", async () => {
    const { signer: delegate, pubkey } = createTestSigner();
    let releaseSigner: (() => void) | undefined;
    const signerReady = new Promise<void>((resolve) => {
      releaseSigner = resolve;
    });
    const signer: ISigner = {
      getPublicKey: () => delegate.getPublicKey(),
      signEvent: vi.fn(async (template) => {
        await signerReady;
        return delegate.signEvent(template);
      }),
    };
    const provider = createGitHttpAuthorizationProvider(
      pubkey,
      signer,
      ["https://example.com/git/owner/repo"],
      "test",
    );
    const firstController = new AbortController();
    const first = provider
      .getAuthorization(
        "https://example.com/git/owner/repo",
        firstController.signal,
      )
      .catch((error: unknown) => error);
    const second = provider.getAuthorization(
      "https://example.com/git/owner/repo",
    );

    firstController.abort();
    releaseSigner?.();

    await expect(first).resolves.toMatchObject({ name: "AbortError" });
    await expect(second).resolves.toMatch(/^Nostr /);
    expect(signer.signEvent).toHaveBeenCalledTimes(1);
  });

  it("refreshes invalidated and expired credentials", async () => {
    vi.useFakeTimers();
    vi.setSystemTime(new Date("2026-01-01T00:00:00Z"));
    const { signer, pubkey } = createTestSigner();
    const signEvent = vi.spyOn(signer, "signEvent");
    const root = "https://example.com/git/owner/repo";
    const provider = createGitHttpAuthorizationProvider(
      pubkey,
      signer,
      [root],
      "test",
    );

    const first = await provider.getAuthorization(root);
    expect(await provider.getAuthorization(root)).toBe(first);
    expect(signEvent).toHaveBeenCalledTimes(1);

    provider.invalidateAuthorization(root);
    await provider.getAuthorization(root);
    expect(signEvent).toHaveBeenCalledTimes(2);

    vi.advanceTimersByTime(56_000);
    await provider.getAuthorization(root);
    expect(signEvent).toHaveBeenCalledTimes(3);
  });

  it("reuses providers only within the same account session scope", async () => {
    const { signer, pubkey } = createTestSigner();
    const root = "https://example.com/git/owner/repo";
    const first = getOrCreateGitHttpAuthorizationProvider(
      pubkey,
      signer,
      [root],
      "one",
    );
    const same = getOrCreateGitHttpAuthorizationProvider(
      pubkey,
      signer,
      [root],
      "one",
    );
    const nextSession = getOrCreateGitHttpAuthorizationProvider(
      pubkey,
      signer,
      [root],
      "two",
    );

    expect(same).toBe(first);
    expect(nextSession).not.toBe(first);
  });
});
