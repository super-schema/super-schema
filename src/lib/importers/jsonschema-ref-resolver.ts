/**
 * Server-side JSON Schema `$ref` resolution (Addendum B of the vendor-extension
 * round-trip spec). Uses `@apidevtools/json-schema-ref-parser`'s `resolve()` only
 * (never `dereference()`/`bundle()`: each `$ref` target stays its own document),
 * with every built-in resolver disabled and one guarded resolver plugin that
 * enforces our security policy (see jsonschema-ref-security.ts for the pure
 * helpers):
 *
 *  - no local filesystem access of any kind (library `file` resolver disabled);
 *  - plain HTTP fetches are https-only with an SSRF guard (blocked IP ranges,
 *    DNS re-check, manual same-host redirects, no credentials in URLs);
 *  - allow-listed internal git hosts are fetched via `gh api` (execFile, argv
 *    array, validated coordinates, Accept: application/vnd.github.raw);
 *  - hard limits on file count, bytes, concurrency and time;
 *  - every per-reference failure is recorded in `unreachable`, never thrown.
 *
 * Known limitation: DNS is checked before connecting but the connection does not
 * pin the checked address (a DNS-rebinding race is theoretically possible).
 */
import { execFile } from "node:child_process";
import { lookup as dnsLookup } from "node:dns/promises";
import { $RefParser } from "@apidevtools/json-schema-ref-parser";
import { parse as parseYaml } from "yaml";
import {
  DEFAULT_LIMITS,
  INTERNAL_GIT_HOSTS,
  RefFetchError,
  assertPublicHost,
  buildGhArgs,
  checkHttpsUrl,
  parseGitFileUrl,
  sanitizeReason,
  toBlobUrl,
  type DnsLookup,
  type GitCoords,
  type Limits,
} from "./jsonschema-ref-security";

export { INTERNAL_GIT_HOSTS, DEFAULT_LIMITS } from "./jsonschema-ref-security";
export type { Limits } from "./jsonschema-ref-security";

export type ExecFileFn = (
  file: string,
  args: string[],
  opts: { timeout: number; maxBuffer: number },
) => Promise<{ stdout: string }>;

export interface ResolverDeps {
  fetchGitFile?: (host: string, owner: string, repo: string, ref: string, path: string) => Promise<string>;
  fetchHttp?: (url: string) => Promise<string>;
  limits?: Partial<Limits>;
  /** Override the internal git host allowlist (defaults to INTERNAL_GIT_HOSTS). */
  internalGitHosts?: readonly string[];
  /**
   * Extra git scopes ("host/owner" or "host/owner/repo") that may be fetched in addition to the
   * root document's own host/owner. Default none: cross-organization refs are not fetched.
   */
  extraGitScopes?: readonly string[];
  /** Injectable DNS lookup (returns all addresses); defaults to dns.lookup. */
  lookup?: DnsLookup;
  /** Injectable exec for the default `gh` fetcher. */
  execFile?: ExecFileFn;
}

export interface ResolvedRefs {
  resolved: Map<string, unknown>;
  unreachable: Map<string, string>;
}

// ---------------------------------------------------------------------------
// Default fetchers
// ---------------------------------------------------------------------------

const defaultExec: ExecFileFn = (file, args, opts) =>
  new Promise((resolve, reject) => {
    execFile(
      file,
      args,
      { ...opts, env: { ...process.env, GH_PROMPT_DISABLED: "1", GH_NO_UPDATE_NOTIFIER: "1" } },
      (err, stdout) => (err ? reject(err) : resolve({ stdout: String(stdout) })),
    );
  });

const defaultLookup: DnsLookup = async (host) => (await dnsLookup(host, { all: true })).map((a) => a.address);

