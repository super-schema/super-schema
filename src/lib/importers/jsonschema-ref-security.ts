/**
 * Pure helpers backing the server-side JSON Schema `$ref` resolver
 * (see jsonschema-ref-resolver.ts). Everything here is side-effect free (except
 * `assertPublicHost`, which calls an injected DNS lookup) so it can be unit
 * tested directly.
 *
 * Threat model: the root URL and every `$ref` are user-supplied and the fetches
 * run on our server. We must never read local files, never reach internal
 * networks over plain https, never let a path become a `gh` option, and never
 * leak local paths/tokens in error text.
 */
import { isIP } from "node:net";

/** Internal git hosts fetched through the authenticated `gh` CLI. */
export const INTERNAL_GIT_HOSTS: readonly string[] = ["github.paypal.com"];

export interface Limits {
  maxFiles: number;
  maxFileBytes: number;
  maxTotalBytes: number;
  perFetchTimeoutMs: number;
  overallTimeoutMs: number;
  maxConcurrent: number;
  maxRedirects: number;
}

export const DEFAULT_LIMITS: Limits = {
  maxFiles: 100,
  maxFileBytes: 2 * 1024 * 1024,
  maxTotalBytes: 20 * 1024 * 1024,
  perFetchTimeoutMs: 15_000,
  overallTimeoutMs: 60_000,
  maxConcurrent: 4,
  maxRedirects: 3,
};

/** An error whose message is already safe to show to the user. */
export class RefFetchError extends Error {
  constructor(message: string) {
    super(message);
    this.name = "RefFetchError";
  }
}

export type DnsLookup = (hostname: string) => Promise<string[]>;

// ---------------------------------------------------------------------------
// Reason sanitising
// ---------------------------------------------------------------------------

