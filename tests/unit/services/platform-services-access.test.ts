// @vitest-environment node
/**
 * The platform services (emitter configuration, health and metrics, webhooks, the classification taxonomy, the Git integration) decide with the
 * policy over the caller's assignments, not from a role label: only a GLOBAL administrator holds a platform action (`emitter.manage`,
 * `platform.admin`, `classification.manage`, `git.manage`), so an administrator of every tenant does not, and a context that carries no assignments
 * (an older caller, a test) is refused. A refused call reaches no database.
 */
import { describe, expect, it, vi } from "vitest";

const h = vi.hoisted(() => {
  const boom = () => {
    throw new Error("the database was reached");
  };
  return { boom, NO_DATABASE: new Proxy({}, { get: boom }) };
});
const NO_DATABASE = h.NO_DATABASE;
vi.mock("@/lib/db", () => ({ prisma: h.NO_DATABASE }));
vi.mock("@/lib/audit", () => ({ AuditUserMissingError: class extends Error {}, withAudit: h.boom }));

import { assign } from "../../helpers/access-mocks";
import * as emitters from "@/services/emitter-config.service";
import * as health from "@/services/health.service";
import * as webhooks from "@/services/webhook.service";
import * as classifications from "@/services/classification-taxonomy.service";
import * as gitService from "@/services/git.service";
import type { ServiceContext } from "@/types/service-context";

const ctxOf = (assignments: ServiceContext["assignments"]): ServiceContext => ({ userId: "u1", userRole: "VIEWER", assignments, prisma: NO_DATABASE as never });

const WHO_IS_REFUSED: Array<[string, ServiceContext]> = [
  ["no assignments at all", ctxOf(undefined)],
  ["an empty list", ctxOf([])],
  ["a tenant administrator", ctxOf([assign.tenant("ADMIN", "tenant-1")])],
  ["an administrator of two tenants", ctxOf([assign.tenant("ADMIN", "tenant-1"), assign.tenant("ADMIN", "tenant-2")])],
  ["a domain administrator", ctxOf([assign.domain("ADMIN", "tenant-1", "dom-a")])],
  ["a compliance officer and a steward", ctxOf([assign.tenant("COMPLIANCE_OFFICER", "tenant-1"), assign.tenant("STEWARD", "tenant-1")])],
  ["a label that says ADMIN but no assignment", { ...ctxOf(undefined), userRole: "ADMIN" }],
];

type Call = (ctx: ServiceContext) => Promise<{ success: boolean; error?: { code: string } }>;
const CALLS: Array<[string, Call]> = [
  ["getEmitterConfigs", (ctx) => emitters.getEmitterConfigs(ctx)],
  ["getEmitterConfigByName", (ctx) => emitters.getEmitterConfigByName("avro", ctx)],
  ["updateEmitterConfig", (ctx) => emitters.updateEmitterConfig({} as never, ctx)],
  ["testEmitter", (ctx) => emitters.testEmitter("avro", "ent-1", ctx)],
  ["getTypeMappingsForTarget", (ctx) => emitters.getTypeMappingsForTarget("avro", ctx)],
  ["createTypeMappingOverride (emitter)", (ctx) => emitters.createTypeMappingOverride({} as never, ctx)],
  ["updateTypeMapping", (ctx) => emitters.updateTypeMapping("m1", "string", ctx)],
  ["deleteTypeMappingOverride", (ctx) => emitters.deleteTypeMappingOverride("m1", ctx)],
  ["getUsageMetrics", (ctx) => health.getUsageMetrics(ctx)],
  ["getActivityMetrics", (ctx) => health.getActivityMetrics(ctx)],
  ["getErrorSummary", (ctx) => health.getErrorSummary(ctx)],
  ["getErrorDetails", (ctx) => health.getErrorDetails("compilation", ctx)],
  ["createEndpoint", (ctx) => webhooks.createEndpoint({} as never, ctx)],
  ["updateEndpoint", (ctx) => webhooks.updateEndpoint("w1", {} as never, ctx)],
  ["deleteEndpoint", (ctx) => webhooks.deleteEndpoint("w1", ctx)],
  ["getEndpoints", (ctx) => webhooks.getEndpoints(ctx)],
  ["getDeliveries", (ctx) => webhooks.getDeliveries("w1", ctx)],
  ["createClassification", (ctx) => classifications.createClassification({} as never, ctx)],
  ["updateClassification", (ctx) => classifications.updateClassification({} as never, ctx)],
  ["deleteClassification", (ctx) => classifications.deleteClassification("c1", ctx)],
  ["configureRepository", (ctx) => gitService.configureRepository({} as never, ctx)],
  ["testConnection", (ctx) => gitService.testConnection("g1", ctx)],
  ["exportAll", (ctx) => gitService.exportAll(ctx)],
  ["enableExport", (ctx) => gitService.enableExport("g1", ctx)],
  ["disableExport", (ctx) => gitService.disableExport("g1", ctx)],
  ["getConfig", (ctx) => gitService.getConfig(ctx)],
];

describe.each(CALLS)("%s", (_name, call) => {
  it.each(WHO_IS_REFUSED)("refuses %s with a FORBIDDEN and reaches no database", async (_who, ctx) => {
    const result = await call(ctx);
    expect(result.success).toBe(false);
    expect(result.error?.code).toBe("FORBIDDEN");
  });

  it("does not refuse a platform administrator (it goes on to its own work, which this test does not give a database)", async () => {
    // The gate is passed when the call reaches the database stand-in, which throws; a refusal would have been a FORBIDDEN result instead.
    let outcome: { success: boolean; error?: { code: string } } | "reached";
    try {
      outcome = await call(ctxOf([assign.global()]));
    } catch (e: unknown) {
      outcome = (e as Error).message === "the database was reached" ? "reached" : { success: false, error: { code: "OTHER" } };
    }
    if (outcome !== "reached") expect(outcome.error?.code).not.toBe("FORBIDDEN");
  });
});