function ghFailureReason(err: unknown): string {
  const e = err as { code?: unknown; stderr?: unknown; message?: unknown };
  const text = `${String(e?.stderr ?? "")} ${String(e?.message ?? "")}`;
  if (e?.code === "ENOENT") return "gh CLI is not available on the server";
  // maxBuffer overflow also sets `killed`; check it first so it is not mislabeled a timeout.
  if (e?.code === "ERR_CHILD_PROCESS_STDIO_MAXBUFFER" || /maxBuffer/i.test(text)) {
    return "file exceeds the size limit";
  }
  if (/\b404\b|not found/i.test(text)) return "not found (HTTP 404) or no access";
  if (/auth login|not logged|\b401\b|\b403\b|authentication|forbidden/i.test(text)) {
    return "gh is not authenticated for this host or access is forbidden";
  }
  if (/ETIMEDOUT|timed out|killed/i.test(text) || (err as { killed?: boolean })?.killed) return "gh request timed out";
  return "gh api request failed";
}

/** `gh api --hostname <host> repos/<o>/<r>/contents/<path>?ref=<ref>`, raw media type. */
export function createGhFetchGitFile(
  exec: ExecFileFn = defaultExec,
  limits: Partial<Limits> = {},
  hosts: readonly string[] = INTERNAL_GIT_HOSTS,
): ResolverDepsGit {
  const l = { ...DEFAULT_LIMITS, ...limits };
  return async (host, owner, repo, ref, path) => {
    const args = buildGhArgs({ host, owner, repo, ref, path }, hosts); // throws before any spawn
    try {
      const { stdout } = await exec("gh", args, { timeout: l.perFetchTimeoutMs, maxBuffer: l.maxFileBytes + 1024 });
      return stdout;
    } catch (err) {
      throw new RefFetchError(ghFailureReason(err));
    }
  };
}
type ResolverDepsGit = NonNullable<ResolverDeps["fetchGitFile"]>;

async function readCapped(res: Response, maxBytes: number): Promise<string> {
  const declared = Number(res.headers.get("content-length") ?? 0);
  if (declared > maxBytes) throw new RefFetchError("file exceeds the size limit");
  const reader = res.body?.getReader();
  if (!reader) return "";
  const chunks: Uint8Array[] = [];
  let total = 0;
  for (;;) {
    const { done, value } = await reader.read();
    if (done) break;
    total += value.byteLength;
    if (total > maxBytes) {
      await reader.cancel().catch(() => undefined);
      throw new RefFetchError("file exceeds the size limit");
    }
    chunks.push(value);
  }
  return Buffer.concat(chunks).toString("utf8");
}

/** https `fetch` with manual, same-host-only redirects; every hop is re-validated. */
export function createDefaultFetchHttp(limits: Partial<Limits> = {}, lookup: DnsLookup = defaultLookup) {
  const l = { ...DEFAULT_LIMITS, ...limits };
  return async (start: string): Promise<string> => {
    let current = start;
    const originHost = new URL(start).host.toLowerCase(); // host = hostname + port
    for (let hop = 0; hop <= l.maxRedirects; hop++) {
      if (new URL(current).host.toLowerCase() !== originHost) {
        throw new RefFetchError("redirect to a different host is not allowed");
      }
      const check = checkHttpsUrl(current);
      if (!check.ok) throw new RefFetchError(check.reason);
      await assertPublicHost(check.url, lookup);
      const res = await fetch(current, {
        redirect: "manual",
        signal: AbortSignal.timeout(l.perFetchTimeoutMs),
        headers: { accept: "application/json, application/yaml, text/plain, */*" },
      });
      if (res.status >= 300 && res.status < 400) {
        const loc = res.headers.get("location");
        await res.body?.cancel().catch(() => undefined);
        if (!loc) throw new RefFetchError(`HTTP ${res.status} without a redirect target`);
        current = new URL(loc, current).toString();
        continue;
      }
      if (!res.ok) {
        await res.body?.cancel().catch(() => undefined);
        throw new RefFetchError(`HTTP ${res.status}`);
      }
      return readCapped(res, l.maxFileBytes);
    }
    throw new RefFetchError("too many redirects");
  };
}

// ---------------------------------------------------------------------------
// Resolution
// ---------------------------------------------------------------------------

const SCHEME_RE = /^([A-Za-z][A-Za-z0-9+.-]*):/;
/** A scheme of length 1 is a Windows drive letter, i.e. a local path. */
function schemeOf(u: string): string | null {
  const m = SCHEME_RE.exec(u);
  return m && m[1]!.length > 1 ? m[1]!.toLowerCase() : null;
}

