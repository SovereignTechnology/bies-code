/**
 * git-grasp-pool — git HTTP protocol layer
 *
 * Uses only the low-level exports from the vendored git-natural-api:
 *   fetchPackfile, createWantRequest, loadTree, parseTree, parseCommit,
 *   getInfoRefs, MissingRef, ParsedObject
 *
 * We never call the library's high-level functions (getObject,
 * fetchCommitsOnly, getDirectoryTreeAt, etc.) because every one of them
 * calls getCapabilities() internally, which re-fetches infoRefs and
 * bypasses our cache entirely.
 *
 * Instead, we replicate the same capability-negotiation + packfile pattern
 * ourselves, passing the capabilities we already have from our cached
 * infoRefs response. This means zero extra HTTP requests for capabilities.
 *
 * Every function accepts an already-resolved effective URL (proxy or direct).
 * The pool is responsible for choosing which URL to pass.
 */

import {
  getInfoRefs as libGetInfoRefs,
  fetchPackfile,
  MissingRef,
  createWantRequest,
  loadTree,
  parseCommit,
  type Commit,
  type Tree,
  type TreeEntry,
  type InfoRefsUploadPackResponse,
  type ParsedObject,
} from "@/lib/vendored/git-natural-api";
import type { PackableObject } from "@/lib/git-packfile";
import type { CorsProxyManager } from "./cors-proxy";
import type { GitObjectCache, RawObjectsEntry } from "./cache";
import { FULL_NEST_LIMIT } from "./cache";
import type { ErrorClass, UrlErrorKind } from "./types";
import {
  gitAuthorizationHeaders,
  type GitHttpAuthorizationProvider,
} from "@/lib/git-http-auth";

// ---------------------------------------------------------------------------
// Error classification
// ---------------------------------------------------------------------------

/**
 * Thrown when a fetch fails with a known, structured reason.
 * Carries a UrlErrorKind so the UI can render specific messages.
 */
export class GitFetchError extends Error {
  readonly kind: UrlErrorKind;
  readonly isPermanent: boolean;

  constructor(message: string, kind: UrlErrorKind, permanent = true) {
    super(message);
    this.name = "GitFetchError";
    this.kind = kind;
    this.isPermanent = permanent;
  }
}

/** @deprecated Use GitFetchError instead */
export class PermanentFetchError extends GitFetchError {
  constructor(message: string, kind: UrlErrorKind = "network") {
    super(message, kind, true);
    this.name = "PermanentFetchError";
  }
}

/**
 * Only an explicit upload-pack rejection establishes that a server did not
 * serve the requested ref. Missing objects in a parsed response may instead
 * indicate an incomplete pack or a parser failure; classify those as fetch
 * errors, without making a claim about the server's stored objects.
 */
export function classifyObjectFetchError(
  err: unknown,
): { missing: true } | { missing: false; kind: UrlErrorKind } {
  if (err instanceof MissingRef) {
    return { missing: true };
  }
  // Aborts are not fetch failures — surface them so callers can short-circuit.
  if (err instanceof DOMException && err.name === "AbortError") {
    return { missing: false, kind: "transient" };
  }
  if (err instanceof GitFetchError) {
    return { missing: false, kind: err.kind };
  }
  // Anything else is a transport/parse failure. classifyFetchError separates
  // genuine HTTP/network errors from generic packfile transport breakage.
  const { kind } = classifyFetchError(err);
  // A generic/unclassified failure here means the git-upload-pack call or
  // packfile parse broke — label it packfile-error rather than transient so
  // the UI can say "couldn't fetch from this server".
  return {
    missing: false,
    kind: kind === "transient" ? "packfile-error" : kind,
  };
}

/**
 * Classify a fetch error to decide whether retrying is worthwhile.
 * Returns both the ErrorClass and the UrlErrorKind.
 */
export function classifyFetchError(err: unknown): {
  errorClass: ErrorClass;
  kind: UrlErrorKind;
} {
  if (err instanceof GitFetchError) {
    return {
      errorClass: err.isPermanent ? "permanent" : "transient",
      kind: err.kind,
    };
  }
  if (
    err instanceof Response ||
    (err && typeof err === "object" && "status" in err)
  ) {
    const status = (err as { status: number }).status;
    if (status === 401 || status === 403) {
      return { errorClass: "permanent", kind: "unauthorized" };
    }
    if (status >= 400 && status < 500 && status !== 429) {
      return { errorClass: "permanent", kind: "http-error" };
    }
    return { errorClass: "transient", kind: "transient" };
  }
  const msg =
    err instanceof Error
      ? err.message
      : typeof err === "string"
        ? err
        : String(err);
  if (
    /address.?unreachable|connection.?refused|err_failed|err_name_not_resolved/i.test(
      msg,
    )
  ) {
    return { errorClass: "permanent", kind: "network" };
  }
  const statusMatch = msg.match(/\b([1-5]\d{2})\b/);
  if (statusMatch) {
    const status = parseInt(statusMatch[1], 10);
    if (status >= 400 && status < 500 && status !== 429) {
      return { errorClass: "permanent", kind: "http-error" };
    }
  }
  return { errorClass: "transient", kind: "transient" };
}

/**
 * Returns true if the URL uses a non-HTTP scheme (ssh://, git://, file://, etc.)
 * that cannot be fetched by the browser.
 */
export function isNonHttpUrl(url: string): boolean {
  try {
    const scheme = new URL(url).protocol;
    return scheme !== "http:" && scheme !== "https:";
  } catch {
    // Bare "git@github.com:..." SCP-style SSH URLs don't parse as URLs
    return url.includes("@") && url.includes(":");
  }
}

// ---------------------------------------------------------------------------
// BigBatchError detection
// ---------------------------------------------------------------------------

/**
 * The git-natural-api packfile decompressor throws a non-exported BigBatchError
 * when the packfile is too large to decompress in one pass.
 * Detect it by class name since it is not exported.
 */
function isBigBatchError(err: unknown): boolean {
  return (
    err instanceof Error &&
    (err.constructor.name === "BigBatchError" ||
      err.message.includes("decompress too much data"))
  );
}

function parsedObjectToPackable(obj: ParsedObject): PackableObject | null {
  if (obj.type === 1) return { type: "commit", data: obj.data, hash: obj.hash };
  if (obj.type === 2) return { type: "tree", data: obj.data, hash: obj.hash };
  if (obj.type === 3) return { type: "blob", data: obj.data, hash: obj.hash };
  if (obj.type === 4) return { type: "tag", data: obj.data, hash: obj.hash };
  return null;
}

/** How many commits to request per batch when fetching commit history. */
const COMMIT_BATCH_SIZE = 15;

// ---------------------------------------------------------------------------
// README helpers
// ---------------------------------------------------------------------------

const README_NAMES = [
  "README.md",
  "readme.md",
  "README.markdown",
  "README",
  "readme",
  "README.txt",
  "readme.txt",
];

export { README_NAMES };

