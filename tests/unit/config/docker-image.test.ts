import { existsSync, lstatSync, readdirSync, readFileSync, statSync } from "node:fs";
import path from "node:path";
import { describe, expect, it } from "vitest";

// The image (.docker/Dockerfile) and what it is built from (.dockerignore). `docker build` cannot run in the unit suite, so these pin the
// parts that have broken it: a COPY of a directory the repository does not have, a type-check that reaches a file the context left out,
// and a runtime that would open an empty embedded database.
const REPO = path.resolve(__dirname, "../../..");
const DOCKERFILE = readFileSync(path.join(REPO, ".docker", "Dockerfile"), "utf8");
const DOCKERIGNORE = readFileSync(path.join(REPO, ".dockerignore"), "utf8");

/** The text of one build stage: from its `FROM ... AS <name>` line up to the next `FROM`. */
function stage(name: string): string {
  const lines = DOCKERFILE.split("\n");
  const start = lines.findIndex((line) => new RegExp(`^FROM .* AS ${name}$`).test(line));
  if (start < 0) throw new Error(`the Dockerfile has no stage named ${name}`);
  const next = lines.findIndex((line, index) => index > start && /^FROM /.test(line));
  return lines.slice(start, next < 0 ? undefined : next).join("\n");
}

/** Docker's matching: a pattern is relative to the context root, `*` stays in one directory, `**` crosses them, and an excluded directory excludes what is under it. */
function toRegExp(pattern: string): RegExp {
  let source = "";
  for (let i = 0; i < pattern.length; i++) {
    const char = pattern[i];
    if (char === "*" && pattern[i + 1] === "*") {
      if (pattern[i + 2] === "/") {
        source += "(?:.*/)?";
        i += 2;
      } else {
        source += ".*";
        i += 1;
      }
    } else if (char === "*") source += "[^/]*";
    else if (char === "?") source += "[^/]";
    else source += char.replace(/[.+^${}()|[\]\\]/g, "\\$&");
  }
  return new RegExp(`^${source}$`);
}

const IGNORE_PATTERNS = DOCKERIGNORE.split("\n")
  .map((line) => line.trim())
  .filter((line) => line !== "" && !line.startsWith("#"))
  .map(toRegExp);

/** True when the build context leaves `relativePath` out (a file, or a directory on the way to it). */
const excludedByDockerignore = (relativePath: string): boolean => {
  const parts = relativePath.split("/");
  return parts.some((_, index) => {
    const prefix = parts.slice(0, index + 1).join("/");
    return IGNORE_PATTERNS.some((pattern) => pattern.test(prefix));
  });
};

/** Every file the build context sends: the repository minus what .dockerignore leaves out. Symlinks are entries, not followed (Docker copies them as links). */
function contextFiles(): string[] {
  const files: string[] = [];
  const walk = (relative: string): void => {
    for (const name of readdirSync(path.join(REPO, relative))) {
      const entry = relative === "" ? name : `${relative}/${name}`;
      if (excludedByDockerignore(entry)) continue;
      if (lstatSync(path.join(REPO, entry)).isDirectory()) walk(entry);
      else files.push(entry);
    }
  };
  walk("");
  return files;
}

/** The relative module specifiers of a source file (`from "./x"`, `import("../x")`, `require("./x")`, `import "./x"`). */
function relativeImports(text: string): string[] {
  const pattern = /(?:\bfrom\s*|\bimport\s*\(\s*|\brequire\s*\(\s*|\bimport\s+)["'](\.{1,2}\/[^"']+)["']/g;
  return [...text.matchAll(pattern)].map((match) => match[1]);
}

/** The repository file a relative specifier names (TypeScript's resolution, the common forms only), or undefined when none exists. */
function resolveSource(fromFile: string, specifier: string): string | undefined {
  const base = path.posix.normalize(path.posix.join(path.posix.dirname(fromFile), specifier));
  const candidates = [
    base,
    base.replace(/\.js$/, ".ts"),
    base.replace(/\.js$/, ".tsx"),
    `${base}.ts`,
    `${base}.tsx`,
    `${base}.mts`,
    `${base}.d.ts`,
    `${base}/index.ts`,
    `${base}/index.tsx`,
  ];
  return candidates.find((candidate) => existsSync(path.join(REPO, candidate)) && statSync(path.join(REPO, candidate)).isFile());
}

describe("Dockerfile: the runtime stage", () => {
  it("copies public/, which the build stage must create: the repository has no public/ directory, and a COPY of a missing directory stops the build", () => {
    const build = stage("build");
    expect(stage("runtime")).toMatch(/^COPY --from=build \/app\/public \.\/public$/m);
    expect(build).toMatch(/^RUN mkdir -p public$/m);
    expect(build.indexOf("RUN mkdir -p public")).toBeLessThan(build.indexOf("RUN npm run build"));
  });

  it("is PostgreSQL only: with DB_PROVIDER unset it would open an embedded database that has no tables in the image", () => {
    expect(stage("runtime")).toMatch(/^ENV DB_PROVIDER="?postgresql"?$/m);
  });

  it("has a migrate stage built from the build stage (Prisma CLI, tsx and the sources), whose command is the deploy step", () => {
    expect(stage("migrate")).toMatch(/^FROM build AS migrate$/m);
    expect(stage("migrate")).toMatch(/^CMD \["npm", "run", "db:deploy"\]$/m);
  });

  it("runs the migrate stage in production mode, so a seed run there never makes the development administrator (admin@admin.com)", () => {
    expect(stage("migrate")).toMatch(/^ENV NODE_ENV=production$/m);
  });
});

describe(".dockerignore: the build context", () => {
  it("keeps the browser and unit test tooling out of the image", () => {
    expect(excludedByDockerignore("tests/e2e/helpers/auth-state.ts")).toBe(true);
    expect(excludedByDockerignore("playwright.config.ts")).toBe(true);
    expect(excludedByDockerignore("vitest.config.ts")).toBe(true);
  });

  it("leaves no file in the context importing a file the context does not contain (next build type-checks every tsconfig file)", () => {
    // The matcher has to see the application: an empty context would pass this test for free.
    expect(excludedByDockerignore("src/lib/db.ts")).toBe(false);
    const files = contextFiles();
    expect(files).toContain("scripts/db.ts");
    const violations: string[] = [];
    for (const file of files) {
      if (!/\.(ts|tsx|mts)$/.test(file)) continue;
      for (const specifier of relativeImports(readFileSync(path.join(REPO, file), "utf8"))) {
        const target = resolveSource(file, specifier);
        if (target !== undefined && excludedByDockerignore(target)) violations.push(`${file} imports ${specifier} (${target}), which the image leaves out`);
      }
    }
    expect(violations).toEqual([]);
  });
});
