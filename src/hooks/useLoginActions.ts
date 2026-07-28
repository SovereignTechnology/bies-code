import { APP_NAME } from "@/lib/constants";
import { accounts } from "@/services/accounts";
import { pool } from "@/services/nostr";
import { defaultNostrConnectRelays } from "@/services/settings";
import { signerWithNudge } from "@/lib/signerWithNudge";
import { Capacitor } from "@capacitor/core";
import { Accounts } from "applesauce-accounts";
import {
  AmberClipboardAccount,
  NostrConnectAccount,
} from "applesauce-accounts/accounts";
import { AndroidNativeAccount } from "applesauce-accounts/accounts/android-native-account";
import type { IAccount } from "applesauce-accounts";
import {
  AmberClipboardSigner,
  ExtensionSigner,
  NostrConnectSigner,
  PrivateKeySigner,
} from "applesauce-signers";
import { nip19 } from "nostr-tools";

// NOTE: This file should not be edited except for adding new login methods.

const AMBER_ANDROID_PACKAGE = "com.greenart7c3.nostrsigner";

/**
 * Wraps the signer on an account with {@link signerWithNudge} so that slow or
 * pending remote-signer operations surface a toast nudge to the user.
 *
 * - NostrConnect accounts: also wires up a relay-connectivity check so the
 *   toast can warn when the bunker relay WebSocket is not open.
 * - Extension accounts: wrapped without a connectivity check (nudge still
 *   helps when the user dismisses or ignores the extension popup).
 * - PrivateKey accounts: not wrapped — local signing is instant.
 *
 * Mutates `account.signer` in place and returns the account for chaining.
 */
export function applySignerNudge<T extends IAccount>(account: T): T {
  if (account instanceof NostrConnectAccount) {
    const nostrConnectSigner = account.signer as NostrConnectSigner;
    // Connectivity check: the signer is considered reachable when it is
    // actively listening on its relay subscription AND the session is marked
    // connected. This is the best available proxy without reaching into pool
    // WebSocket internals — if either flag is false the relay is effectively
    // unreachable for NIP-46 purposes.
    const isBunkerConnected = () =>
      nostrConnectSigner.listening && nostrConnectSigner.isConnected;
    const wrapped = signerWithNudge(nostrConnectSigner, isBunkerConnected);
    // Use a Proxy so that NostrConnectAccount.toJSON() can still access
    // .remote, .signer, .relays etc. on the original NostrConnectSigner
    // (needed to serialise the account to localStorage). Without this the
    // signerWithNudge wrapper — a plain ISigner object — would shadow those
    // properties, causing toJSON() to throw and the session to be lost on
    // every page refresh.
    account.signer = new Proxy(nostrConnectSigner, {
      get(target, prop, receiver) {
        // Route ISigner interface calls through the nudge wrapper.
        if (Object.prototype.hasOwnProperty.call(wrapped, prop)) {
          return (wrapped as Record<string | symbol, unknown>)[prop];
        }
        // Everything else (remote, signer, relays, listening, isConnected,
        // open, etc.) falls through to the real NostrConnectSigner.
        const val = Reflect.get(target, prop, receiver);
        return typeof val === "function" ? val.bind(target) : val;
      },
    }) as typeof account.signer;
  } else if (account instanceof Accounts.ExtensionAccount) {
    // Extension signers benefit from the nudge (the user may dismiss or ignore
    // the browser popup) but have no relay connectivity to check.
    account.signer = signerWithNudge(account.signer) as typeof account.signer;
  }
  // Do not wrap AmberClipboardAccount: its signer opens the complete NIP-55
  // request, while the generic Android nudge can only reopen a bare
  // `nostrsigner:` URI that Amber correctly rejects as malformed.
  // PrivateKey and direct Android signer accounts do not need a nudge either.
  return account;
}

/** Check if running on an actual mobile device (not just a small screen) */
export function isMobileDevice(): boolean {
  if (typeof navigator === "undefined") return false;
  return /Android|iPhone|iPad|iPod/i.test(navigator.userAgent);
}