// ---------------------------------------------------------------------------
// Capability negotiation
//
// Mirrors the logic in git-natural-api/index.ts but operates on a
// capabilities array we already have — no extra HTTP request.
// ---------------------------------------------------------------------------

const NECESSARY_CAPS = ["multi_ack_detailed", "side-band-64k"];
const REQUIRED_CAPS = ["shallow", "object-format=sha1"];
const DEFAULT_CAPS = ["ofs-delta", "no-progress"];

/**
 * Select the capabilities to advertise in a want request, given the server's
 * capability list from infoRefs.
 *
 * Throws if a required capability is missing.
 */
function selectCapabilities(serverCaps: string[]): string[] {
  const caps: string[] = [];

  for (const cap of DEFAULT_CAPS) {
    if (serverCaps.includes(cap)) caps.push(cap);
  }
  for (const cap of NECESSARY_CAPS) {
    if (serverCaps.includes(cap)) caps.push(cap);
    else throw new Error(`git server missing required capability: ${cap}`);
  }
  for (const cap of REQUIRED_CAPS) {
    if (!serverCaps.includes(cap))
      throw new Error(`git server missing required capability: ${cap}`);
  }

  return caps;
}

// ---------------------------------------------------------------------------
// Low-level packfile helpers
// ---------------------------------------------------------------------------

/**
 * Fetch a single object (blob/commit/tree) by its hash.
 * Uses the capabilities from the already-fetched infoRefs.
 */
async function fetchObject(
  effectiveUrl: string,
  hash: string,
  serverCaps: string[],
  signal: AbortSignal,
  headers?: Record<string, string>,
): Promise<ParsedObject | undefined> {
  if (signal.aborted) return undefined;
  const caps = selectCapabilities(serverCaps);
  const want = createWantRequest(hash, caps, 1);
  const result = await fetchPackfile(effectiveUrl, want, signal, headers);
  if (signal.aborted) return undefined;
  return result.objects.get(hash);
}

function pktEncode(data: string): string {
  if (data.length === 0) return "0000";
  return `${(data.length + 4).toString(16).padStart(4, "0")}${data}`;
}

/** Build one upload-pack request containing multiple object wants. */
function createMultiWantRequest(
  hashes: string[],
  capabilities: string[],
): string {
  if (hashes.length === 0) throw new Error("at least one object is required");
  for (const hash of hashes) {
    if (!/^[0-9a-f]{40}$/i.test(hash)) {
      throw new Error(`invalid git object ID: ${hash}`);
    }
  }

  const [firstHash, ...remainingHashes] = hashes;
  const packets = [
    `want ${firstHash} ${capabilities.join(" ")} agent=nsa/1.0.0\n`,
    ...remainingHashes.map((hash) => `want ${hash}\n`),
    "deepen 1\n",
    "",
    "done\n",
  ];
  return packets.map(pktEncode).join("");
}

/** Fetch several directly-addressed objects in one upload-pack round trip. */
async function fetchObjects(
  effectiveUrl: string,
  hashes: string[],
  serverCaps: string[],
  signal: AbortSignal,
  headers?: Record<string, string>,
): Promise<Map<string, ParsedObject>> {
  if (signal.aborted || hashes.length === 0) return new Map();
  if (hashes.length === 1) {
    const object = await fetchObject(
      effectiveUrl,
      hashes[0],
      serverCaps,
      signal,
      headers,
    );
    return object ? new Map([[hashes[0], object]]) : new Map();
  }

  const capabilities = selectCapabilities(serverCaps);
  const want = createMultiWantRequest(hashes, capabilities);
  const result = await fetchPackfile(effectiveUrl, want, signal, headers);
  if (signal.aborted) return new Map();

  const objects = new Map<string, ParsedObject>();
  for (const hash of hashes) {
    const object = result.objects.get(hash);
    if (object) objects.set(hash, object);
  }
  return objects;
}

/**
 * Fetch commits only (tree:0 filter) up to maxCommits depth.
 * Requires the server to support "filter".
 */
async function fetchCommitsOnly(
  effectiveUrl: string,
  commitHash: string,
  maxCommits: number,
  serverCaps: string[],
  signal: AbortSignal,
  headers?: Record<string, string>,
): Promise<Commit[]> {
  if (signal.aborted) return [];
  const caps = selectCapabilities(serverCaps);
  if (!serverCaps.includes("filter"))
    throw new Error("git server does not support filter capability");
  caps.push("filter");
  const want = createWantRequest(commitHash, caps, maxCommits, "tree:0");
  const result = await fetchPackfile(effectiveUrl, want, signal, headers);
  if (signal.aborted) return [];
  const commits: Commit[] = [];
  for (const [hash, obj] of result.objects) {
    commits.push(parseCommit(obj.data, hash));
  }
  return commits;
}

/**
 * Fetch the directory tree at a commit (blob:none filter).
 * Requires the server to support "filter".
 *
 * Always passes deepen=1 to the server — fetching one commit's worth of tree
 * objects. The server sends ALL tree objects for that commit regardless of
 * this value; "deepen" only controls commit-graph ancestry traversal.
 *
 * @param parseDepth - How many directory levels to build in the returned Tree
 *                   structure. undefined = full recursive parse of everything
 *                   the server sent.
 *
 * Returns the parsed tree alongside the raw objects map and rootTreeHash so
 * callers can cache the raw objects for subsequent depth-only re-parses.
 */
async function fetchDirectoryTree(
  effectiveUrl: string,
  commitHash: string,
  serverCaps: string[],
  signal: AbortSignal,
  parseDepth?: number,
  headers?: Record<string, string>,
): Promise<{
  tree: Tree;
  rootTreeHash: string;
  rawObjects: Map<string, ParsedObject>;
}> {
  if (signal.aborted) throw new Error("aborted");
  const caps = selectCapabilities(serverCaps);
  if (!serverCaps.includes("filter"))
    throw new Error("git server does not support filter capability");
  caps.push("filter");
  // deepen=1: fetch only the tip commit. The server still sends ALL tree
  // objects for that commit, so parseDepth independently controls how much
  // of those objects loadTree() builds into the in-memory structure.
  const want = createWantRequest(commitHash, caps, 1, "blob:none");
  const result = await fetchPackfile(effectiveUrl, want, signal, headers);
  if (signal.aborted) throw new Error("aborted");

  const commitObj = result.objects.get(commitHash);
  if (!commitObj) throw new Error(`commit object not found: ${commitHash}`);

  const utf8 = new TextDecoder("utf-8");
  const rootTreeHash = utf8.decode(commitObj.data.slice(5, 45));
  const rootTreeObj = result.objects.get(rootTreeHash);
  if (!rootTreeObj) throw new Error(`root tree object not found`);

  // When parseDepth is undefined, loadTree recurses into every subtree object
  // the server sent — giving us the complete directory structure.
  const tree = loadTree(rootTreeObj, result.objects, parseDepth);
  return { tree, rootTreeHash, rawObjects: result.objects };
}

