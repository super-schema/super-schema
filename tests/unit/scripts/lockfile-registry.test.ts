/**
 * scripts/lockfile-registry.mjs: a lockfile written against one registry host (`resolved` URLs) fails `npm ci` on a machine whose
 * registry is another host (403 on a mirror that does not serve the old one). The script rewrites every `resolved` URL to the
 * configured registry (or drops them so npm resolves from the registry, keeping `integrity`), and is idempotent.
 */
import { mkdtempSync, readFileSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import path from "node:path";
import { describe, expect, it } from "vitest";
import { findStaleHosts, rewriteLockfile, runCli } from "../../../scripts/lockfile-registry.mjs";

const OLD = "https://old.example.com/artifactory/api/npm/npm-all";
const NEW = "https://new.example.com/npm-all";
const lock = () => ({
  lockfileVersion: 3,
  packages: {
    "": { name: "app" },
    "node_modules/zustand": { version: "4.5.7", resolved: `${OLD}/zustand/-/zustand-4.5.7.tgz`, integrity: "sha512-a" },
    "node_modules/@xyflow/react": { version: "12.0.0", resolved: `${OLD}/@xyflow/react/-/react-12.0.0.tgz`, integrity: "sha512-b" },
    "node_modules/local": { resolved: "../local", link: true },
    "node_modules/git-dep": { resolved: "git+ssh://git@github.com/x/y.git#abc" },
  },
});

describe("rewriteLockfile", () => {
  it("points registry tarballs (scoped too) at the new registry and leaves links, git and integrity alone", () => {
    const { lockfile, changed } = rewriteLockfile(lock(), { registry: NEW });
    expect(changed).toBe(2);
    expect(lockfile.packages["node_modules/zustand"].resolved).toBe(`${NEW}/zustand/-/zustand-4.5.7.tgz`);
    expect(lockfile.packages["node_modules/@xyflow/react"].resolved).toBe(`${NEW}/@xyflow/react/-/react-12.0.0.tgz`);
    expect(lockfile.packages["node_modules/zustand"].integrity).toBe("sha512-a");
    expect(lockfile.packages["node_modules/local"].resolved).toBe("../local");
    expect(lockfile.packages["node_modules/git-dep"].resolved).toContain("git+ssh://");
  });

  it("tolerates a trailing slash on the registry and is idempotent", () => {
    const once = rewriteLockfile(lock(), { registry: `${NEW}/` }).lockfile;
    const twice = rewriteLockfile(once, { registry: NEW });
    expect(twice.changed).toBe(0);
    expect(twice.lockfile).toEqual(once);
  });

  it("drop mode removes only registry `resolved` URLs", () => {
    const { lockfile, changed } = rewriteLockfile(lock(), { drop: true });
    expect(changed).toBe(2);
    expect(lockfile.packages["node_modules/zustand"].resolved).toBeUndefined();
    expect(lockfile.packages["node_modules/zustand"].integrity).toBe("sha512-a");
    expect(lockfile.packages["node_modules/local"].resolved).toBe("../local");
  });

  it("does not mutate its input", () => {
    const input = lock();
    rewriteLockfile(input, { registry: NEW });
    expect(input).toEqual(lock());
  });
});

describe("findStaleHosts", () => {
  it("counts resolved URLs per host that is not the registry's", () => {
    expect(findStaleHosts(lock(), NEW)).toEqual({ "old.example.com": 2 });
    expect(findStaleHosts(rewriteLockfile(lock(), { registry: NEW }).lockfile, NEW)).toEqual({});
  });
});

describe("runCli", () => {
  const setup = () => {
    const dir = mkdtempSync(path.join(tmpdir(), "lockreg-"));
    const file = path.join(dir, "package-lock.json");
    writeFileSync(file, `${JSON.stringify(lock(), null, 2)}\n`);
    return file;
  };

  it("--check exits 1 and writes nothing while hosts differ; 0 after a rewrite", () => {
    const file = setup();
    const before = readFileSync(file, "utf8");
    expect(runCli(["--check", "--registry", NEW, "--file", file]).code).toBe(1);
    expect(readFileSync(file, "utf8")).toBe(before);
    expect(runCli(["--registry", NEW, "--file", file]).code).toBe(0);
    expect(runCli(["--check", "--registry", NEW, "--file", file]).code).toBe(0);
    expect(readFileSync(file, "utf8")).toContain(`${NEW}/zustand/-/zustand-4.5.7.tgz`);
    expect(readFileSync(file, "utf8").endsWith("\n")).toBe(true);
  });

  it("--out leaves the source file untouched", () => {
    const file = setup();
    const before = readFileSync(file, "utf8");
    const out = `${file}.copy`;
    expect(runCli(["--registry", NEW, "--file", file, "--out", out]).code).toBe(0);
    expect(readFileSync(file, "utf8")).toBe(before);
    expect(readFileSync(out, "utf8")).toContain(NEW);
  });

  it("refuses without a registry or --drop, and on an unknown flag", () => {
    expect(runCli(["--file", setup()], { registry: "" }).code).toBe(2);
    expect(runCli(["--bogus"]).code).toBe(2);
  });
});
