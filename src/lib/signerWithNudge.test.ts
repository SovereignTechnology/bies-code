import type { ISigner } from "applesauce-signers";
import { afterEach, describe, expect, it, vi } from "vitest";

const { androidResumeMock, toastMock } = vi.hoisted(() => ({
  androidResumeMock: vi.fn(() => ({ destroy: vi.fn() })),
  toastMock: vi.fn(() => ({ dismiss: vi.fn() })),
}));

vi.mock("@/lib/androidResume", () => ({
  androidResume: androidResumeMock,
}));

vi.mock("@/hooks/useToast", () => ({
  toast: toastMock,
}));

import { signerWithNudge } from "@/lib/signerWithNudge";

function deferred<T>(): {
  promise: Promise<T>;
  resolve: (value: T) => void;
} {
  let resolve!: (value: T) => void;
  const promise = new Promise<T>((done) => {
    resolve = done;
  });
  return { promise, resolve };
}

function signerWithPendingNip44Decrypt(
  decrypt: (pubkey: string, ciphertext: string) => Promise<string>,
): ISigner {
  return {
    getPublicKey: async () => "a".repeat(64),
    signEvent: async () => {
      throw new Error("signEvent is not used in this test");
    },
    nip44: {
      encrypt: async (_pubkey, plaintext) => plaintext,
      decrypt,
    },
  };
}

describe("signerWithNudge decryption", () => {
  afterEach(() => {
    vi.useRealTimers();
    vi.clearAllMocks();
  });

  it("coalesces matching requests without installing a foreground retry", async () => {
    const pending = deferred<string>();
    const decrypt = vi.fn(
      (_pubkey: string, _ciphertext: string) => pending.promise,
    );
    const signer = signerWithNudge(signerWithPendingNip44Decrypt(decrypt));

    const first = signer.nip44!.decrypt("b".repeat(64), "ciphertext");
    const duplicate = signer.nip44!.decrypt("b".repeat(64), "ciphertext");

    expect(duplicate).toBe(first);
    await Promise.resolve();
    expect(decrypt).toHaveBeenCalledTimes(1);
    expect(androidResumeMock).not.toHaveBeenCalled();

    pending.resolve("plaintext");
    await expect(first).resolves.toBe("plaintext");
  });

  it("does not redispatch while a timed-out signer request is unresolved", async () => {
    vi.useFakeTimers();
    const pending = deferred<string>();
    const decrypt = vi.fn(
      (_pubkey: string, _ciphertext: string) => pending.promise,
    );
    const signer = signerWithNudge(signerWithPendingNip44Decrypt(decrypt));

    const first = signer.nip44!.decrypt("b".repeat(64), "ciphertext");
    const timedOut = expect(first).rejects.toThrow("Signer timed out");
    await vi.advanceTimersByTimeAsync(45_000);
    await timedOut;

    const automaticRetry = signer.nip44!.decrypt("b".repeat(64), "ciphertext");
    expect(automaticRetry).toBe(first);
    await expect(automaticRetry).rejects.toThrow("Signer timed out");
    expect(decrypt).toHaveBeenCalledTimes(1);

    pending.resolve("plaintext");
    await Promise.resolve();
  });
});