/**
 * Shallow clone: fetch commit + full tree (no filter).
 * Fallback for servers that don't support "filter".
 */
async function shallowClone(
  effectiveUrl: string,
  commitHash: string,
  serverCaps: string[],
  signal: AbortSignal,
  headers?: Record<string, string>,
): Promise<{ commit: Commit; tree: Tree }> {
  if (signal.aborted) throw new Error("aborted");
  const caps = selectCapabilities(serverCaps);
  const want = createWantRequest(commitHash, caps, 1);
  const result = await fetchPackfile(effectiveUrl, want, signal, headers);
  if (signal.aborted) throw new Error("aborted");

  const commitObj = result.objects.get(commitHash);
  if (!commitObj) throw new Error(`commit object not found: ${commitHash}`);

  const commit = parseCommit(commitObj.data, commitHash);

  const utf8 = new TextDecoder("utf-8");
  const rootTreeHash = utf8.decode(commitObj.data.slice(5, 45));
  const rootTreeObj = result.objects.get(rootTreeHash);
  if (!rootTreeObj) throw new Error(`root tree object not found`);

  return { commit, tree: loadTree(rootTreeObj, result.objects) };
}

/**
 * Navigate a Tree to find an entry at the given path segments.
 * Returns the TreeEntry if found, undefined otherwise.
 */
function findInTree(tree: Tree, segments: string[]): TreeEntry | undefined {
  if (segments.length === 0) return undefined;
  const [head, ...rest] = segments;
  const isLast = rest.length === 0;

  for (const dir of tree.directories) {
    if (dir.name === head) {
      if (isLast)
        return { path: head, mode: "40000", isDir: true, hash: dir.hash };
      if (dir.content) return findInTree(dir.content, rest);
      return undefined;
    }
  }
  if (isLast) {
    for (const file of tree.files) {
      if (file.name === head)
        return { path: head, mode: file.mode, isDir: false, hash: file.hash };
    }
  }
  return undefined;
}

// ---------------------------------------------------------------------------
// GitHttpClient
// ---------------------------------------------------------------------------

/**
 * Encapsulates all git HTTP operations with integrated caching and CORS proxy.
 *
 * Each pool creates one GitHttpClient. The client uses the pool's cache and
 * CORS proxy manager but doesn't know about URL racing or winner selection —
 * it operates on a single URL at a time.
 *
 * All operations use only the low-level exports from git-natural-api so that
 * the library never makes its own infoRefs HTTP requests.
 */
export class GitHttpClient {
  private cache: GitObjectCache;
  private cors: CorsProxyManager;
  private expectRepositoryProvisioning: boolean;
  private authorizationProvider?: GitHttpAuthorizationProvider;
  /** Aborts cache-warming work when the owning pool is disposed. */
  private lifecycleAbort = new AbortController();
  /**
   * In-flight dedup for infoRefs fetches. Prevents duplicate HTTP requests
   * when multiple callers request the same URL concurrently.
   */
  private inFlightInfoRefs = new Map<
    string,
    Promise<InfoRefsUploadPackResponse>
  >();
  /**
   * URLs whose infoRefs fetch permanently failed this session.
   * Checked synchronously to avoid any new HTTP request.
   */
  private permanentFailures = new Map<string, PermanentFetchError>();
  /**
   * Commit hashes for which a background full-parse idle task has been
   * queued but not yet completed.  Prevents duplicate tasks.
   */
  private pendingBackgroundParse = new Set<string>();
  /**
   * In-flight dedup for blob:none packfile fetches, keyed by commitHash.
   *
   * On first load, fetchCommit launches up to 7 concurrent findObjectByPath
   * calls (one per README_NAMES candidate) via Promise.any.  Without dedup,
   * every one of them would independently issue an identical blob:none HTTP
   * request.  This map ensures only one request is in flight per commit at
   * any time; subsequent callers join the existing promise.
   *
   * The stored promise uses the owning pool's lifetime signal. Individual
   * callers may stop waiting independently; disposing the pool aborts the
   * shared request and suppresses late cache writes.
   */
  private inFlightRawObjects = new Map<string, Promise<RawObjectsEntry>>();

  constructor(
    cache: GitObjectCache,
    cors: CorsProxyManager,
    expectRepositoryProvisioning = false,
    authorizationProvider?: GitHttpAuthorizationProvider,
  ) {
    this.cache = cache;
    this.cors = cors;
    this.expectRepositoryProvisioning = expectRepositoryProvisioning;
    this.authorizationProvider = authorizationProvider;
  }

  private getHeaders(
    repoUrl: string,
    signal?: AbortSignal,
  ): Promise<Record<string, string> | undefined> {
    return gitAuthorizationHeaders(this.authorizationProvider, repoUrl, signal);
  }

  /**
   * Resolve credentials immediately before an HTTP request and retry one
   * authentication rejection with a freshly signed short-lived token.
   */
  private async withAuthorizationRetry<T>(
    repoUrl: string,
    signal: AbortSignal,
    request: (headers?: Record<string, string>) => Promise<T>,
  ): Promise<T> {
    try {
      return await request(await this.getHeaders(repoUrl, signal));
    } catch (error) {
      const status =
        error && typeof error === "object" && "status" in error
          ? (error as { status?: unknown }).status
          : undefined;
      if (this.authorizationProvider && (status === 401 || status === 403)) {
        this.authorizationProvider.invalidateAuthorization(repoUrl);
        return request(await this.getHeaders(repoUrl, signal));
      }
      throw error;
    }
  }

  /** Couple caller cancellation to the lifetime of the account-scoped pool. */
  private operationSignal(signal: AbortSignal): AbortSignal {
    return AbortSignal.any([signal, this.lifecycleAbort.signal]);
  }

  /** Account-scoped lifetime shared by reads and background Git pushes. */
  get lifecycleSignal(): AbortSignal {
    return this.lifecycleAbort.signal;
  }

  /** Stop background work and forbid late cache writes after pool disposal. */
  dispose(): void {
    this.lifecycleAbort.abort();
    this.pendingBackgroundParse.clear();
  }

  /**
   * Empty repositories are expected while GRASP is creating a newly announced
   * mirror. Enabling this after a shared pool already probed the URLs must also
   * clear failures recorded by that early probe.
   */
  setExpectRepositoryProvisioning(expected: boolean): void {
    this.expectRepositoryProvisioning = expected;
    if (expected) this.permanentFailures.clear();
  }

  /** Check if a URL has permanently failed */
  isPermanentlyFailed(url: string): boolean {
    return this.permanentFailures.has(url);
  }

  /** Filter out permanently failed URLs */
  filterLiveUrls(urls: string[]): string[] {
    return urls.filter((u) => !this.permanentFailures.has(u));
  }

  // -----------------------------------------------------------------------
  // InfoRefs
  // -----------------------------------------------------------------------