/** Make an arbitrary error message safe: no fs paths, tokens, stacks. */
export function sanitizeReason(err: unknown): string {
  if (err instanceof RefFetchError) return err.message;
  const raw = err instanceof Error ? err.message : String(err);
  let msg = raw.split("\n")[0] ?? "";
  msg = msg
    .replace(/\b(gh[pousr]_[A-Za-z0-9]{10,}|github_pat_[A-Za-z0-9_]{10,})\b/g, "[redacted]")
    .replace(/\b(Bearer|token|Basic)\s+[A-Za-z0-9._~+/=-]{8,}/gi, "$1 [redacted]")
    .replace(/[A-Za-z]:\\[^\s'"]*/g, "[path]")
    .replace(/(^|[\s'"(=])\/(?:[^\s'"/]+\/)+[^\s'"/]*/g, "$1[path]")
    .trim();
  if (!msg) return "request failed";
  return msg.length > 200 ? `${msg.slice(0, 200)}...` : msg;
}

// ---------------------------------------------------------------------------
// IP classification (SSRF)
// ---------------------------------------------------------------------------

function isBlockedIPv4Octets(o: number[]): boolean {
  const [a, b, c] = o as [number, number, number, number];
  if (a === 0 || a === 10 || a === 127) return true;
  if (a === 100 && b >= 64 && b <= 127) return true; // CGNAT
  if (a === 169 && b === 254) return true; // link-local incl. metadata
  if (a === 172 && b >= 16 && b <= 31) return true;
  if (a === 192 && b === 168) return true;
  if (a === 192 && b === 0 && c === 0) return true;
  if (a === 198 && (b === 18 || b === 19)) return true; // benchmarking
  if (a >= 224) return true; // multicast + reserved + broadcast
  return false;
}

function parseIPv6(input: string): number[] | null {
  let s = input.split("%")[0] ?? "";
  let tail: number[] = [];
  const lastColon = s.lastIndexOf(":");
  if (s.slice(lastColon + 1).includes(".")) {
    const parts = s.slice(lastColon + 1).split(".").map(Number);
    if (parts.length !== 4 || parts.some((n) => !Number.isInteger(n) || n < 0 || n > 255)) return null;
    tail = [(parts[0]! << 8) | parts[1]!, (parts[2]! << 8) | parts[3]!];
    s = s.slice(0, lastColon + 1) + "0:0";
  }
  const halves = s.split("::");
  if (halves.length > 2) return null;
  const toGroups = (h: string) => (h === "" ? [] : h.split(":").map((g) => parseInt(g, 16)));
  const head = toGroups(halves[0]!);
  const rest = halves.length === 2 ? toGroups(halves[1]!) : [];
  let groups: number[];
  if (halves.length === 2) {
    const fill = 8 - head.length - rest.length;
    if (fill < 0) return null;
    groups = [...head, ...new Array<number>(fill).fill(0), ...rest];
  } else {
    groups = head;
  }
  if (groups.length !== 8 || groups.some((g) => !Number.isInteger(g) || g < 0 || g > 0xffff)) return null;
  if (tail.length) groups.splice(6, 2, tail[0]!, tail[1]!);
  return groups;
}

/** True for loopback/private/link-local/CGNAT/ULA/metadata/mapped/unspecified. */
export function isBlockedIp(ip: string): boolean {
  const bare = ip.replace(/^\[|\]$/g, "");
  const family = isIP(bare);
  if (family === 4) return isBlockedIPv4Octets(bare.split(".").map(Number));
  if (family === 6) {
    const g = parseIPv6(bare);
    if (!g) return true; // unparseable: fail closed
    const v4From = (hi: number, lo: number) => [hi >> 8, hi & 255, lo >> 8, lo & 255];
    if (g.every((x) => x === 0)) return true; // ::
    if (g.slice(0, 7).every((x) => x === 0) && g[7] === 1) return true; // ::1
    // ::ffff:a.b.c.d (mapped) and ::a.b.c.d (compatible)
    if (g.slice(0, 5).every((x) => x === 0) && (g[5] === 0xffff || g[5] === 0)) {
      return isBlockedIPv4Octets(v4From(g[6]!, g[7]!));
    }
    // 64:ff9b::/96 NAT64
    if (g[0] === 0x64 && g[1] === 0xff9b && g.slice(2, 6).every((x) => x === 0)) {
      return isBlockedIPv4Octets(v4From(g[6]!, g[7]!));
    }
    if (g[0] === 0x2002) return isBlockedIPv4Octets(v4From(g[1]!, g[2]!)); // 6to4
    if ((g[0]! & 0xfe00) === 0xfc00) return true; // fc00::/7
    if ((g[0]! & 0xffc0) === 0xfe80) return true; // fe80::/10
    if ((g[0]! & 0xffc0) === 0xfec0) return true; // site-local
    if ((g[0]! & 0xff00) === 0xff00) return true; // multicast
    return false;
  }
  return false;
}

export type HttpsCheck = { ok: true; url: URL } | { ok: false; reason: string };

/** Static (no-DNS) policy for a plain-https fetch. */
export function checkHttpsUrl(raw: string): HttpsCheck {
  let url: URL;
  try {
    url = new URL(raw);
  } catch {
    return { ok: false, reason: "not a valid absolute URL" };
  }
  if (url.protocol !== "https:") {
    return { ok: false, reason: `scheme "${url.protocol.replace(/:$/, "")}" is not allowed (only https)` };
  }
  if (url.username || url.password) {
    return { ok: false, reason: "URLs with embedded credentials are not allowed" };
  }
  const host = url.hostname.replace(/^\[|\]$/g, "").replace(/\.$/, "").toLowerCase();
  if (!host) return { ok: false, reason: "URL has no host" };
  if (host === "localhost" || host.endsWith(".localhost")) {
    return { ok: false, reason: "host is blocked by policy (localhost)" };
  }
  if (isIP(host) && isBlockedIp(host)) {
    return { ok: false, reason: "host is blocked by policy (private or reserved address)" };
  }
  return { ok: true, url };
}

/** Reject hostnames that resolve to a blocked address. Fails closed. */
export async function assertPublicHost(url: URL, lookup: DnsLookup): Promise<void> {
  const host = url.hostname.replace(/^\[|\]$/g, "");
  if (isIP(host)) return; // literal already checked by checkHttpsUrl
  let addrs: string[];
  try {
    addrs = await lookup(host);
  } catch {
    throw new RefFetchError("host could not be resolved");
  }
  if (addrs.length === 0 || addrs.some((a) => isBlockedIp(a))) {
    throw new RefFetchError("host is blocked by policy (resolves to a private or reserved address)");
  }
}

// ---------------------------------------------------------------------------
// Internal git host URLs and `gh` argument construction
// ---------------------------------------------------------------------------

export interface GitCoords {
  host: string;
  owner: string;
  repo: string;
  ref: string;
  path: string;
}

export type GitParse = { ok: true; coords: GitCoords } | { ok: false; reason: string };

const OWNER_REPO_RE = /^[A-Za-z0-9_][A-Za-z0-9_.-]*$/;
const REF_RE = /^[A-Za-z0-9_][A-Za-z0-9_.-]*$/;
const PATH_SEGMENT_RE = /^[A-Za-z0-9_@+~,=. -]+$/;

/** Validate coordinates BEFORE they go anywhere near an argv. */
export function validateGitCoords(c: GitCoords): string | null {
  if (!OWNER_REPO_RE.test(c.owner) || c.owner === "." || c.owner === "..") return "invalid owner";
  if (!OWNER_REPO_RE.test(c.repo) || c.repo === "." || c.repo === "..") return "invalid repository name";
  if (!REF_RE.test(c.ref) || c.ref.includes("..")) return "invalid ref";
  if (!c.path) return "empty path";
  for (const seg of c.path.split("/")) {
    if (!seg || seg === "." || seg === ".." || seg.startsWith("-") || !PATH_SEGMENT_RE.test(seg)) {
      return "invalid path";
    }
  }
  return null;
}

function safeDecode(s: string): string | null {
  try {
    return decodeURIComponent(s);
  } catch {
    return null;
  }
}

/**
 * Parse `https://<host>/<owner>/<repo>/(blob|raw)/<ref>/<path>` or the API style
 * `https://<host>/api/v3/repos/<owner>/<repo>/contents/<path>?ref=<ref>`.
 * The ref is a single path segment (branches containing "/" are unsupported).
 */
export function parseGitFileUrl(raw: string, hosts: readonly string[] = INTERNAL_GIT_HOSTS): GitParse {
  let url: URL;
  try {
    url = new URL(raw);
  } catch {
    return { ok: false, reason: "not a valid absolute URL" };
  }
  if (url.protocol !== "https:") {
    return { ok: false, reason: `scheme "${url.protocol.replace(/:$/, "")}" is not allowed (only https)` };
  }
  if (url.username || url.password || url.port) {
    return { ok: false, reason: "credentials or custom ports are not allowed for git hosts" };
  }
  const host = url.hostname.toLowerCase();
  if (!hosts.some((h) => h.toLowerCase() === host)) return { ok: false, reason: "unknown git host" };
  const segs = url.pathname.split("/").slice(1);
  if (segs.some((s) => s === "")) return { ok: false, reason: "unrecognized git file URL" };
  let owner: string | undefined, repo: string | undefined, ref: string | undefined;
  let pathSegs: string[] = [];
  if (segs.length >= 5 && (segs[2] === "blob" || segs[2] === "raw")) {
    [owner, repo] = [segs[0], segs[1]];
    ref = segs[3];
    pathSegs = segs.slice(4);
  } else if (segs.length >= 7 && segs[0] === "api" && segs[1] === "v3" && segs[2] === "repos" && segs[5] === "contents") {
    [owner, repo] = [segs[3], segs[4]];
    ref = url.searchParams.get("ref") ?? undefined;
    pathSegs = segs.slice(6);
  } else {
    return { ok: false, reason: "unrecognized git file URL (expected /<owner>/<repo>/blob/<ref>/<path>)" };
  }
  const dec = [owner, repo, ref, ...pathSegs].map((s) => (s === undefined ? null : safeDecode(s)));
  if (dec.some((s) => s === null)) return { ok: false, reason: "invalid percent-encoding in git file URL" };
  const [o, r, f, ...p] = dec as string[];
  const coords: GitCoords = { host, owner: o!, repo: r!, ref: f!, path: p.join("/") };
  const bad = validateGitCoords(coords);
  return bad ? { ok: false, reason: `${bad} in git file URL` } : { ok: true, coords };
}

/** Canonical blob-style URL for a validated coordinate set. */
export function toBlobUrl(c: GitCoords): string {
  const path = c.path.split("/").map(encodeURIComponent).join("/");
  return `https://${c.host}/${c.owner}/${c.repo}/blob/${c.ref}/${path}`;
}

/**
 * Argument vector for `gh` (passed to execFile, never a shell). Uses the raw
 * media type so the body is the file itself (no base64 decoding needed).
 * Throws RefFetchError for invalid coordinates or a non-allowlisted host.
 */
export function buildGhArgs(c: GitCoords, hosts: readonly string[] = INTERNAL_GIT_HOSTS): string[] {
  if (!hosts.some((h) => h.toLowerCase() === c.host.toLowerCase()) || !/^[A-Za-z0-9.-]+$/.test(c.host)) {
    throw new RefFetchError("unknown git host");
  }
  const bad = validateGitCoords(c);
  if (bad) throw new RefFetchError(`refused: ${bad}`);
  const path = c.path.split("/").map(encodeURIComponent).join("/");
  const endpoint = `repos/${c.owner}/${c.repo}/contents/${path}?ref=${encodeURIComponent(c.ref)}`;
  return ["api", "--hostname", c.host, "-H", "Accept: application/vnd.github.raw", "--", endpoint];
}
