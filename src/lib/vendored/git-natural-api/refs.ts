/**
 * Vendored from @fiatjaf/git-natural-api v0.2.4
 * https://jsr.io/@fiatjaf/git-natural-api
 *
 * Local modification: info/refs requests accept an AbortSignal so an
 * account-scoped private Git pool cannot complete after it is disposed.
 */

/** Repository information from the Git protocol */
export type InfoRefsUploadPackResponse = {
  refs: { [ref: string]: string }; // Map of reference names to commit hashes
  capabilities: string[]; // Server capabilities
  symrefs: Record<string, string>; // Symbolic references
};

const capabilitiesCache = new Map<string, string[]>();

export async function getCapabilities(
  url: string,
  weAlreadyHaveSomeInfoRefsResponse?: InfoRefsUploadPackResponse,
  headers?: Record<string, string>,
  signal?: AbortSignal,
): Promise<string[]> {
  if (signal?.aborted) throw new DOMException("Aborted", "AbortError");
  if (weAlreadyHaveSomeInfoRefsResponse) {
    // if this was passed just extract the capabilities from it and update the cache
    capabilitiesCache.set(url, weAlreadyHaveSomeInfoRefsResponse.capabilities);
    return weAlreadyHaveSomeInfoRefsResponse.capabilities;
  }

  const cached = capabilitiesCache.get(url);
  if (cached) return cached;

  const info = await getInfoRefs(url, headers, signal);
  if (signal?.aborted) throw new DOMException("Aborted", "AbortError");
  capabilitiesCache.set(url, info.capabilities);
  return info.capabilities;
}

/**
 * Fetches repository information including available references and server capabilities.
 * @param url Base URL of the Git repository
 * @returns Promise resolving to repository reference information
 */
export async function getInfoRefs(
  url: string,
  headers?: Record<string, string>,
  signal?: AbortSignal,
): Promise<InfoRefsUploadPackResponse> {
  if (signal?.aborted) throw new DOMException("Aborted", "AbortError");
  const httpResponse = await fetch(`${url}/info/refs?service=git-upload-pack`, {
    headers,
    signal,
  });
  if (!httpResponse.ok) {
    throw new Response(null, {
      status: httpResponse.status,
      statusText: httpResponse.statusText,
      headers: httpResponse.headers,
    });
  }
  const response = await httpResponse.text();
  if (signal?.aborted) throw new DOMException("Aborted", "AbortError");
  const result: InfoRefsUploadPackResponse = {
    refs: {},
    capabilities: [],
    symrefs: {},
  };

  const lines = response.split("\n").filter((line) => line.length > 0);
  for (let i = 0; i < lines.length; i++) {
    let line = lines[i];

    // skip flush packets (0000)
    if (line.startsWith("0000")) line = line.slice(4);

    // parse pkt-line format (4-byte hex length prefix)
    const length = parseInt(line.substring(0, 4), 16);
    if (isNaN(length)) continue;

    const content = line.substring(4, length);

    // first line should be the service announcement
    if (i === 0 && content.startsWith("# service=")) {
      continue;
    }

    // parse ref lines
    if (content.includes(" ")) {
      const parts = content.split(" ");
      const hash = parts[0];
      const refAndCaps = parts.slice(1).join(" ");

      // check if this line includes capabilities (first ref only)
      if (refAndCaps.includes("\0")) {
        const [ref, capsString] = refAndCaps.split("\0");
        result.refs[ref.trim()] = hash;

        // parse capabilities
        const caps = capsString.trim().split(" ");
        result.capabilities = caps;

        // parse symref capabilities
        caps.forEach((cap) => {
          if (cap.startsWith("symref=")) {
            const symrefData = cap.substring(7);
            const [from, to] = symrefData.split(":");
            result.symrefs[from] = to;
          }
        });
      } else {
        result.refs[refAndCaps.trim()] = hash;
      }
    }
  }

  return result;
}