  /**
   * Fetch infoRefs for a URL with cache, dedup, CORS proxy fallback, and
   * permanent failure tracking.
   *
   * The cache key is always the original URL. The effective URL (possibly
   * proxy-prefixed) is used for the actual HTTP request.
   */
  fetchInfoRefs(
    url: string,
    signal: AbortSignal,
  ): Promise<InfoRefsUploadPackResponse> {
    const waitSignal = this.operationSignal(signal);
    const lifecycleSignal = this.lifecycleAbort.signal;
    if (waitSignal.aborted) {
      return Promise.reject(new DOMException("Aborted", "AbortError"));
    }
    // Fast-path: already known to be permanently unreachable
    const knownFailure = this.permanentFailures.get(url);
    if (knownFailure) return Promise.reject(knownFailure);

    // Reuse in-flight request
    const existing = this.inFlightInfoRefs.get(url);
    if (existing) {
      return existing.then((info) => {
        if (waitSignal.aborted) throw new DOMException("Aborted", "AbortError");
        return info;
      });
    }

    const effectiveUrl = this.cors.resolveUrl(url);

    const fetchPromise: Promise<InfoRefsUploadPackResponse> = (async () => {
      // Check cache
      const cached = await this.cache.getInfoRefs(url);
      if (lifecycleSignal.aborted)
        throw new DOMException("Aborted", "AbortError");
      if (cached) return cached;

      try {
        const info = await this.withAuthorizationRetry(
          url,
          lifecycleSignal,
          (headers) => libGetInfoRefs(effectiveUrl, headers, lifecycleSignal),
        );
        // libGetInfoRefs does not check the HTTP status code — it calls
        // fetch().text() and parses the body as git pkt-line regardless of
        // status. A 404 HTML page produces an empty capabilities/refs object.
        // Treat that as a permanent failure so the URL is not retried.
        if (
          info.capabilities.length === 0 &&
          Object.keys(info.refs).length === 0
        ) {
          // If we went direct (no proxy), this is likely a 404 or wrong path
          const kind = effectiveUrl === url ? "not-git" : "proxy-error";
          const emptyResponse = new GitFetchError(
            `No git data returned from ${url} (server may have returned a non-git response)`,
            kind,
            !this.expectRepositoryProvisioning,
          );
          if (!this.expectRepositoryProvisioning && !lifecycleSignal.aborted) {
            this.permanentFailures.set(url, emptyResponse);
          }
          throw emptyResponse;
        }
        if (lifecycleSignal.aborted)
          throw new DOMException("Aborted", "AbortError");
        if (effectiveUrl === url) this.cors.markOriginDirect(url);
        this.cache.putInfoRefs(url, info);
        return info;
      } catch (err) {
        if (err instanceof GitFetchError) throw err;
        const status =
          err && typeof err === "object" && "status" in err
            ? (err as { status: number }).status
            : undefined;
        if (this.expectRepositoryProvisioning && status === 404) {
          throw new GitFetchError(
            `Repository at ${url} has not been provisioned yet`,
            "http-error",
            false,
          );
        }
        const { errorClass, kind } = classifyFetchError(err);
        if (errorClass === "permanent") {
          const msg = err instanceof Error ? err.message : String(err);
          const permanent = new GitFetchError(
            `Permanent HTTP error for ${url}: ${msg}`,
            kind,
          );
          if (!lifecycleSignal.aborted)
            this.permanentFailures.set(url, permanent);
          throw permanent;
        }
        // Already tried via proxy — both paths failed
        if (effectiveUrl !== url) {
          const msg = err instanceof Error ? err.message : String(err);
          const permanent = new GitFetchError(
            `Both direct and proxy fetch failed for ${url}: ${msg}`,
            "cors-blocked",
          );
          if (!lifecycleSignal.aborted)
            this.permanentFailures.set(url, permanent);
          throw permanent;
        }
        // Only attempt proxy fallback for CORS-like errors
        if (!this.cors.enabled || !this.cors.isCorsLikeError(err)) throw err;

        const proxyUrl = this.cors.toProxyUrl(url);
        try {
          const info = await libGetInfoRefs(
            proxyUrl,
            undefined,
            lifecycleSignal,
          );
          // Same empty-response check for the proxy path.
          // Empty response via proxy = proxy reached the server but got a
          // non-git response (e.g. Cloudflare 523, nginx 502, etc.)
          if (
            info.capabilities.length === 0 &&
            Object.keys(info.refs).length === 0
          ) {
            const emptyResponse = new GitFetchError(
              `No git data returned from ${url} via proxy (server may have returned a non-git response)`,
              "proxy-error",
              !this.expectRepositoryProvisioning,
            );
            if (
              !this.expectRepositoryProvisioning &&
              !lifecycleSignal.aborted
            ) {
              this.permanentFailures.set(url, emptyResponse);
            }
            throw emptyResponse;
          }
          if (lifecycleSignal.aborted)
            throw new DOMException("Aborted", "AbortError");
          this.cors.markOriginNeedsProxy(url);
          this.cache.putInfoRefs(url, info);
          return info;
        } catch (proxyErr) {
          if (proxyErr instanceof GitFetchError) throw proxyErr;
          const msg =
            proxyErr instanceof Error ? proxyErr.message : String(proxyErr);
          const permanent = new GitFetchError(
            `Both direct and proxy fetch failed for ${url}: ${msg}`,
            "cors-blocked",
          );
          if (!lifecycleSignal.aborted)
            this.permanentFailures.set(url, permanent);
          throw permanent;
        }
      }
    })();

    this.inFlightInfoRefs.set(url, fetchPromise);
    // Chain cleanup to the returned promise so a rejection of `fetchPromise`
    // has a handler even if the caller aborts and stops awaiting the return
    // value. Previously this was a bare `fetchPromise.finally(...)` whose
    // implicit rejection had no `.catch`, which triggered
    // `unhandledRejection` in Node when e.g. a test tore down its git server
    // mid-flight (see e2e — lagging Grasp mirror merge fan-out > keeps the
    // merge successful when B is down and records B's failure).
    return fetchPromise
      .then((info) => {
        if (waitSignal.aborted) throw new DOMException("Aborted", "AbortError");
        return info;
      })
      .finally(() => this.inFlightInfoRefs.delete(url));
  }

  // -----------------------------------------------------------------------
  // Private: capability resolution
  // -----------------------------------------------------------------------

  /**
   * Get server capabilities for a URL.
   *
   * Peeks the L1 cache first (zero cost when the pool has already fetched
   * infoRefs). Falls back to a full fetchInfoRefs call — which is itself
   * deduped and cached — for the case where fetchCommit is called concurrently
   * with the infoRefs race (e.g. fetchStateCommit).
   */
  private async getServerCaps(
    url: string,
    signal: AbortSignal,
  ): Promise<string[]> {
    const cached = this.cache.peekInfoRefs(url);
    if (cached) return cached.capabilities;
    const info = await this.fetchInfoRefs(url, signal);
    return info.capabilities;
  }

  // -----------------------------------------------------------------------
  // Commits
  // -----------------------------------------------------------------------

