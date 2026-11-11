import { readFileSync, lstatSync, existsSync } from "node:fs";
import { resolve, relative, sep } from "node:path";
import { execFileSync } from "node:child_process";
import { parseArgs } from "node:util";
import { basePath } from "../src/lib/gitops/contracts";
import { validateRepository } from "../src/lib/gitops/canonical";
const args = parseArgs({
  options: {
    repo: { type: "string", default: process.env.GITHUB_WORKSPACE ?? "." },
    root: { type: "string", default: process.env.INPUT_ROOT ?? "" },
    "base-ref": { type: "string", default: process.env.INPUT_BASE_REF },
    "current-ref": { type: "string" },
  },
});
const repo = resolve(args.values.repo!),
  root = basePath.parse(args.values.root);
const git = (...argv: string[]) =>
  execFileSync("git", argv, {
    cwd: repo,
    encoding: "utf8",
    maxBuffer: 100 * 1024 * 1024,
  });
const select = (path: string) =>
  path.startsWith(root ? `${root}/` : "") &&
  /(?:tenant|domain|product|entity|event|trait|enum|scalar|union|service|interface|model|decorator)\.yaml$/.test(
    path,
  );
function committed(ref: string) {
  const sha = git(
    "rev-parse",
    "--verify",
    "--end-of-options",
    `${ref}^{commit}`,
  ).trim();
  return git("ls-tree", "-r", "-z", "--full-tree", sha)
    .split("\0")
    .filter(Boolean)
    .flatMap((line) => {
      const tab = line.indexOf("\t"),
        [mode, type, blob] = line.slice(0, tab).split(" "),
        path = line.slice(tab + 1);
      if (!select(path)) return [];
      if (mode !== "100644" || type !== "blob")
        throw new Error(`Canonical path is not a regular file: ${path}`);
      return [{ path, content: git("show", `${sha}:${path}`), blob }];
    });
}
const current = args.values["current-ref"]
  ? committed(args.values["current-ref"])
  : git("ls-files", "-z", "--cached", "--others", "--exclude-standard")
      .split("\0")
      .filter(select)
      .filter((path) => existsSync(resolve(repo, path)))
      .map((path) => {
        const full = resolve(repo, path);
        if (relative(repo, full).startsWith(`..${sep}`))
          throw new Error("Path escapes repository");
        let part = repo;
        for (const segment of path.split("/")) {
          part = resolve(part, segment);
          if (lstatSync(part).isSymbolicLink())
            throw new Error(`Canonical paths cannot follow symlinks: ${path}`);
        }
        return { path, content: readFileSync(full, "utf8") };
      });
const eventBase = process.env.GITHUB_EVENT_PATH
  ? (JSON.parse(readFileSync(process.env.GITHUB_EVENT_PATH, "utf8"))
      .pull_request?.base?.sha as string | undefined)
  : undefined;
const baseRef = args.values["base-ref"] || eventBase;
const previous = baseRef ? committed(baseRef) : [];
const result = validateRepository(current, root, previous);
if (!result.documents.some((d) => d.document.kind === "Tenant"))
  result.errors.push({
    path: [root, "tenant.yaml"].filter(Boolean).join("/"),
    message: "A canonical tenant manifest is required",
  });
for (const error of result.errors)
  console.error(`${error.path}: ${error.message}`);
if (result.errors.length) process.exitCode = 1;
else
  console.log(
    `Validated ${result.documents.length} canonical documents under ${root || "repository root"}`,
  );