class Semaphore {
  private active = 0;
  private queue: Array<() => void> = [];
  constructor(private readonly max: number) {}
  async run<T>(fn: () => Promise<T>): Promise<T> {
    if (this.active >= this.max) await new Promise<void>((r) => this.queue.push(r));
    this.active++;
    try {
      return await fn();
    } finally {
      this.active--;
      this.queue.shift()?.();
    }
  }
}

function withTimeout<T>(p: Promise<T>, ms: number): Promise<T> {
  let timer: ReturnType<typeof setTimeout>;
  const t = new Promise<never>((_, rej) => {
    timer = setTimeout(() => rej(new RefFetchError("fetch timed out")), ms);
  });
  return Promise.race([p, t]).finally(() => clearTimeout(timer));
}

function parseDoc(content: string): { ok: true; value: object } | { ok: false; reason: string } {
  let value: unknown;
  try {
    value = JSON.parse(content);
  } catch {
    try {
      value = parseYaml(content);
    } catch (err) {
      return { ok: false, reason: `document could not be parsed: ${sanitizeReason(err)}` };
    }
  }
  if (value === null || typeof value !== "object" || Array.isArray(value)) {
    return { ok: false, reason: "document is not a JSON object" };
  }
  return { ok: true, value };
}

/** Mirrors the library's relative-URL resolution closely enough to predict `new URL` failures. */
function isResolvableRef(ref: string, base: string): boolean {
  try {
    const from = new URL(base.replace(/\\/g, "/"), "https://aaa.nonexistanturl.com");
    new URL(ref.replace(/\\/g, "/"), from);
    return true;
  } catch {
    return false;
  }
}

/**
 * Deep copy of `value` for the library, with each `$ref` string that cannot be
 * resolved as a URL replaced by "#" (the library resolves URLs before its
 * continueOnError handling, so one malformed ref would otherwise reject the
 * whole resolve()). Invalid refs are reported through `onInvalid`; `externalCount`
 * counts the remaining external refs.
 */
function sanitizeRefs(
  value: unknown,
  base: string,
  onInvalid: (ref: string) => void,
  counter: { external: number },
  memo = new Map<object, unknown>(),
): unknown {
  if (value === null || typeof value !== "object") return value;
  if (memo.has(value)) return memo.get(value);
  if (Array.isArray(value)) {
    const out: unknown[] = [];
    memo.set(value, out);
    for (const v of value) out.push(sanitizeRefs(v, base, onInvalid, counter, memo));
    return out;
  }
  const out: Record<string, unknown> = {};
  memo.set(value, out);
  for (const [k, v] of Object.entries(value)) {
    if (k === "$ref" && typeof v === "string") {
      if (v.startsWith("#")) {
        out[k] = v;
      } else if (isResolvableRef(v, base)) {
        counter.external++;
        out[k] = v;
      } else {
        onInvalid(v);
        out[k] = "#";
      }
    } else {
      out[k] = sanitizeRefs(v, base, onInvalid, counter, memo);
    }
  }
  return out;
}

function gitScopeAllows(scopes: readonly string[], c: GitCoords): boolean {
  const host = c.host.toLowerCase();
  const owner = c.owner.toLowerCase();
  const repo = c.repo.toLowerCase();
  return scopes.some((s) => {
    const p = String(s).toLowerCase().split("/");
    if (p.length === 2) return p[0] === host && p[1] === owner;
    if (p.length === 3) return p[0] === host && p[1] === owner && p[2] === repo;
    return false;
  });
}

const OUT_OF_SCOPE = "outside the root document's organization; not fetched";

export async function resolveJsonSchemaRefs(
  rootUrl: string,
  rootContent: string,
  deps: ResolverDeps = {},
): Promise<ResolvedRefs> {
  try {
    return await resolveInner(rootUrl, rootContent, deps ?? {});
  } catch (err) {
    // Contract: never throws. Anything unexpected becomes a visible unreachable entry.
    const key = typeof rootUrl === "string" && rootUrl ? rootUrl : "root";
    return {
      resolved: new Map(),
      unreachable: new Map([[key, `resolver failed unexpectedly: ${sanitizeReason(err)}`]]),
    };
  }
}