  /**
   * Fetch a single commit's metadata, checking cache first.
   * Returns the commit + optional README content.
   */
  async fetchCommit(
    url: string,
    commitHash: string,
    supportsFilter: boolean,
    signal: AbortSignal,
  ): Promise<{
    commit: Commit;
    readmeContent: string | null;
    readmeFilename: string | null;
  } | null> {
    signal = this.operationSignal(signal);
    const effectiveUrl = this.cors.resolveUrl(url);
    const serverCaps = await this.getServerCaps(url, signal);
    if (signal.aborted) return null;

    // Check commit cache
    const cachedCommit = await this.cache.getCommit(commitHash);
    if (signal.aborted) return null;
    if (cachedCommit) {
      // Try to get README from text cache
      let readmeContent: string | null = null;
      let readmeFilename: string | null = null;
      for (const name of README_NAMES) {
        const text = this.cache.getText(commitHash, name);
        if (text !== undefined) {
          readmeContent = text;
          readmeFilename = name;
          break;
        }
      }
      // If not in text cache, try fetching the blob directly
      if (!readmeContent && serverCaps.length > 0) {
        for (const name of README_NAMES) {
          try {
            const entry = await this.findObjectByPath(
              url,
              effectiveUrl,
              commitHash,
              name,
              serverCaps,
              signal,
            );
            if (signal.aborted) return null;
            if (!entry || entry.isDir) continue;
            const blobData = await this.fetchBlobByHash(
              url,
              effectiveUrl,
              entry.hash,
              serverCaps,
              signal,
            );
            if (signal.aborted) return null;
            if (blobData) {
              const text = new TextDecoder("utf-8").decode(blobData);
              if (!signal.aborted) this.cache.putText(commitHash, name, text);
              readmeContent = text;
              readmeFilename = name;
              break;
            }
          } catch {
            // Try next README name
          }
        }
      }
      return { commit: cachedCommit, readmeContent, readmeFilename };
    }

    // Commit not cached — fetch from git server
    if (signal.aborted) return null;

    try {
      let commit: Commit;
      let readmeContent: string | null = null;
      let readmeFilename: string | null = null;

      if (supportsFilter && serverCaps.length > 0) {
        const [commits, readmeResult] = await Promise.all([
          this.withAuthorizationRetry(url, signal, (headers) =>
            fetchCommitsOnly(
              effectiveUrl,
              commitHash,
              1,
              serverCaps,
              signal,
              headers,
            ),
          ),
          Promise.any(
            README_NAMES.map(async (name) => {
              const entry = await this.findObjectByPath(
                url,
                effectiveUrl,
                commitHash,
                name,
                serverCaps,
                signal,
              );
              if (!entry || entry.isDir) throw new Error(`${name} not found`);
              const cachedBlob = await this.cache.getBlob(entry.hash);
              if (cachedBlob) {
                const text = new TextDecoder("utf-8").decode(cachedBlob);
                if (!signal.aborted) this.cache.putText(commitHash, name, text);
                return { name, content: text };
              }
              const blobData = await this.fetchBlobByHash(
                url,
                effectiveUrl,
                entry.hash,
                serverCaps,
                signal,
              );
              if (!blobData) throw new Error(`${name} blob missing`);
              const text = new TextDecoder("utf-8").decode(blobData);
              if (!signal.aborted) this.cache.putText(commitHash, name, text);
              return { name, content: text };
            }),
          ).catch(() => null),
        ]);

        if (signal.aborted) return null;
        if (!commits || commits.length === 0) return null;

        commit = commits[0];
        readmeContent = readmeResult?.content ?? null;
        readmeFilename = readmeResult?.name ?? null;
      } else {
        // Fallback: shallow clone (no filter capability)
        const result = await this.withAuthorizationRetry(
          url,
          signal,
          (headers) =>
            shallowClone(effectiveUrl, commitHash, serverCaps, signal, headers),
        );
        if (signal.aborted) return null;

        commit = result.commit;

        for (const name of README_NAMES) {
          const file = result.tree.files.find((f) => f.name === name);
          if (file?.content) {
            const text = new TextDecoder("utf-8").decode(file.content);
            if (!signal.aborted) {
              this.cache.putBlob(file.hash, file.content);
              this.cache.putText(commitHash, name, text);
            }
            readmeFilename = name;
            readmeContent = text;
            break;
          }
        }
      }

      if (!signal.aborted) this.cache.putCommit(commit);
      return { commit, readmeContent, readmeFilename };
    } catch {
      return null;
    }
  }

  /**
   * Fetch commit history for a ref, checking cache first.
   */
  async fetchCommitHistory(
    url: string,
    commitHash: string,
    maxCommits: number,
    signal: AbortSignal,
    untilHash?: string,
  ): Promise<Commit[] | null> {
    signal = this.operationSignal(signal);
    // Check cache
    const cached = await this.cache.getCommitHistory(commitHash, maxCommits);
    if (signal.aborted) return null;
    if (cached) return cached;

    const effectiveUrl = this.cors.resolveUrl(url);
    const serverCaps = await this.getServerCaps(url, signal);
    if (signal.aborted) return null;

    // Fetch in small batches starting from the tip. Follow every parent
    // frontier so merge-heavy PR histories include commits retained through
    // second-parent side branches. Stop at the merge base (untilHash), root
    // commits, or maxCommits.
    // On BigBatchError, halve the batch size and retry the same range.
    const allCommits: Commit[] = [];
    const seen = new Set<string>();
    const queued = new Set<string>([commitHash]);
    const queue = [commitHash];
    let batchSize = Math.min(COMMIT_BATCH_SIZE, maxCommits);

    while (queue.length > 0 && allCommits.length < maxCommits) {
      const nextWant = queue.shift();
      if (!nextWant) break;

      const remaining = maxCommits - allCommits.length;
      const thisDepth = Math.min(batchSize, remaining);

      try {
        const commits = await this.withAuthorizationRetry(
          url,
          signal,
          (headers) =>
            fetchCommitsOnly(
              effectiveUrl,
              nextWant,
              thisDepth,
              serverCaps,
              signal,
              headers,
            ),
        );
        if (signal.aborted) return null;

        // Empty response on the first batch means the server doesn't have this
        // commit — return null so withFallback tries the next URL. Empty later
        // responses only mean this frontier was exhausted; keep trying any
        // other queued parents.
        if (commits.length === 0) {
          if (allCommits.length === 0) return null;
          continue;
        }

        const batchHashes = new Set(commits.map((commit) => commit.hash));
        const newCommits = commits.filter((commit) => !seen.has(commit.hash));
        for (const commit of newCommits) {
          if (!signal.aborted) this.cache.putCommit(commit);
          seen.add(commit.hash);
          allCommits.push(commit);
        }

        // Continue every parent frontier, not just first-parent. Merge-heavy PRs
        // can keep commits on second-parent side branches; a first-parent walk
        // incorrectly treats those retained commits as outdated.
        for (const commit of newCommits) {
          if (commit.hash === untilHash) continue;
          for (const parent of commit.parents) {
            if (
              !seen.has(parent) &&
              !batchHashes.has(parent) &&
              !queued.has(parent)
            ) {
              queued.add(parent);
              queue.push(parent);
            }
          }
        }
      } catch (err) {
        if (signal.aborted) return null;
        if (!isBigBatchError(err)) {
          if (allCommits.length === 0) return null;
          break;
        }
        // BigBatchError: halve the batch size and retry the same range.
        if (batchSize <= 1) break;
        batchSize = Math.floor(batchSize / 2);
        queue.unshift(nextWant);
      }
    }

    if (allCommits.length === 0) return null;

    const sorted = [...allCommits].sort(
      (a, b) =>
        (b.committer?.timestamp ?? b.author.timestamp) -
        (a.committer?.timestamp ?? a.author.timestamp),
    );

    if (!signal.aborted)
      this.cache.putCommitHistory(commitHash, maxCommits, sorted);
    return sorted;
  }

