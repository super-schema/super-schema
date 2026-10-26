// @vitest-environment node
/**
 * No code decides anything from a single role label (access-control design, goal 3; foundation review I-2 and I-5).
 *
 * `ctx.userRole` is the role a caller holds at PLATFORM scope and nothing else: it says nothing about a tenant, a domain or a product, so a
 * tenant administrator is not "the" ADMIN to it and a migrated steward or compliance officer looks like a viewer. A decision over a
 * resource is `authorize` / `authorizeInActiveTenant` (src/lib/action-context.ts) or, inside a service, `can` / `grantAllowed` over the
 * caller's assignments. This scan fails for any source file other than the context builders that mentions the label. The list of exceptions is EMPTY:
 * the last readers were the dead oRPC routers under `src/server/api`, which nothing mounted and which were deleted with Task 7.
 */
import { readdirSync, readFileSync, statSync } from "node:fs";
import { join } from "node:path";
import { describe, expect, it } from "vitest";

/** Where the label is defined and filled in (the context builders), and nothing else is exempt. */
const DEFINITIONS = [
  join("src", "types", "service-context.ts"),
  join("src", "lib", "action-context.ts"),
  // `"user" | "userRole"`: the Prisma delegate of the `user_roles` table, not the label.
  join("src", "lib", "admin-bootstrap.ts"),
].map((path) => path.replaceAll("\\", "/"));

const READER = /\buserRole\b/;
/** `prisma.userRole.findMany(...)`: the delegate of the `user_roles` table, not the label. */
const DELEGATE = /\.userRole(?=\.)/g;

function sourceFiles(dir: string, found: string[] = []): string[] {
  for (const name of readdirSync(dir)) {
    if (name === "generated" || name === "node_modules") continue;
    const full = join(dir, name);
    if (statSync(full).isDirectory()) sourceFiles(full, found);
    else if (/\.(ts|tsx)$/.test(name)) found.push(full.replaceAll("\\", "/"));
  }
  return found;
}

const isComment = (line: string) => /^\s*(\/\/|\*|\/\*)/.test(line);
const mentionsTheLabel = (text: string): boolean => text.split("\n").some((line) => !isComment(line) && READER.test(line.replace(DELEGATE, "")));

function filesMentioningTheLabel(): string[] {
  return sourceFiles("src")
    .filter((file) => mentionsTheLabel(readFileSync(file, "utf8")))
    .sort();
}

describe("the resource-relative role label is retired", () => {
  const mentioning = filesMentioningTheLabel();

  it("only the context builders mention the label: no service, action, route or router reads it", () => {
    expect(mentioning.filter((file) => !DEFINITIONS.includes(file))).toEqual([]);
  });

  it("the scan finds the definitions (it is not vacuous)", () => {
    expect(mentioning).toEqual(expect.arrayContaining(["src/lib/action-context.ts", "src/types/service-context.ts"]));
  });

  it("the scan sees a reader and ignores a comment and the Prisma delegate (self-test)", () => {
    expect(mentionsTheLabel("if (ctx.userRole !== 'ADMIN') return;")).toBe(true);
    expect(mentionsTheLabel("const { userRole } = ctx;")).toBe(true);
    expect(mentionsTheLabel("// ctx.userRole is retired\n * userRole")).toBe(false);
    expect(mentionsTheLabel("await prisma.userRole.findMany({});")).toBe(false);
  });

  it("the services decided here ask the policy: rbac.service reads no label", () => {
    const text = readFileSync("src/services/rbac.service.ts", "utf8");
    const code = text.split("\n").filter((line) => !isComment(line)).join("\n");
    expect(code.replace(DELEGATE, "")).not.toMatch(READER);
    expect(code).toMatch(/grantAllowed\(/);
  });

  it("the dead oRPC routers are gone, and nothing imports them", () => {
    expect(() => statSync("src/server")).toThrow();
    const importers = sourceFiles("src").filter((file) => /from\s+["'](@\/server\/|(\.\.?\/)+server\/api)/.test(readFileSync(file, "utf8")));
    expect(importers).toEqual([]);
  });
});