/** Check whether the current device is running Android. */
export function isAndroidDevice(): boolean {
  return (
    typeof navigator !== "undefined" && /Android/i.test(navigator.userAgent)
  );
}

/** Parameters for a pending nostrconnect:// session */
export interface NostrConnectSession {
  /** The ephemeral signer created for this session */
  signer: NostrConnectSigner;
  /** The nostrconnect:// URI to display as a QR code / deep link */
  uri: string;
}

/**
 * Creates a new nostrconnect:// session.
 * Generates an ephemeral signer, builds the URI, and returns both so the
 * caller can display the QR code while separately awaiting the connection.
 *
 * @param appName - Optional app name to embed in the URI metadata
 * @param relays  - Optional relay override; falls back to {@link defaultNostrConnectRelays}
 */
export function createNostrConnectSession(
  appName?: string,
  relays?: string[],
): NostrConnectSession {
  const sessionRelays = relays ?? defaultNostrConnectRelays.getValue();

  const signer = new NostrConnectSigner({ relays: sessionRelays, pool });

  const metadata: Parameters<NostrConnectSigner["getNostrConnectURI"]>[0] = {
    name: appName ?? APP_NAME,
    url: typeof window !== "undefined" ? window.location.origin : undefined,
    permissions: NostrConnectSigner.buildSigningPermissions([0, 1, 3, 10002]),
  };

  // On mobile, the signer app is on the same device — no QR needed, just a
  // deep link. On desktop the user scans the QR with their phone.
  if (typeof window !== "undefined" && isMobileDevice()) {
    // nostrconnect:// URIs are handled by signer apps (e.g. Amber on Android)
    // No callback needed — we poll via waitForSigner.
  }

  const uri = signer.getNostrConnectURI(metadata);

  return { signer, uri };
}

/**
 * Provides actions for logging in with various Nostr signers.
 * Uses applesauce-accounts for multi-account management.
 */