  // -----------------------------------------------------------------------
  // Trees
  // -----------------------------------------------------------------------

  /**
   * Fetch directory tree at a commit, checking cache first.
   *
   * Cache hierarchy:
   *  1. Parsed tree cache (L1 + IDB) — check for any entry with nestLimit >=
   *     the requested depth; a deeper cached parse satisfies a shallower request.
   *  2. Raw objects cache (L1 only) — if we already have the packfile objects
   *     in memory from a previous fetch, re-parse at the new depth without any
   *     network request.
   *  3. Network fetch — always with deepen=1 (fetches one commit's tree objects).
   *     After fetching, raw objects are stashed in L1 so subsequent requests
   *     at any depth skip the network. A background idle task then does the
   *     full recursive parse and warms the parsed-tree cache at FULL_NEST_LIMIT.
   */
  async fetchTree(
    url: string,
    commitHash: string,
    nestLimit: number,
    signal: AbortSignal,
  ): Promise<Tree> {
    signal = this.operationSignal(signal);
    // 1. Parsed tree cache (L1 + IDB, with >= nestLimit check)
    const cached = await this.cache.getTree(commitHash, nestLimit);
    signal.throwIfAborted();
    if (cached) return cached;

    // 2. Raw objects cache / in-flight dedup / network fetch (all via getRawObjects)
    const effectiveUrl = this.cors.resolveUrl(url);
    const serverCaps = await this.getServerCaps(url, signal);
    signal.throwIfAborted();

    const rawEntry = await this.getRawObjects(
      url,
      effectiveUrl,
      commitHash,
      serverCaps,
      signal,
    );
    signal.throwIfAborted();

    const rootObj = rawEntry.objects.get(rawEntry.rootTreeHash);
    if (!rootObj) {
      throw new GitFetchError(
        `root tree object not found for commit ${commitHash}`,
        "packfile-error",
        false,
      );
    }

    const tree = loadTree(rootObj, rawEntry.objects, nestLimit);
    if (!signal.aborted) {
      this.cache.putTree(commitHash, nestLimit, tree);
      this.scheduleBackgroundFullParse(commitHash, rawEntry);
    }
    return tree;
  }

  /**
   * Fetch the complete recursive directory tree at a commit for diff purposes,
   * and return the commit object alongside it.
   *
   * Uses deepen=1 (one commit, no ancestors) with blob:none (no file content).
   * The server sends ALL tree objects for that commit; we parse all of them
   * into a fully-recursive Tree structure. The commit object is present in the
   * same packfile response, so we parse and cache it here — eliminating the
   * need for a separate getSingleCommit network request.
   *
   * Cache: the tree is stored via cache.putFullTree(). The commit is stored
   * via cache.putCommit() so it is available to getSingleCommit callers too.
   */
  async fetchFullTree(
    url: string,
    commitHash: string,
    signal: AbortSignal,
  ): Promise<{ commit: Commit; tree: Tree } | null> {
    signal = this.operationSignal(signal);
    // Check both caches synchronously first
    const cachedTree = this.cache.peekFullTree(commitHash);
    const cachedCommit = this.cache.peekCommit(commitHash);
    if (cachedTree && cachedCommit)
      return { commit: cachedCommit, tree: cachedTree };

    // Async cache check
    const [asyncTree, asyncCommit] = await Promise.all([
      cachedTree
        ? Promise.resolve(cachedTree)
        : this.cache.getFullTree(commitHash),
      cachedCommit
        ? Promise.resolve(cachedCommit)
        : this.cache.getCommit(commitHash),
    ]);
    if (signal.aborted) return null;
    if (asyncTree && asyncCommit)
      return { commit: asyncCommit, tree: asyncTree };

    const effectiveUrl = this.cors.resolveUrl(url);
    const serverCaps = await this.getServerCaps(url, signal);
    if (signal.aborted) return null;

    try {
      const caps = selectCapabilities(serverCaps);
      if (!serverCaps.includes("filter"))
        throw new Error("git server does not support filter capability");
      caps.push("filter");

      // deepen=1: fetch only the tip commit (server still sends all its trees)
      // blob:none: no file content, only tree objects
      const want = createWantRequest(commitHash, caps, 1, "blob:none");
      const result = await this.withAuthorizationRetry(url, signal, (headers) =>
        fetchPackfile(effectiveUrl, want, signal, headers),
      );
      if (signal.aborted) return null;

      const commitObj = result.objects.get(commitHash);
      if (!commitObj) throw new Error(`commit object not found: ${commitHash}`);

      // Parse the commit from the same packfile response — no extra request
      const commit = parseCommit(commitObj.data, commitHash);

      const utf8Decoder = new TextDecoder("utf-8");
      const rootTreeHash = utf8Decoder.decode(commitObj.data.slice(5, 45));
      const rootTreeObj = result.objects.get(rootTreeHash);
      if (!rootTreeObj) throw new Error(`root tree object not found`);

      // parseDepth=undefined: build the complete recursive Tree structure
      const tree = loadTree(rootTreeObj, result.objects, undefined);
      if (signal.aborted) return null;

      if (!signal.aborted) {
        this.cache.putCommit(commit);
        this.cache.putFullTree(commitHash, tree);
      }
      return { commit, tree };
    } catch {
      if (signal.aborted) return null;
      return null;
    }
  }

  // -----------------------------------------------------------------------
  // Blobs / objects
  // -----------------------------------------------------------------------

  /**
   * Fetch a blob by its object hash, checking cache first.
   */
  async fetchBlob(
    url: string,
    blobHash: string,
    signal: AbortSignal,
  ): Promise<Uint8Array | null> {
    signal = this.operationSignal(signal);
    const cached = await this.cache.getBlob(blobHash);
    if (signal.aborted) return null;
    if (cached) return cached;

    const effectiveUrl = this.cors.resolveUrl(url);
    const serverCaps = await this.getServerCaps(url, signal);
    if (signal.aborted) return null;

    try {
      const data = await this.fetchBlobByHash(
        url,
        effectiveUrl,
        blobHash,
        serverCaps,
        signal,
      );
      if (signal.aborted) return null;
      return data;
    } catch {
      if (signal.aborted) return null;
      return null;
    }
  }

