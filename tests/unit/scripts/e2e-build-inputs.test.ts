/**
 * scripts/e2e-build-inputs.mjs: the hash a reused build must still match. What is pinned: every input of the build changes it, nothing
 * that is not an input does, and the same checkout hashes the same (a hash that moved on its own would rebuild every time).
 */
import { mkdirSync, mkdtempSync, realpathSync, rmSync, symlinkSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import path from "node:path";
import { afterEach, beforeEach, describe, expect, it } from "vitest";
import { fileDependencies, hashBuildInputs, nextPublicOf } from "../../../scripts/e2e-build-inputs.mjs";

let root: string;
const put = (file: string, text: string) => {
  mkdirSync(path.dirname(path.join(root, file)), { recursive: true });
  writeFileSync(path.join(root, file), text);
};
const hash = (env: Record<string, string> = {}) => hashBuildInputs({ root, env, nodeVersion: "22.1.0" });

beforeEach(() => {
  root = mkdtempSync(path.join(tmpdir(), "e2e-build-inputs-"));
  put("package.json", '{"name":"x"}');
  put("package-lock.json", "{}");
  put("tsconfig.json", "{}");
  put("postcss.config.mjs", "export default {};");
  put("next.config.ts", "export default {};");
  put("prisma/schema.prisma", "model A {}");
  put("scripts/build-parser-worker.mjs", "// bundle");
  put("src/app/page.tsx", "export default 1;");
  put("src/lib/a.ts", "export const a = 1;");
  put("public/logo.svg", "<svg/>");
});
afterEach(() => rmSync(root, { recursive: true, force: true }));

describe("hashBuildInputs", () => {
  it("is the same for the same inputs, and for a rewrite with the same content (a touched file is not a change)", () => {
    const before = hash();
    put("src/lib/a.ts", "export const a = 1;");
    expect(hash()).toBe(before);
    expect(hash()).toHaveLength(40);
  });

  it.each([
    ["a source file", () => put("src/lib/a.ts", "export const a = 2;")],
    ["a new source file", () => put("src/lib/b.ts", "export const b = 1;")],
    ["a source file that is moved", () => put("src/lib/moved/a.ts", "export const a = 1;")],
    ["a static file under public/", () => put("public/logo.svg", "<svg id='2'/>")],
    ["a new static file under public/", () => put("public/robots.txt", "User-agent: *")],
    ["package.json", () => put("package.json", '{"name":"y"}')],
    ["package-lock.json", () => put("package-lock.json", '{"lockfileVersion":3}')],
    ["tsconfig.json", () => put("tsconfig.json", '{"compilerOptions":{}}')],
    ["postcss.config.mjs", () => put("postcss.config.mjs", "export default { plugins: {} };")],
    ["next.config.ts", () => put("next.config.ts", "export default { output: 'x' };")],
    ["a next.config.mjs that appears", () => put("next.config.mjs", "export default {};")],
    ["prisma/schema.prisma", () => put("prisma/schema.prisma", "model B {}")],
    ["scripts/build-parser-worker.mjs", () => put("scripts/build-parser-worker.mjs", "// other bundle")],
    ["a NEXT_PUBLIC_ value in .env", () => put(".env", "NEXT_PUBLIC_APP_URL=https://a.example\n")],
    ["a NEXT_PUBLIC_ value in .env.production", () => put(".env.production", "NEXT_PUBLIC_APP_URL=https://b.example\n")],
    ["a NEXT_PUBLIC_ value in .env.local", () => put(".env.local", "NEXT_PUBLIC_APP_URL=https://c.example\n")],
    ["a NEXT_PUBLIC_ value in .env.production.local", () => put(".env.production.local", "NEXT_PUBLIC_APP_URL=https://d.example\n")],
  ])("changes when %s changes", (_name, change) => {
    const before = hash();
    change();
    expect(hash()).not.toBe(before);
  });

  it("changes with a NEXT_PUBLIC_ value of the shell, and the shell's wins over a file's", () => {
    put(".env", "NEXT_PUBLIC_APP_URL=https://file.example\n");
    const fromFile = hash();
    expect(hash({ NEXT_PUBLIC_APP_URL: "https://shell.example" })).not.toBe(fromFile);
    expect(hash({ NEXT_PUBLIC_APP_URL: "https://file.example" })).toBe(fromFile);
  });

  it("changes with the major version of Node, not with its minor", () => {
    expect(hashBuildInputs({ root, nodeVersion: "22.1.0" })).toBe(hashBuildInputs({ root, nodeVersion: "22.9.9" }));
    expect(hashBuildInputs({ root, nodeVersion: "22.1.0" })).not.toBe(hashBuildInputs({ root, nodeVersion: "24.0.0" }));
  });

  it.each([
    ["a value that is not NEXT_PUBLIC_ in .env", () => put(".env", "DATABASE_URL=postgresql://x\nAUTH_URL=http://y\n")],
    ["a test file", () => put("tests/unit/a.test.ts", "// t")],
    ["a README", () => put("README.md", "# hi")],
    ["the generated prisma client (derived from the schema and the lockfile)", () => put("src/generated/prisma/client.ts", "// generated")],
    ["node_modules", () => put("src/node_modules/x/index.js", "// dependency")],
    ["a non-NEXT_PUBLIC_ variable of the shell", () => void 0],
  ])("does not change with %s", (_name, change) => {
    const before = hash();
    change();
    expect(hash({ DATABASE_URL: "postgresql://other", AUTH_URL: "http://other" })).toBe(before);
  });
});

describe("nextPublicOf", () => {
  it("reads NEXT_PUBLIC_ assignments: quoted, exported, with a comment, and ignores the rest", () => {
    expect(
      nextPublicOf(['NEXT_PUBLIC_A=1', 'export NEXT_PUBLIC_B="two words"', "NEXT_PUBLIC_C='3'", "NEXT_PUBLIC_D=4 # note", "# NEXT_PUBLIC_E=5", "OTHER=6", ""].join("\n")),
    ).toEqual({ NEXT_PUBLIC_A: "1", NEXT_PUBLIC_B: "two words", NEXT_PUBLIC_C: "3", NEXT_PUBLIC_D: "4" });
  });
});

describe("the vendored package and the built output of `file:` dependencies are inputs of the build", () => {
  it("changes when a file of vendor/typespec-enterprise changes, or appears (and is the same when the directory is missing)", () => {
    const without = hash();
    put("vendor/typespec-enterprise/src/index.ts", "export const a = 1;");
    const first = hash();
    expect(first).not.toBe(without);
    put("vendor/typespec-enterprise/src/index.ts", "export const a = 2;");
    expect(hash()).not.toBe(first);
    put("vendor/typespec-enterprise/lib/extra.js", "x");
    expect(hash()).not.toBe(first);
  });

  describe("fileDependencies", () => {
    it("lists the `file:` entries of every dependency group, sorted, and nothing else", () => {
      put(
        "package.json",
        JSON.stringify({
          dependencies: { b: "file:../b", react: "^19.0.0", a: "file:vendor/a" },
          devDependencies: { c: "file:../c", vitest: "^4.0.0" },
          optionalDependencies: { d: "file:../d" },
        }),
      );
      expect(fileDependencies(root).map((d) => [d.name, d.spec])).toEqual([["a", "file:vendor/a"], ["b", "file:../b"], ["c", "file:../c"], ["d", "file:../d"]]);
    });

    it("finds a package through node_modules (a link to the sibling repository, which does not exist beside a worktree), else through the path of the `file:`", () => {
      const sibling = mkdtempSync(path.join(tmpdir(), "e2e-sibling-"));
      try {
        mkdirSync(path.join(sibling, "avro", "dist"), { recursive: true });
        mkdirSync(path.join(root, "node_modules", "@x"), { recursive: true });
        symlinkSync(path.join(sibling, "avro"), path.join(root, "node_modules", "@x", "avro"));
        put("package.json", JSON.stringify({ dependencies: { "@x/avro": "file:../nowhere/avro", direct: `file:${path.relative(root, path.join(sibling, "avro"))}`, gone: "file:../gone" } }));
        const found = Object.fromEntries(fileDependencies(root).map((d) => [d.name, d.dir]));
        expect(found["@x/avro"]).toBe(path.join(realpathSync(sibling), "avro"));
        expect(found.direct).toBe(path.join(realpathSync(sibling), "avro"));
        expect(found.gone).toBeUndefined();
      } finally {
        rmSync(sibling, { recursive: true, force: true });
      }
    });

    it("is empty without a readable manifest", () => {
      rmSync(path.join(root, "package.json"));
      expect(fileDependencies(root)).toEqual([]);
    });
  });

  describe("the hash follows the dist of a `file:` dependency", () => {
    let sibling: string;
    beforeEach(() => {
      sibling = mkdtempSync(path.join(tmpdir(), "e2e-sibling-"));
      mkdirSync(path.join(sibling, "avro", "dist"), { recursive: true });
      writeFileSync(path.join(sibling, "avro", "dist", "index.js"), "export const emit = 1;");
      writeFileSync(path.join(sibling, "avro", "src.ts"), "// the source: not what the app runs");
      put("package.json", JSON.stringify({ dependencies: { "@typespec/avro": `file:${path.relative(root, path.join(sibling, "avro"))}` } }));
    });
    afterEach(() => rmSync(sibling, { recursive: true, force: true }));

    it("changes when the dependency is built again with other output, and when a file of its dist appears or goes", () => {
      const before = hash();
      writeFileSync(path.join(sibling, "avro", "dist", "index.js"), "export const emit = 2;");
      const rebuilt = hash();
      expect(rebuilt).not.toBe(before);
      writeFileSync(path.join(sibling, "avro", "dist", "emitter.js"), "x");
      const added = hash();
      expect(added).not.toBe(rebuilt);
      rmSync(path.join(sibling, "avro", "dist", "emitter.js"));
      expect(hash()).toBe(rebuilt);
    });

    it("does not change for what is not the built output (its source, a README), nor for a touch without a change", () => {
      const before = hash();
      writeFileSync(path.join(sibling, "avro", "src.ts"), "// another source");
      writeFileSync(path.join(sibling, "avro", "README.md"), "docs");
      writeFileSync(path.join(sibling, "avro", "dist", "index.js"), "export const emit = 1;");
      expect(hash()).toBe(before);
    });

    it("changes when the dist goes away, or the whole directory does (a sibling repository that was not built is not the same build)", () => {
      const before = hash();
      rmSync(path.join(sibling, "avro", "dist"), { recursive: true });
      const noDist = hash();
      expect(noDist).not.toBe(before);
      rmSync(path.join(sibling, "avro"), { recursive: true });
      expect(hash()).not.toBe(noDist);
    });
  });
});