export function useLoginActions() {
  return {
    /**
     * Login with a Nostr secret key (nsec).
     * Creates a PrivateKeyAccount and adds it to the account manager.
     */
    async nsec(nsec: string): Promise<void> {
      try {
        const decoded = nip19.decode(nsec);
        if (decoded.type !== "nsec") {
          throw new Error("Invalid nsec format");
        }

        const secretKey = decoded.data; // Uint8Array
        const signer = new PrivateKeySigner(secretKey);
        const pubkey = await signer.getPublicKey();

        // Only skip adding if a PrivateKey account for this pubkey already
        // exists — a different signer type for the same pubkey is a distinct
        // account and should be added separately.
        const existing = accounts
          .getAccountsForPubkey(pubkey)
          .find((a) => a instanceof Accounts.PrivateKeyAccount);
        if (existing) {
          accounts.setActive(existing);
          return;
        }

        const account = new Accounts.PrivateKeyAccount(pubkey, signer);
        accounts.addAccount(account);
        accounts.setActive(account);
      } catch (error) {
        console.error("Failed to login with nsec:", error);
        throw new Error("Invalid secret key");
      }
    },

    /**
     * Login with a NIP-46 "bunker://" URI (Nostr Connect).
     * Creates a NostrConnectAccount and adds it to the account manager.
     */
    async bunker(uri: string): Promise<void> {
      try {
        const signer = await NostrConnectSigner.fromBunkerURI(uri);
        const pubkey = await signer.getPublicKey();

        // Only skip adding if a NostrConnect account for this pubkey already
        // exists — a different signer type (e.g. extension) for the same pubkey
        // is a distinct account and should be added separately.
        const existing = accounts
          .getAccountsForPubkey(pubkey)
          .find((a) => a instanceof Accounts.NostrConnectAccount);
        if (existing) {
          accounts.setActive(existing);
          return;
        }

        const account = applySignerNudge(
          new Accounts.NostrConnectAccount(pubkey, signer),
        );
        accounts.addAccount(account);
        accounts.setActive(account);
      } catch (error) {
        console.error("Failed to login with bunker:", error);
        throw new Error("Failed to connect to remote signer");
      }
    },

    /**
     * Login via nostrconnect:// (client-initiated NIP-46).
     * The caller must first call createNostrConnectSession() to get the URI
     * for display, then pass the session here to await the connection.
     */
    async nostrconnect(
      session: NostrConnectSession,
      abortSignal?: AbortSignal,
    ): Promise<void> {
      try {
        await session.signer.waitForSigner(abortSignal);

        const pubkey = await session.signer.getPublicKey();

        // Only skip adding if a NostrConnect account for this pubkey already
        // exists — a different signer type (e.g. extension) for the same pubkey
        // is a distinct account and should be added separately.
        const existing = accounts
          .getAccountsForPubkey(pubkey)
          .find((a) => a instanceof Accounts.NostrConnectAccount);
        if (existing) {
          accounts.setActive(existing);
          return;
        }

        const account = applySignerNudge(
          new Accounts.NostrConnectAccount(pubkey, session.signer),
        );
        accounts.addAccount(account);
        accounts.setActive(account);
      } catch (error) {
        console.error("Failed to login with nostrconnect:", error);
        throw error;
      }
    },

    /**
     * Login with a NIP-07 browser extension.
     * Creates an ExtensionAccount and adds it to the account manager.
     */
    async extension(): Promise<void> {
      try {
        if (!("nostr" in window)) {
          throw new Error(
            "Nostr extension not found. Please install a NIP-07 extension.",
          );
        }

        const pubkey = await window.nostr!.getPublicKey();

        // Only skip adding if an Extension account for this pubkey already
        // exists — a different signer type for the same pubkey is a distinct
        // account and should be added separately.
        const existing = accounts
          .getAccountsForPubkey(pubkey)
          .find((a) => a instanceof Accounts.ExtensionAccount);
        if (existing) {
          accounts.setActive(existing);
          return;
        }

        const signer = new ExtensionSigner();
        const account = applySignerNudge(
          new Accounts.ExtensionAccount(pubkey, signer),
        );

        accounts.addAccount(account);
        accounts.setActive(account);
      } catch (error) {
        console.error("Failed to login with extension:", error);
        throw error;
      }
    },

    /** Login with Amber through Android's NIP-55 signer integration. */
    async amber(): Promise<void> {
      try {
        if (Capacitor.getPlatform() === "android") {
          const amberApp = (await AndroidNativeAccount.getSignerApps()).find(
            (app) => app.packageName === AMBER_ANDROID_PACKAGE,
          );
          if (!amberApp) {
            throw new Error("Amber is not installed on this device.");
          }

          const account = await AndroidNativeAccount.fromApp(amberApp);
          const existing = accounts
            .getAccountsForPubkey(account.pubkey)
            .find(
              (candidate) =>
                candidate instanceof AndroidNativeAccount &&
                candidate.signer.packageName === AMBER_ANDROID_PACKAGE,
            );
          if (existing) {
            accounts.setActive(existing);
            return;
          }

          accounts.addAccount(account);
          accounts.setActive(account);
          return;
        }

        // Android browsers cannot use the Capacitor bridge. Keep the web
        // clipboard flow there, where intent: URLs are handled by the browser.
        const signer = new AmberClipboardSigner();
        const pubkey = await signer.getPublicKey();

        // Only skip adding if this exact signer type is already present for
        // the selected public key; users can keep other signer types too.
        const existing = accounts
          .getAccountsForPubkey(pubkey)
          .find((a) => a instanceof AmberClipboardAccount);
        if (existing) {
          accounts.setActive(existing);
          signer.destroy();
          return;
        }

        const account = new AmberClipboardAccount(pubkey, signer);
        accounts.addAccount(account);
        accounts.setActive(account);
      } catch (error) {
        console.error("Failed to login with Amber:", error);
        throw error;
      }
    },

    /**
     * Log out the current user.
     * Removes the active account from the account manager.
     */
    logout(): void {
      const activeAccount = accounts.getActive();
      if (activeAccount) {
        accounts.removeAccount(activeAccount.id);
      }
    },
  };
}