  /**
   * Fetch multiple blobs in one upload-pack request. The pool checks both
   * cache tiers before calling this method; this layer only repeats a cheap L1
   * check in case another concurrent request populated a blob in the meantime.
   * A partial map is valid so callers can retry missing hashes elsewhere.
   */
  async fetchBlobs(
    url: string,
    blobHashes: string[],
    signal: AbortSignal,
  ): Promise<Map<string, Uint8Array> | null> {
    signal = this.operationSignal(signal);
    const blobs = new Map<string, Uint8Array>();
    const missing: string[] = [];

    for (const hash of new Set(blobHashes)) {
      const cached = this.cache.peekBlob(hash);
      if (cached) blobs.set(hash, cached);
      else missing.push(hash);
    }

    if (signal.aborted) return null;
    if (missing.length === 0) return blobs;

    const effectiveUrl = this.cors.resolveUrl(url);
    const serverCaps = await this.getServerCaps(url, signal);
    if (signal.aborted) return null;

    try {
      const objects = await this.withAuthorizationRetry(
        url,
        signal,
        (headers) =>
          fetchObjects(effectiveUrl, missing, serverCaps, signal, headers),
      );
      if (signal.aborted) return null;

      for (const [hash, object] of objects) {
        if (object.type !== 3) continue;
        if (!signal.aborted) this.cache.putBlob(hash, object.data);
        blobs.set(hash, object.data);
      }

      return blobs.size > 0 ? blobs : null;
    } catch {
      if (signal.aborted) return null;
      return null;
    }
  }

  /**
   * Fetch an object by path within a commit, checking cache first.
   * Returns the tree entry metadata (hash, isDir) and optionally the blob data.
   */
  async fetchObjectByPath(
    url: string,
    commitHash: string,
    path: string,
    signal: AbortSignal,
  ): Promise<{ entry: TreeEntry; data: Uint8Array | null } | null> {
    signal = this.operationSignal(signal);
    const effectiveUrl = this.cors.resolveUrl(url);
    const serverCaps = await this.getServerCaps(url, signal);
    if (signal.aborted) return null;

    try {
      const entry = await this.findObjectByPath(
        url,
        effectiveUrl,
        commitHash,
        path,
        serverCaps,
        signal,
      );
      if (signal.aborted) return null;
      if (!entry) return null;

      if (entry.isDir) {
        return { entry, data: null };
      }

      // Fetch the blob
      const data = await this.fetchBlob(url, entry.hash, signal);
      if (signal.aborted) return null;
      return { entry, data };
    } catch {
      if (signal.aborted) return null;
      return null;
    }
  }

  /**
   * Fetch a single commit by hash.
   */
  async fetchSingleCommit(
    url: string,
    commitOrRef: string,
    signal: AbortSignal,
  ): Promise<Commit | null> {
    signal = this.operationSignal(signal);
    // Check cache first (only for commit hashes, not refs)
    if (/^[0-9a-f]{40}$/i.test(commitOrRef)) {
      const cached = await this.cache.getCommit(commitOrRef);
      if (signal.aborted) return null;
      if (cached) return cached;
    }

    const effectiveUrl = this.cors.resolveUrl(url);
    const serverCaps = await this.getServerCaps(url, signal);
    if (signal.aborted) return null;

    try {
      const commits = await this.withAuthorizationRetry(
        url,
        signal,
        (headers) =>
          fetchCommitsOnly(
            effectiveUrl,
            commitOrRef,
            1,
            serverCaps,
            signal,
            headers,
          ),
      );
      if (signal.aborted) return null;
      if (commits.length === 0) return null;
      const commit = commits[0];
      if (!signal.aborted) this.cache.putCommit(commit);
      return commit;
    } catch {
      if (signal.aborted) return null;
      return null;
    }
  }

  /**
   * Prove that a server can supply a commit without consulting either object
   * cache. The fetched commit is still cached as a side effect for later reads.
   */
  async fetchSingleCommitFromNetwork(
    url: string,
    commitHash: string,
    signal: AbortSignal,
  ): Promise<Commit | null> {
    signal = this.operationSignal(signal);
    const effectiveUrl = this.cors.resolveUrl(url);
    const serverCaps = await this.getServerCaps(url, signal);
    if (signal.aborted) return null;

    try {
      const commits = await this.withAuthorizationRetry(
        url,
        signal,
        (headers) =>
          fetchCommitsOnly(
            effectiveUrl,
            commitHash,
            1,
            serverCaps,
            signal,
            headers,
          ),
      );
      if (signal.aborted || commits.length === 0) return null;
      const commit = commits.find(
        ({ hash }) => hash.toLowerCase() === commitHash.toLowerCase(),
      );
      if (!commit) return null;
      if (!signal.aborted) this.cache.putCommit(commit);
      return commit;
    } catch {
      if (signal.aborted) return null;
      return null;
    }
  }

  /**
   * Fetch raw, packable objects reachable from a commit.
   *
   * Browser PR merges cannot assume the target Grasp server already has the PR
   * author's fork commits. This returns full commit/tree/blob/tag objects that
   * can be included in the receive-pack request with the new merge commit or
   * preserved annotated tags.
   */
  async fetchPackableObjects(
    url: string,
    commitHash: string,
    maxCommits: number,
    signal: AbortSignal,
    haveCommitIds: string[] = [],
  ): Promise<PackableObject[] | null> {
    signal = this.operationSignal(signal);
    const effectiveUrl = this.cors.resolveUrl(url);
    const serverCaps = await this.getServerCaps(url, signal);
    if (signal.aborted) return null;

    try {
      const caps = selectCapabilities(serverCaps);
      const want = createWantRequest(
        commitHash,
        caps,
        haveCommitIds.length > 0 ? undefined : maxCommits,
        undefined,
        haveCommitIds,
      );
      const result = await this.withAuthorizationRetry(url, signal, (headers) =>
        fetchPackfile(effectiveUrl, want, signal, headers),
      );
      if (signal.aborted) return null;

      const objects: PackableObject[] = [];
      for (const obj of result.objects.values()) {
        const packable = parsedObjectToPackable(obj);
        if (!packable) continue;

        objects.push(packable);
        if (packable.type === "blob") {
          if (!signal.aborted) this.cache.putBlob(packable.hash, packable.data);
        } else if (packable.type === "commit") {
          try {
            if (!signal.aborted)
              this.cache.putCommit(parseCommit(packable.data, packable.hash));
          } catch {
            // Cache warming is best-effort; the raw object is still pushable.
          }
        }
      }

      return objects;
    } catch {
      if (signal.aborted) return null;
      return null;
    }
  }

  // -----------------------------------------------------------------------
  // Private helpers
  // -----------------------------------------------------------------------