async function resolveInner(rootUrl: string, rootContent: string, deps: ResolverDeps): Promise<ResolvedRefs> {
  const limits: Limits = { ...DEFAULT_LIMITS, ...deps.limits };
  const hosts = deps.internalGitHosts ?? INTERNAL_GIT_HOSTS;
  const extraScopes = deps.extraGitScopes ?? [];
  const lookup = deps.lookup ?? defaultLookup;
  const fetchGitFile = deps.fetchGitFile ?? createGhFetchGitFile(deps.execFile ?? defaultExec, limits, hosts);
  const fetchHttp = deps.fetchHttp ?? createDefaultFetchHttp(limits, lookup);

  const unreachable = new Map<string, string>();
  const originals = new Map<string, unknown>();
  const rootKeyGiven = typeof rootUrl === "string" && rootUrl ? rootUrl : "root";
  const fail = (reason: string): ResolvedRefs => ({
    resolved: new Map(),
    unreachable: new Map([[rootKeyGiven, reason]]),
  });

  if (typeof rootUrl !== "string" || typeof rootContent !== "string") {
    return fail("root URL and content must be strings");
  }
  const rootBytes = Buffer.byteLength(rootContent);
  if (rootBytes > limits.maxFileBytes) return fail("root document exceeds the size limit");
  const root = parseDoc(rootContent);
  if (!root.ok) return fail(`root ${root.reason}`);

  // API-style root URLs lose their `?ref=` under relative resolution: canonicalize to blob style.
  let base = rootUrl;
  const parsedRoot = parseGitFileUrl(rootUrl, hosts);
  if (parsedRoot.ok && new URL(rootUrl).pathname.startsWith("/api/v3/")) base = toBlobUrl(parsedRoot.coords);
  const rootGit = parsedRoot.ok ? parsedRoot.coords : null;
  let rootKey = rootUrl;
  try {
    if (schemeOf(base) === "https") rootKey = new URL(base).href;
  } catch {
    /* keep as given */
  }

  let aborted = false;
  let fileCount = 0;
  let totalBytes = rootBytes;
  let readCalls = 0;
  const dnsHosts = new Set<string>();
  const reads = new Set<Promise<unknown>>();
  const inflight = new Set<string>();
  const sem = new Semaphore(Math.max(1, limits.maxConcurrent));

  async function fetchOne(url: string): Promise<string> {
    const scheme = schemeOf(url);
    if (scheme === null) throw new RefFetchError("local file references are not allowed");
    if (scheme !== "https") {
      throw new RefFetchError(`scheme "${scheme}" is not allowed (only https; blocked before any fetch)`);
    }

    // Cheap, synchronous policy first; nothing here does I/O.
    const u = new URL(url);
    const isGitHost = hosts.some((h) => h.toLowerCase() === u.hostname.toLowerCase());
    let gitCoords: GitCoords | null = null;
    if (isGitHost) {
      const git = parseGitFileUrl(url, hosts);
      if (!git.ok) throw new RefFetchError(git.reason);
      const sameOrg =
        rootGit !== null &&
        rootGit.host.toLowerCase() === git.coords.host.toLowerCase() &&
        rootGit.owner.toLowerCase() === git.coords.owner.toLowerCase();
      if (!sameOrg && !gitScopeAllows(extraScopes, git.coords)) throw new RefFetchError(OUT_OF_SCOPE);
      gitCoords = git.coords;
    } else {
      const check = checkHttpsUrl(url);
      if (!check.ok) throw new RefFetchError(check.reason);
    }

    // Count first: over-limit refs cost no DNS and no fetch.
    if (++fileCount > limits.maxFiles) throw new RefFetchError(`file limit (${limits.maxFiles}) exceeded`);
    if (!isGitHost) {
      const h = u.hostname.toLowerCase();
      if (!dnsHosts.has(h)) {
        if (dnsHosts.size >= limits.maxDnsHosts) {
          throw new RefFetchError(`distinct host limit (${limits.maxDnsHosts}) exceeded`);
        }
        dnsHosts.add(h);
      }
    }

    const body = await sem.run(async () => {
      if (aborted) throw new RefFetchError("overall timeout exceeded");
      return withTimeout(
        (async () => {
          if (gitCoords) {
            const c = gitCoords;
            return fetchGitFile(c.host, c.owner, c.repo, c.ref, c.path);
          }
          await assertPublicHost(u, lookup);
          return fetchHttp(url);
        })(),
        limits.perFetchTimeoutMs,
      );
    });
    const bytes = Buffer.byteLength(body);
    if (bytes > limits.maxFileBytes) throw new RefFetchError("file exceeds the size limit");
    if (totalBytes + bytes > limits.maxTotalBytes) throw new RefFetchError("total size limit exceeded");
    totalBytes += bytes;
    return body;
  }

  async function loadDoc(url: string): Promise<string> {
    const body = await fetchOne(url);
    const doc = parseDoc(body);
    if (!doc.ok) throw new RefFetchError(doc.reason);
    const clean = sanitizeRefs(doc.value, url, (ref) => unreachable.set(ref, "invalid $ref"), { external: 0 });
    let text: string;
    try {
      text = JSON.stringify(clean);
    } catch {
      throw new RefFetchError("document contains a circular structure");
    }
    if (!aborted) originals.set(url, doc.value);
    return text;
  }

  const guarded = {
    order: 1,
    canRead: () => true,
    read(file: { url: string; reference?: string }): Promise<string> {
      readCalls++;
      // Local paths are keyed by the $ref text so no server path ever appears in output.
      const key = schemeOf(file.url) === null ? (file.reference ?? "local path") : file.url;
      const p = (async () => {
        if (aborted) {
          unreachable.set(key, "overall timeout exceeded");
          throw new RefFetchError("overall timeout exceeded");
        }
        inflight.add(key);
        try {
          return await loadDoc(file.url);
        } catch (err) {
          const reason = sanitizeReason(err);
          if (!aborted || !unreachable.has(key)) unreachable.set(key, reason);
          throw new RefFetchError(reason);
        } finally {
          inflight.delete(key);
        }
      })();
      reads.add(p);
      p.then(
        () => reads.delete(p),
        () => reads.delete(p),
      );
      return p;
    },
  };

  const counter = { external: 0 };
  const cleanRoot = sanitizeRefs(root.value, base, (ref) => unreachable.set(ref, "invalid $ref"), counter);
  originals.set(rootKey, root.value);

  const parser = new $RefParser();
  const options = {
    continueOnError: true,
    resolve: { external: true, file: false, http: false, guarded },
  };
  const run = parser
    // eslint-disable-next-line @typescript-eslint/no-explicit-any
    .resolve(base, cleanRoot as any, options as any)
    .then(
      () => undefined,
      () => undefined, // per-ref errors are recorded by the resolver plugin above
    );
  let timer: ReturnType<typeof setTimeout> | undefined;
  const deadline = new Promise<"timeout">((res) => {
    timer = setTimeout(() => res("timeout"), limits.overallTimeoutMs);
  });
  let timedOut = false;
  const drain = async () => {
    await run;
    // Even if resolve() rejected early, let in-flight fetches finish so nothing is lost.
    for (;;) {
      await new Promise<void>((r) => setImmediate(r));
      if (reads.size === 0) return;
      await Promise.allSettled([...reads]);
    }
  };
  try {
    timedOut = (await Promise.race([drain().then(() => "done" as const), deadline])) === "timeout";
  } finally {
    clearTimeout(timer);
  }
  if (timedOut) {
    aborted = true;
    for (const key of inflight) unreachable.set(key, "overall timeout exceeded");
  }
  if (!timedOut && counter.external > 0 && readCalls === 0 && unreachable.size === 0) {
    // Loud failure if the library stopped calling our resolver at all (internals/behaviour changed).
    unreachable.set(rootKey, "ref-parser behavior changed; resolver did not request any referenced document");
  }

  // Return copies so late writes (after an overall timeout) cannot mutate what the caller holds.
  return { resolved: new Map(originals), unreachable: new Map(unreachable) };
}
