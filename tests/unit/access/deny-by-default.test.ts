// @vitest-environment node
/**
 * Deny by default (access-control design, goal 3): every exported function of every "use server" module and every HTTP handler of every
 * `app/**\/route.ts` is GUARDED (asks `authorize` / `authorizeInActiveTenant` / `authorizeSubject` / `runMutation({ action, ... })` /
 * `withOwnedTarget("<action>", ...)` / `withApiAuth` BEFORE its first read or write, directly or through a helper of the same module), or is
 * listed in `src/lib/access/public-actions.ts` with a one-line reason. A new action or route with neither fails this test.
 *
 * The scan reads the syntax tree (tests/helpers/access-scan.ts): a guard that is only named in a comment or a string counts for nothing, and
 * a guard that comes after the function's first prisma / service / fetch call counts for nothing either. Its own behaviour is pinned below.
 *
 * TEMPORARY while access-control Task 5 and 6 are in progress: `PENDING_TASK_5B` (server actions) and `PENDING_TASK_6` (routes) name what is
 * still unguarded, each with its owning area, so the test is green now. The lists only shrink: an entry whose function is in fact guarded (or
 * no longer exists) fails the test until it is removed, so 5b and Task 6 must empty them and cannot leave a stale entry behind.
 */
import { describe, expect, it } from "vitest";
import { PUBLIC_ACTIONS, PUBLIC_ROUTES, isPublicRoute } from "@/lib/access/public-actions";
import { analyzeModule, scanRepository } from "../../helpers/access-scan";

/** TEMPORARY. Server actions still unguarded, keyed `<file>#<function>` -> owning area (the agent that guards them). */
const PENDING_TASK_5B: Record<string, string> = {
  "src/app/(dashboard)/admin/actions.ts#getUsersAction": "5b admin",
  "src/app/(dashboard)/admin/actions.ts#updateUserNameAction": "5b admin",
  "src/app/(dashboard)/admin/actions.ts#assignRoleAction": "5b admin",
  "src/app/(dashboard)/admin/actions.ts#removeRoleAction": "5b admin",
  "src/app/(dashboard)/admin/actions.ts#getHealthAction": "5b admin",
  "src/app/(dashboard)/admin/actions.ts#getEmitterConfigsAction": "5b admin",
  "src/app/(dashboard)/admin/actions.ts#updateEmitterConfigAction": "5b admin",
  "src/app/(dashboard)/admin/actions.ts#getDomainsAdminAction": "5b admin",
  "src/app/(dashboard)/admin/actions.ts#createDomainAdminAction": "5b admin",
  "src/app/(dashboard)/deployments/actions.ts#getDeploymentOverviewAction": "5b deployments",
};

/** TEMPORARY. Route handlers still unguarded, keyed `<route path>#<METHOD>` -> owning surface. */
const PENDING_TASK_6: Record<string, string> = {
  "/api/ai/generate-entity#POST": "Task 6 internal API",
  "/api/command-palette-fields#GET": "Task 6 internal API",
  "/api/compliance/audit-trail#POST": "Task 6 compliance routes",
  "/api/compliance/gaps#POST": "Task 6 compliance routes",
  "/api/compliance/query#POST": "Task 6 compliance routes",
  "/api/domains-tree#GET": "Task 6 internal API",
  "/api/tenants#GET": "Task 6 internal API",
  "/api/v1/event-specs/[id]#GET": "Task 6 API v1",
  "/api/v1/notifications#GET": "Task 6 API v1",
  "/api/v1/notifications#POST": "Task 6 API v1",
  "/api/v1/schemas/[id]/emit#POST": "Task 6 API v1",
  "/api/v1/schemas/[id]#GET": "Task 6 API v1",
  "/api/v1/schemas/[id]/validate#POST": "Task 6 API v1",
  "/api/v1/schemas#GET": "Task 6 API v1",
  "/api/v1/webhooks/[id]/deliveries#GET": "Task 6 API v1",
  "/api/v1/webhooks/[id]#PUT": "Task 6 API v1",
  "/api/v1/webhooks/[id]#DELETE": "Task 6 API v1",
  "/api/v1/webhooks#GET": "Task 6 API v1",
  "/api/v1/webhooks#POST": "Task 6 API v1",
};

const surfaces = scanRepository("src");
const actions = surfaces.filter((s) => s.kind === "action");
const routes = surfaces.filter((s) => s.kind === "route");

const OPEN_ACTION_KEYS = new Set(Object.keys(PUBLIC_ACTIONS));

