// Bridges nsyte's NIP-46 signing to the Zapstore bunker.
//
// The bunker binds its static connect secret to the first NIP-46 client key
// that used it (zsp's) and only answers `connect` requests carrying both
// that client key and the secret: nsyte's nbunksec path omits the secret
// (the request times out) and its bunker-URL path generates a fresh client
// key (the bunker rejects it with "already connected"). No nsyte mode can
// produce the required handshake, so this process performs it upstream the
// way zsp does and re-exposes the signing session as a throwaway local
// NIP-46 provider that nsyte's bunker-URL path can consume.
//
// Environment:
//   ZAPSTORE_BUNKER_URL  bunker:// URL of the upstream bunker
//   ZAPSTORE_CLIENT_KEY  64-char hex client key already authorized upstream
//   BRIDGE_OUTPUT_FILE   path to write the local bunker:// URI to
//
// On failure the output file receives a line starting with "ERROR:" and the
// process exits non-zero. On success the process stays alive relaying
// signing requests until it receives SIGTERM or SIGINT.

import { randomBytes } from "node:crypto";
import { writeFileSync } from "node:fs";
import { RelayPool } from "applesauce-relay";
import {
  NostrConnectProvider,
  NostrConnectSigner,
  PrivateKeySigner,
} from "applesauce-signers";

const UPSTREAM_TIMEOUT_MS = 30_000;

const outputFile = process.env.BRIDGE_OUTPUT_FILE;

function fail(message) {
  if (outputFile) writeFileSync(outputFile, `ERROR: ${message}\n`);
  console.error(message);
  process.exit(1);
}

function withTimeout(promise, label) {
  return Promise.race([
    promise,
    new Promise((_, reject) =>
      setTimeout(
        () =>
          reject(
            new Error(`${label} timed out after ${UPSTREAM_TIMEOUT_MS}ms`),
          ),
        UPSTREAM_TIMEOUT_MS,
      ),
    ),
  ]);
}

const bunkerUrl = process.env.ZAPSTORE_BUNKER_URL ?? "";
const clientKey = (process.env.ZAPSTORE_CLIENT_KEY ?? "").trim();
if (!outputFile) fail("Set BRIDGE_OUTPUT_FILE to a writable path.");
if (!bunkerUrl.startsWith("bunker://"))
  fail("Set the ZAPSTORE_BUNKER_URL secret to a bunker:// URL.");
if (!/^[0-9a-f]{64}$/.test(clientKey))
  fail("Set the ZAPSTORE_CLIENT_KEY secret to a 64-character hex key.");

let parsed;
try {
  parsed = NostrConnectSigner.parseBunkerURI(bunkerUrl);
} catch (error) {
  fail(`Failed to parse the bunker URL: ${error.message}`);
}
const { remote, relays, bunkerSecret } = parsed;
if (!bunkerSecret) fail("The bunker URL must include a secret parameter.");

const pool = new RelayPool();

const upstream = new NostrConnectSigner({
  pool,
  relays,
  remote,
  signer: PrivateKeySigner.fromKey(clientKey),
});

try {
  await withTimeout(upstream.connect(bunkerSecret), "Upstream bunker connect");
} catch (error) {
  fail(`Upstream bunker connect failed: ${error.message}`);
}

let userPubkey;
try {
  userPubkey = await withTimeout(
    upstream.getPublicKey(),
    "Upstream get_public_key",
  );
} catch (error) {
  fail(`Upstream get_public_key failed: ${error.message}`);
}

// Wrap the upstream signer so the job log records the outcome of every
// bridged signing request. The provider forwards failures to nsyte, but
// nsyte's output does not include the bunker's error messages, and those
// are the only evidence of bunker-side signing policy rejections.
const loggingUpstream = {
  getPublicKey: () => upstream.getPublicKey(),
  signEvent: async (template) => {
    try {
      const event = await upstream.signEvent(template);
      console.log(`upstream bunker signed kind ${template.kind}`);
      return event;
    } catch (error) {
      console.error(
        `upstream bunker refused to sign kind ${template.kind}: ${error.message}`,
      );
      throw error;
    }
  },
  nip04: upstream.nip04,
  nip44: upstream.nip44,
};

// Reuse the upstream bunker's relays for the local provider: they are proven
// reachable from this runner and proven to accept kind 24133 traffic.
const provider = new NostrConnectProvider({
  pool,
  relays,
  upstream: loggingUpstream,
  signer: new PrivateKeySigner(),
  bunkerSecret: randomBytes(16).toString("hex"),
  onSignEvent: (draft) => {
    console.log(`bridging sign_event request for kind ${draft.kind}`);
    return true;
  },
});

try {
  await provider.start();
  const uri = await provider.getBunkerURI();
  writeFileSync(outputFile, `${uri}\n`);
} catch (error) {
  fail(`Failed to start the local provider: ${error.message}`);
}

console.log(
  `bridge ready: relaying NIP-46 signing for ${userPubkey.slice(0, 8)}…`,
);

async function shutdown() {
  try {
    await provider.stop();
  } finally {
    process.exit(0);
  }
}
process.on("SIGTERM", shutdown);
process.on("SIGINT", shutdown);
