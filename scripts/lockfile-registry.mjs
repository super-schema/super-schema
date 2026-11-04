// A package-lock.json records the registry host in every `resolved` URL. On a machine whose npm registry is another host (a mirror
// that does not serve the recorded one) `npm ci` fails with 403/404 on the first package that host does not have. This script
// points the registry tarball URLs at the configured registry, or drops them (npm then resolves from the configured registry and
// still verifies `integrity`). Idempotent; never touches links, git or file dependencies.
//
//   node scripts/lockfile-registry.mjs                       rewrite to `npm config get registry`, in place
//   node scripts/lockfile-registry.mjs --registry <url>      rewrite to <url>
//   node scripts/lockfile-registry.mjs --drop                remove registry `resolved` URLs instead
//   node scripts/lockfile-registry.mjs --check               exit 1 if any URL is on another host, write nothing
//   node scripts/lockfile-registry.mjs --file <p> --out <p>  read <p>, write to --out (default: back into --file)
//
// Tip: to install once without changing the committed lockfile, run it with --out on a copy, or restore with `git checkout package-lock.json`.
// Unit tested in tests/unit/scripts/lockfile-registry.test.ts.

import { execFileSync } from "node:child_process";
import { readFileSync, writeFileSync } from "node:fs";
import { isEntryPoint } from "./e2e-entry.mjs";

const TARBALL = /^(https?:\/\/.+?)\/((?:@[^/]+\/)?[^/@][^/]*)\/-\/([^/]+\.tgz)$/;

/** @param {string} registry */
const trimRegistry = (registry) => registry.replace(/\/+$/, "");

/** Every package entry of a lockfile (v2/v3 `packages`, v1 `dependencies` recursively). @param {any} lockfile @returns {any[]} */
function entries(lockfile) {
  const out = [];
  for (const entry of Object.values(lockfile.packages ?? {})) out.push(entry);
  const walk = (deps) => {
    for (const entry of Object.values(deps ?? {})) {
      out.push(entry);
      walk(entry.dependencies);
    }
  };
  walk(lockfile.dependencies);
  return out;
}

/**
 * @param {any} lockfile
 * @param {{ registry?: string, drop?: boolean }} options
 * @returns {{ lockfile: any, changed: number }}
 */
export function rewriteLockfile(lockfile, options) {
  const copy = structuredClone(lockfile);
  let changed = 0;
  for (const entry of entries(copy)) {
    if (typeof entry.resolved !== "string") continue;
    const match = TARBALL.exec(entry.resolved);
    if (!match) continue;
    if (options.drop) {
      delete entry.resolved;
      changed += 1;
      continue;
    }
    const next = `${trimRegistry(options.registry ?? "")}/${match[2]}/-/${match[3]}`;
    if (next !== entry.resolved) {
      entry.resolved = next;
      changed += 1;
    }
  }
  return { lockfile: copy, changed };
}

/** The registry tarball URLs per host that is not the registry's own. @param {any} lockfile @param {string} registry */
export function findStaleHosts(lockfile, registry) {
  const own = new URL(trimRegistry(registry)).host;
  /** @type {Record<string, number>} */
  const stale = {};
  for (const entry of entries(lockfile)) {
    if (typeof entry.resolved !== "string" || !TARBALL.test(entry.resolved)) continue;
    const host = new URL(entry.resolved).host;
    if (host !== own) stale[host] = (stale[host] ?? 0) + 1;
  }
  return stale;
}

const configuredRegistry = () => {
  try {
    return execFileSync("npm", ["config", "get", "registry"], { encoding: "utf8" }).trim();
  } catch {
    return "";
  }
};

/**
 * @param {string[]} argv
 * @param {{ registry?: string }} [env] test seam: the registry npm is configured with
 * @returns {{ code: number, message: string }}
 */
export function runCli(argv, env = {}) {
  let file = "package-lock.json";
  let out;
  let registry;
  let drop = false;
  let check = false;
  for (let i = 0; i < argv.length; i++) {
    const arg = argv[i];
    if (arg === "--drop") drop = true;
    else if (arg === "--check") check = true;
    else if (arg === "--file") file = argv[++i];
    else if (arg === "--out") out = argv[++i];
    else if (arg === "--registry") registry = argv[++i];
    else return { code: 2, message: `unknown argument "${arg}"` };
  }
  registry = registry ?? (drop ? undefined : (env.registry ?? configuredRegistry()));
  if (!drop && !registry) return { code: 2, message: "no registry: pass --registry <url> or --drop (npm has none configured)" };

  const lockfile = JSON.parse(readFileSync(file, "utf8"));
  if (check) {
    const stale = findStaleHosts(lockfile, registry ?? "https://registry.npmjs.org");
    const total = Object.values(stale).reduce((n, c) => n + c, 0);
    return total === 0
      ? { code: 0, message: "lockfile hosts match the registry" }
      : { code: 1, message: `${total} resolved URL(s) on other hosts: ${Object.entries(stale).map(([h, c]) => `${h} (${c})`).join(", ")}` };
  }
  const result = rewriteLockfile(lockfile, { registry, drop });
  writeFileSync(out ?? file, `${JSON.stringify(result.lockfile, null, 2)}\n`);
  return { code: 0, message: `${result.changed} resolved URL(s) ${drop ? "dropped" : `now on ${registry}`}${out ? ` -> ${out}` : ""}` };
}

if (isEntryPoint(import.meta.url, process.argv[1])) {
  const { code, message } = runCli(process.argv.slice(2));
  (code === 0 ? console.log : console.error)(`[lockfile-registry] ${message}`);
  process.exit(code);
}