describe("deny by default: server actions", () => {
  it("the scan finds the server actions (it is not vacuous)", () => {
    expect(actions.length).toBeGreaterThan(100);
    expect(new Set(actions.map((a) => a.file)).size).toBeGreaterThan(15);
  });

  it("every exported server action is guarded, public with a reason, or on the temporary pending list", () => {
    const loose = actions.filter((a) => !a.guarded && !OPEN_ACTION_KEYS.has(a.key) && !(a.key in PENDING_TASK_5B));
    expect(loose.map((a) => `${a.key}  (line ${a.line})`)).toEqual([]);
  });

  it("the pending list only shrinks: nothing on it is guarded, public or gone", () => {
    const byKey = new Map(actions.map((a) => [a.key, a]));
    const stale = Object.keys(PENDING_TASK_5B).filter((key) => {
      const found = byKey.get(key);
      return !found || found.guarded || OPEN_ACTION_KEYS.has(key);
    });
    expect(stale).toEqual([]);
  });

  it("every pending entry names its owning area", () => {
    for (const [key, area] of Object.entries(PENDING_TASK_5B)) expect(area.trim(), key).not.toBe("");
  });

  it("every public action exists, is not also pending, and carries a one-line reason", () => {
    const keys = new Set(actions.map((a) => a.key));
    for (const [key, reason] of Object.entries(PUBLIC_ACTIONS)) {
      expect(keys.has(key), `${key} is not an exported server action`).toBe(true);
      expect(key in PENDING_TASK_5B, `${key} is both public and pending`).toBe(false);
      expect(reason.trim().length, key).toBeGreaterThan(10);
      expect(reason, key).not.toMatch(/[\r\n]/);
    }
  });
});

describe("deny by default: route handlers", () => {
  it("the scan finds the route handlers (it is not vacuous)", () => {
    expect(routes.length).toBeGreaterThan(15);
  });

  it("every route handler is guarded, on the public route list, or on the temporary pending list", () => {
    const loose = routes.filter((r) => !r.guarded && !isPublicRoute(r.key.split("#")[0]) && !(r.key in PENDING_TASK_6));
    expect(loose.map((r) => `${r.key}  (${r.file}:${r.line})`)).toEqual([]);
  });

  it("the pending list only shrinks: nothing on it is guarded, public or gone", () => {
    const byKey = new Map(routes.map((r) => [r.key, r]));
    const stale = Object.keys(PENDING_TASK_6).filter((key) => {
      const found = byKey.get(key);
      return !found || found.guarded || isPublicRoute(key.split("#")[0]);
    });
    expect(stale).toEqual([]);
  });

  it("every pending entry names its owning surface", () => {
    for (const [key, area] of Object.entries(PENDING_TASK_6)) expect(area.trim(), key).not.toBe("");
  });

  it("every public route entry has a one-line reason and matches a route that exists", () => {
    const paths = routes.map((r) => r.key.split("#")[0]);
    for (const [entry, reason] of Object.entries(PUBLIC_ROUTES)) {
      expect(reason.trim().length, entry).toBeGreaterThan(10);
      expect(reason, entry).not.toMatch(/[\r\n]/);
      expect(paths.some((p) => isPublicRoute(p) && (entry.endsWith("/*") ? p.startsWith(entry.slice(0, -1)) || p === entry.slice(0, -2) : p === entry)), `${entry} matches no route`).toBe(true);
    }
  });
});

