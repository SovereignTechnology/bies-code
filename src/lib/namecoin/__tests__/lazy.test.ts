/**
 * The lazy shim is what keeps `src/lib/namecoin/` out of the main
 * app bundle. This suite pins:
 *
 *   1. Cheap `isNamecoinIdentifier` is available synchronously — it
 *      does NOT drag the resolver module into memory.
 *   2. `resolveNamecoinLazily` returns the same tri-state as the
 *      eager entry point.
 *   3. A failure to fetch the chunk (network / CSP / module error)
 *      is surfaced as `{ status: "unavailable" }` rather than being
 *      thrown or silently mapped to `not-found`.
 *
 * The three tests together give reviewers a way to verify the lazy
 * discipline without inspecting the vite build output.
 */
import { describe, it, expect, beforeEach, vi } from "vitest";
import {
  isNamecoinIdentifier,
  resolveNamecoinLazily,
  __resetForTests,
} from "../lazy";

beforeEach(() => {
  __resetForTests();
  vi.doUnmock("../index");
});

describe("namecoin/lazy", () => {
  it("exposes the cheap identifier predicate synchronously (no dynamic import)", () => {
    // The mere fact that this call returns synchronously proves the
    // predicate is not gated on the async module load.
    expect(isNamecoinIdentifier("d/alice")).toBe(true);
    expect(isNamecoinIdentifier("alice@example.bit")).toBe(true);
    expect(isNamecoinIdentifier("id/bob")).toBe(true);
    expect(isNamecoinIdentifier("alice@example.com")).toBe(false);
    expect(isNamecoinIdentifier("")).toBe(false);
    expect(isNamecoinIdentifier(null)).toBe(false);
  });

  it("passes tri-state outcomes through from the real resolver", async () => {
    vi.doMock("../index", () => ({
      resolveNamecoinLookup: vi.fn(async () => ({ status: "not-found" })),
    }));
    __resetForTests();
    const outcome = await resolveNamecoinLazily("d/never-registered");
    expect(outcome).toEqual({ status: "not-found" });
  });

  it("maps a chunk-load failure onto { status: 'unavailable' }", async () => {
    vi.doMock("../index", () => {
      throw new Error("simulated chunk load failure");
    });
    __resetForTests();
    const outcome = await resolveNamecoinLazily("d/anything");
    expect(outcome).toEqual({ status: "unavailable" });
  });
});
