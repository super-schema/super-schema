// @vitest-environment node
/**
 * No code decides anything from a single role label (access-control design, goal 3; foundation review I-2 and I-5).
 *
 * `ctx.userRole` is the role a caller holds at PLATFORM scope and nothing else: it says nothing about a tenant, a domain or a product, so a
 * tenant administrator is not "the" ADMIN to it and a migrated steward or compliance officer looks like a viewer. A decision over a
 * resource is `authorize` / `authorizeInActiveTenant` (src/lib/action-context.ts) or, inside a service, `can` / `grantAllowed` over the
 * caller's assignments. This scan lists every source file that still mentions the label; the list only shrinks: a file that no longer
 * mentions it must leave the list, and a new file may not mention it at all.
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

/**
 * TEMPORARY. The readers the access-control Task 5b / 6 / 7 still have to move to the policy, by owning area. Each one only sees the label
 * as the PLATFORM role (not a role over a resource), so the worst it does today is refuse a tenant administrator, never admit one.
 */
const PENDING_TASK_5B: Record<string, string> = {
  "src/app/api/v1/health/route.ts": "API v1 (Task 6)",
  "src/app/api/v1/middleware.ts": "API v1 principal (Task 6)",
  "src/server/api/procedures.ts": "dead oRPC routers: deleted in Task 7",
  "src/server/api/routers/admin/classifications.ts": "dead oRPC routers: deleted in Task 7",
  "src/server/api/routers/admin/domains.ts": "dead oRPC routers: deleted in Task 7",
  "src/server/api/routers/admin/emitters.ts": "dead oRPC routers: deleted in Task 7",
  "src/server/api/routers/admin/health.ts": "dead oRPC routers: deleted in Task 7",
  "src/server/api/routers/admin/users.ts": "dead oRPC routers: deleted in Task 7",
  "src/server/api/routers/annotation.ts": "dead oRPC routers: deleted in Task 7",
  "src/server/api/routers/compliance.ts": "dead oRPC routers: deleted in Task 7",
  "src/server/api/routers/domain.ts": "dead oRPC routers: deleted in Task 7",
  "src/server/api/routers/entity.ts": "dead oRPC routers: deleted in Task 7",
  "src/server/api/routers/field.ts": "dead oRPC routers: deleted in Task 7",
};

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

function filesMentioningTheLabel(): string[] {
  return sourceFiles("src")
    .filter((file) => readFileSync(file, "utf8").split("\n").some((line) => !isComment(line) && READER.test(line.replace(DELEGATE, ""))))
    .sort();
}

describe("the resource-relative role label is retired", () => {
  const mentioning = filesMentioningTheLabel();

  it("only the context builders and the files on the temporary list mention the label", () => {
    const unexpected = mentioning.filter((file) => !DEFINITIONS.includes(file) && !(file in PENDING_TASK_5B));
    expect(unexpected).toEqual([]);
  });

  it("the temporary list only shrinks: a file on it that no longer mentions the label must be removed from it", () => {
    const stale = Object.keys(PENDING_TASK_5B).filter((file) => !mentioning.includes(file));
    expect(stale).toEqual([]);
  });

  it("the scan itself finds readers (it is not vacuous)", () => {
    expect(mentioning.length).toBeGreaterThan(10);
  });

  it("the services decided here ask the policy: rbac.service reads no label", () => {
    const text = readFileSync("src/services/rbac.service.ts", "utf8");
    const code = text.split("\n").filter((line) => !isComment(line)).join("\n");
    expect(code.replace(DELEGATE, "")).not.toMatch(READER);
    expect(code).toMatch(/grantAllowed\(/);
  });
});