describe("the scan is strict (its own behaviour)", () => {
  const scan = (source: string) => analyzeModule(`"use server";\n${source}`, "fixture.ts");
  const guardedOf = (source: string, name = "act") => scan(source).functions.find((f) => f.name === name)?.guarded;
  const IMPORTS = `import { prisma } from "@/lib/db";\nimport { runMutation, authorize, authorizeInActiveTenant, authorizeSubject, withOwnedTarget, requireSession } from "@/lib/action-context";\nimport { saveThing } from "@/services/thing.service";\n`;

  it("passes a function that asks the policy before it touches the database", () => {
    expect(guardedOf(`${IMPORTS} export async function act(id: string) { const a = await authorize("entity.read", { tenantId: "t" }); if (!a.success) return; return prisma.entity.findMany(); }`)).toBe(true);
    expect(guardedOf(`${IMPORTS} export async function act(id: string) { const a = await authorizeInActiveTenant("entity.write", ref); return saveThing(id); }`)).toBe(true);
    expect(guardedOf(`${IMPORTS} export async function act(id: string) { const a = await authorizeSubject("entity.write", { kind: "entity", id }); return prisma.x.update({}); }`)).toBe(true);
  });

  it("passes runMutation with an action and withOwnedTarget with an action id, and refuses their older role-less shapes", () => {
    expect(guardedOf(`${IMPORTS} export async function act() { return runMutation({ action: "entity.write", resource: { kind: "entity", id: "e" } }, async (ctx) => saveThing(ctx)); }`)).toBe(true);
    expect(guardedOf(`${IMPORTS} export async function act() { return runMutation(async (ctx) => saveThing(ctx), "label"); }`)).toBe(false);
    expect(guardedOf(`${IMPORTS} export async function act(target: unknown) { return withOwnedTarget("event.write", target, async () => saveThing()); }`)).toBe(true);
    expect(guardedOf(`${IMPORTS} export async function act(target: unknown) { return withOwnedTarget(target, async () => saveThing()); }`)).toBe(false);
  });

  it("FAILS a guard that is only in a comment or in a string", () => {
    expect(guardedOf(`${IMPORTS} export async function act() { // authorize("entity.read", ref)\n return prisma.entity.findMany(); }`)).toBe(false);
    expect(guardedOf(`${IMPORTS} export async function act() { /* await authorizeInActiveTenant("a", b) */ return saveThing(); }`)).toBe(false);
    expect(guardedOf(`${IMPORTS} export async function act() { const note = 'authorize("entity.read", ref)'; return saveThing(note); }`)).toBe(false);
    expect(guardedOf(`${IMPORTS} export async function act() { const note = \`await authorize(x)\`; return prisma.x.findMany(note); }`)).toBe(false);
    expect(guardedOf(`${IMPORTS} export async function act() { return { authorize: 1, runMutation: 2 }; }`)).toBe(false);
  });

  it("FAILS a function whose guard comes after its first prisma, service or fetch call", () => {
    expect(guardedOf(`${IMPORTS} export async function act(id: string) { const row = await prisma.entity.findUnique({ where: { id } }); await authorize("entity.read", row); return row; }`)).toBe(false);
    expect(guardedOf(`${IMPORTS} export async function act(id: string) { const r = await saveThing(id); await authorizeInActiveTenant("entity.write", r); return r; }`)).toBe(false);
    expect(guardedOf(`${IMPORTS} export async function act(url: string) { const body = await fetch(url); await authorize("import.run", ref); return body; }`)).toBe(false);
    expect(guardedOf(`${IMPORTS} export async function act(id: string) { await authorize("entity.read", ref); return prisma.entity.findUnique({ where: { id } }); }`)).toBe(true);
  });

  it("FAILS a function that authenticates (requireSession, auth) and then reads or writes with no role asked", () => {
    expect(guardedOf(`${IMPORTS} export async function act() { await requireSession(); return prisma.entity.findMany(); }`)).toBe(false);
    expect(guardedOf(`${IMPORTS} export async function act() { return 1; }`)).toBe(false);
  });

  it("passes a function that delegates to a guarded helper of the same module, and fails one that delegates to an unguarded helper", () => {
    const guardedHelper = `${IMPORTS} async function gate(action: string) { const a = await authorizeInActiveTenant(action as never, ref); return a; }\n`;
    expect(guardedOf(`${guardedHelper} export async function act() { const g = await gate("entity.read"); return prisma.entity.findMany(); }`)).toBe(true);
    // The delegate's own guard counts only because it precedes the effect that follows the call.
    expect(guardedOf(`${guardedHelper} export async function act() { await prisma.audit.create({}); await gate("entity.read"); }`)).toBe(false);
    const unguardedHelper = `${IMPORTS} async function load(id: string) { return prisma.entity.findUnique({ where: { id } }); }\n`;
    expect(guardedOf(`${unguardedHelper} export async function act(id: string) { const r = await load(id); await authorize("entity.read", r); return r; }`)).toBe(false);
    expect(guardedOf(`${unguardedHelper} export async function act(id: string) { await authorize("entity.read", ref); return load(id); }`)).toBe(true);
  });

  it("sees every export shape: function, const arrow, const wrapped handler, export list, default", () => {
    const names = scan(
      `${IMPORTS} export async function a() {}\n export const b = async () => {};\n export const c = wrap(async () => {});\n async function d() {}\n export { d };\n export default async function () {}\n export type T = string;\n const hidden = async () => {};`
    ).functions.map((f) => f.name);
    expect(names.sort()).toEqual(["a", "b", "c", "d", "default"]);
  });

  it("reads the directive from the syntax: only a module whose FIRST statement is \"use server\" is a server-action module", () => {
    expect(analyzeModule(`"use server";\nexport async function a() {}`).useServer).toBe(true);
    expect(analyzeModule(`// header\n'use server'\nexport async function a() {}`).useServer).toBe(true);
    expect(analyzeModule(`export async function a() { "use server"; }`).useServer).toBe(false);
    expect(analyzeModule(`const s = "use server";\nexport async function a() {}`).useServer).toBe(false);
  });
});