  /**
   * Fetch a blob by hash using the low-level packfile API.
   * Checks L1/L2 cache first, then fetches from the server.
   */
  private async fetchBlobByHash(
    repoUrl: string,
    effectiveUrl: string,
    hash: string,
    serverCaps: string[],
    signal: AbortSignal,
  ): Promise<Uint8Array | null> {
    const cached =
      this.cache.peekBlob(hash) ?? (await this.cache.getBlob(hash));
    if (signal.aborted) return null;
    if (cached) return cached;

    if (signal.aborted) return null;
    const obj = await this.withAuthorizationRetry(repoUrl, signal, (headers) =>
      fetchObject(effectiveUrl, hash, serverCaps, signal, headers),
    );
    if (signal.aborted) return null;
    if (!obj) return null;
    if (!signal.aborted) this.cache.putBlob(hash, obj.data);
    return obj.data;
  }

  /**
   * Find a tree entry by path within a commit.
   * Uses raw objects cache when available; falls back to a network fetch.
   */
  private async findObjectByPath(
    repoUrl: string,
    effectiveUrl: string,
    commitHash: string,
    path: string,
    serverCaps: string[],
    signal: AbortSignal,
  ): Promise<TreeEntry | undefined> {
    const normalizedPath = path
      .replace(/\\/g, "/")
      .replace(/^\/+/, "")
      .replace(/\/+$/, "");
    const segments = normalizedPath === "" ? [] : normalizedPath.split("/");
    if (segments.length === 0) return undefined;

    const nestLimit = segments.length;

    // Raw objects cache / in-flight dedup / network fetch (all via getRawObjects)
    const rawEntry = await this.getRawObjects(
      repoUrl,
      effectiveUrl,
      commitHash,
      serverCaps,
      signal,
    );
    if (signal.aborted) return undefined;

    const rootObj = rawEntry.objects.get(rawEntry.rootTreeHash);
    if (!rootObj) return undefined;

    const tree = loadTree(rootObj, rawEntry.objects, nestLimit);
    this.scheduleBackgroundFullParse(commitHash, rawEntry);
    return findInTree(tree, segments);
  }

  /**
   * Get the raw blob:none packfile objects for a commit, with three tiers:
   *
   *  1. L1 raw objects cache — synchronous, zero cost.
   *  2. In-flight dedup — if a blob:none request for this commit is already
   *     in progress (e.g. several README name candidates from fetchCommit
   *     running concurrently), all callers share the single in-flight promise
   *     instead of each launching an identical HTTP request.
   *  3. Network fetch — fetchDirectoryTree with deepen=1 and a pool-lifetime
   *     signal. This shared raw-object warmup may outlive one caller, but pool
   *     disposal aborts it and prevents any late cache writes.
   *
   * Each caller checks its own signal after awaiting this method.
   */
  private async getRawObjects(
    repoUrl: string,
    effectiveUrl: string,
    commitHash: string,
    serverCaps: string[],
    signal: AbortSignal,
  ): Promise<RawObjectsEntry> {
    if (this.lifecycleAbort.signal.aborted) {
      return Promise.reject(new DOMException("Aborted", "AbortError"));
    }

    // 1. L1 hit
    const cached = this.cache.peekRawObjects(commitHash);
    if (cached) return Promise.resolve(cached);

    // 2. Join in-flight request
    const inFlight = this.inFlightRawObjects.get(commitHash);
    if (inFlight) {
      return inFlight.then((entry) => {
        if (signal.aborted) throw new DOMException("Aborted", "AbortError");
        return entry;
      });
    }

    // 3. Start new fetch — shared by callers but bounded by the pool lifetime
    if (signal.aborted)
      return Promise.reject(new DOMException("Aborted", "AbortError"));

    const fetchPromise = this.withAuthorizationRetry(
      repoUrl,
      this.lifecycleAbort.signal,
      (headers) =>
        fetchDirectoryTree(
          effectiveUrl,
          commitHash,
          serverCaps,
          this.lifecycleAbort.signal,
          1, // parseDepth=1; callers re-parse from the shared raw objects
          headers,
        ),
    )
      .then((result) => {
        if (this.lifecycleAbort.signal.aborted) {
          throw new DOMException("Aborted", "AbortError");
        }
        const entry: RawObjectsEntry = {
          rootTreeHash: result.rootTreeHash,
          objects: result.rawObjects,
        };
        this.cache.putRawObjects(commitHash, entry);

        // The commit object is always present in the blob:none packfile
        // (it is the "want" object). Parsing and caching it here means
        // fetchCommit's getCommit() check returns a hit, eliminating the
        // parallel tree:0 (fetchCommitsOnly) request on initial load.
        if (!this.cache.peekCommit(commitHash)) {
          const commitObj = result.rawObjects.get(commitHash);
          if (commitObj) {
            try {
              this.cache.putCommit(parseCommit(commitObj.data, commitHash));
            } catch {
              // parseCommit failure is non-fatal — fetchCommit will retry
            }
          }
        }

        return entry;
      })
      .finally(() => {
        this.inFlightRawObjects.delete(commitHash);
      });

    this.inFlightRawObjects.set(commitHash, fetchPromise);
    return fetchPromise.then((entry) => {
      if (signal.aborted) throw new DOMException("Aborted", "AbortError");
      return entry;
    });
  }

  /**
   * Schedule a background idle task to fully parse all tree objects for a
   * commit and warm the parsed-tree cache at FULL_NEST_LIMIT.
   *
   * This means that after the first (shallow) render, subsequent navigations
   * to any depth within the same commit skip both the network and the re-parse.
   *
   * Uses requestIdleCallback when available; falls back to setTimeout(0).
   * Deduplicates: at most one pending task per commitHash.
   */
  private scheduleBackgroundFullParse(
    commitHash: string,
    rawEntry: RawObjectsEntry,
  ): void {
    if (this.lifecycleAbort.signal.aborted) return;
    // Already have a full parse cached or scheduled
    if (this.cache.peekTree(commitHash, FULL_NEST_LIMIT)) return;
    if (this.pendingBackgroundParse.has(commitHash)) return;

    this.pendingBackgroundParse.add(commitHash);

    const run = () => {
      this.pendingBackgroundParse.delete(commitHash);
      if (this.lifecycleAbort.signal.aborted) return;
      // Double-check after idle — another path may have populated the cache
      if (this.cache.peekTree(commitHash, FULL_NEST_LIMIT)) return;
      const rootObj = rawEntry.objects.get(rawEntry.rootTreeHash);
      if (!rootObj) return;
      // parseDepth=undefined → fully recursive parse of all objects the server sent
      const fullTree = loadTree(rootObj, rawEntry.objects, undefined);
      this.cache.putTree(commitHash, FULL_NEST_LIMIT, fullTree);
    };

    if (typeof requestIdleCallback !== "undefined") {
      requestIdleCallback(run);
    } else {
      setTimeout(run, 0);
    }
  }
}
