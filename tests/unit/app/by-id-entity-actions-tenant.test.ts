import { beforeEach, describe, expect, it, vi } from "vitest";

// Tenant scoping + generic failures of EVERY by-id action in schemas/[domainSlug]/[productSlug]/[entityId]/actions.ts
// (F2 guarded updateFieldAction only). Each action is checked three ways: an entity (or field) of ANOTHER tenant gets the
// byte-identical answer of a MISSING one and NOTHING reaches a prisma write, an emitter, a deployment or a version service;
// the caller's own entity still works; an unexpected throw carrying a Prisma-like message (absolute path + source excerpt)
// reaches the browser as the generic message only.

const h = vi.hoisted(() => ({
  auth: vi.fn(),
  getActiveTenantId: vi.fn(),
  revalidatePath: vi.fn(),
  updateEntity: vi.fn(),
  getEffectiveRole: vi.fn(),
  createGlobalOverride: vi.fn(),
  createEntityOverride: vi.fn(),
  acknowledgeLossyMapping: vi.fn(),
  getOverridesForEntity: vi.fn(),
  getVersionHistory: vi.fn(),
  compareVersionsStructured: vi.fn(),
  getChangeHistory: vi.fn(),
  emitEntity: vi.fn(),
  emitOfficial: vi.fn(),
  getDeploymentStatus: vi.fn(),
  markAsDeployed: vi.fn(),
  updateDriftStatus: vi.fn(),
  compile: vi.fn(),
  prisma: {
    entity: { findUnique: vi.fn(), update: vi.fn() },
    field: { findFirst: vi.fn(), findUnique: vi.fn(), findMany: vi.fn(), create: vi.fn(), update: vi.fn(), delete: vi.fn() },
    auditLog: { create: vi.fn() },
    $executeRawUnsafe: vi.fn(),
    $transaction: vi.fn(),
  },
}));

vi.mock("@/lib/db", () => ({ prisma: h.prisma }));
vi.mock("@/lib/auth", () => ({ auth: h.auth }));
vi.mock("next/cache", () => ({ revalidatePath: h.revalidatePath }));
vi.mock("@/lib/active-tenant", () => ({ getActiveTenantId: h.getActiveTenantId }));
vi.mock("@/services/rbac.service", () => ({ getEffectiveRole: h.getEffectiveRole }));
vi.mock("@/services/entity.service", () => ({ updateEntity: h.updateEntity }));
vi.mock("@/services/type-mapping.service", () => ({
  createGlobalOverride: h.createGlobalOverride,
  createEntityOverride: h.createEntityOverride,
  acknowledgeLossyMapping: h.acknowledgeLossyMapping,
  getOverridesForEntity: h.getOverridesForEntity,
}));
vi.mock("@/services/version-history/version.service", () => ({
  getVersionHistory: h.getVersionHistory,
  compareVersionsStructured: h.compareVersionsStructured,
}));
vi.mock("@/services/change-history.service", () => ({ getChangeHistory: h.getChangeHistory }));
vi.mock("@/lib/emission/emission.service", () => ({ emitEntity: h.emitEntity }));
vi.mock("@/lib/typespec-official/emitter.service", () => ({ emitOfficialTypeSpecTargetForEntity: h.emitOfficial }));
vi.mock("@/services/deployment.service", () => ({
  getDeploymentStatus: h.getDeploymentStatus,
  markAsDeployed: h.markAsDeployed,
  updateDriftStatus: h.updateDriftStatus,
}));
vi.mock("@/lib/compiler/typespec-compiler", () => ({ compileTypeSpecWithGovernance: h.compile }));

import { MARK_DRAFT_CHANGED_SQL } from "@/lib/entity-versioning/draft-state";
import { GENERIC_ACTION_ERROR } from "@/types/action-result";
import * as actions from "@/app/(dashboard)/schemas/[domainSlug]/[productSlug]/[entityId]/actions";

const T = "tenant-1";
const OTHER = "tenant-2";
const asAny = (v: unknown) => v as never;
type Mock = ReturnType<typeof vi.fn>;
const mk = (fn: unknown) => fn as Mock;
const p = h.prisma;

const PRISMA_TEXT =
  "Invalid `prisma.field.create()` invocation in\n/Users/dev/src/my/super-schema/src/app/(dashboard)/schemas/[domainSlug]/[productSlug]/[entityId]/actions.ts:145:30\n\n" +
  "  142 sortOrder: maxField ? maxField.sortOrder + 1 : 0,\n→ 145 prisma.field.create({ data: { name: undefined\nArgument `name` is missing.";
const LEAKS = /prisma|Users\/dev|actions\.ts|invocation|Argument|undefined|Cannot read properties|TypeError/i;

const version = (status: string) => ({ version: 1, status, output: "DDL", generatedAt: "2026-01-01T00:00:00.000Z", entityVersion: 1 });
/** An entity row as every entity lookup of these actions can read it (a superset of each action's `select`). */
const entityRow = (tenantId: string, versionStatus = "draft") => ({
  id: "ent-1", tenantId, name: "Order", description: "d", status: "DRAFT", version: 1, domainId: null, productId: null, domain: null,
  typespecSource: "model Order {}", metadata: { schemaVersions: { bigquery: [version(versionStatus)] } },
});
const fieldRow = (tenantId: string) => ({ id: "fld-1", entityId: "ent-1", name: "email", slug: "email", type: "string", entity: { tenantId } });
const FIELD_ROW_FOR_MAPPING = {
  id: "fld-1", name: "email", type: "string", precision: null, scale: null, nullable: true, isKey: false, fieldNumber: null, description: "",
  classification: null, aliases: [], decorators: {}, sortOrder: 0,
};

beforeEach(() => {
  vi.clearAllMocks();
  h.auth.mockResolvedValue({ user: { id: "user-1" } });
  h.getActiveTenantId.mockResolvedValue(T);
  h.getEffectiveRole.mockResolvedValue({ success: true, data: "AUTHOR" });
  p.auditLog.create.mockResolvedValue({ id: "audit-1" });
  p.entity.update.mockResolvedValue({ id: "ent-1" });
  p.entity.findUnique.mockResolvedValue(entityRow(T));
  p.field.findUnique.mockResolvedValue(fieldRow(T));
  p.field.findFirst.mockResolvedValue(null);
  p.field.findMany.mockResolvedValue([FIELD_ROW_FOR_MAPPING]);
  p.field.create.mockResolvedValue({ id: "fld-new" });
  p.field.update.mockResolvedValue({ id: "fld-1" });
  p.field.delete.mockResolvedValue({ id: "fld-1" });
  p.$transaction.mockImplementation(async (ops: unknown[]) => Promise.all(ops));
  h.updateEntity.mockResolvedValue({ success: true, data: { id: "ent-1" } });
  h.createGlobalOverride.mockResolvedValue({ success: true, data: { id: "ov-1" } });
  h.createEntityOverride.mockResolvedValue({ success: true, data: { id: "ov-2" } });
  h.acknowledgeLossyMapping.mockResolvedValue({ success: true, data: undefined });
  h.getOverridesForEntity.mockResolvedValue({ success: true, data: [] });
  h.getVersionHistory.mockResolvedValue({ success: true, data: [{ version: 1 }] });
  h.compareVersionsStructured.mockResolvedValue({ success: true, data: { changes: [] } });
  h.getChangeHistory.mockResolvedValue({ success: true, data: { entries: [], hasMore: false, nextCursor: null } });
  h.emitEntity.mockResolvedValue({ targets: {} });
  h.emitOfficial.mockResolvedValue({ output: "DDL", validationStatus: "VALID", warnings: [], errors: [] });
  h.getDeploymentStatus.mockResolvedValue({ success: true, data: [{ targetId: "ent-1:bigquery", environments: [{ name: "prod" }] }] });
  h.markAsDeployed.mockResolvedValue({ success: true, data: undefined });
  h.updateDriftStatus.mockResolvedValue({ success: true, data: undefined });
  h.compile.mockResolvedValue({ success: true, diagnostics: [], document: { models: [{ name: "Order", fields: [] }] }, fieldGovernance: {} });
});

// ---------------------------------------------------------------------------
// The table: one case per by-id action
// ---------------------------------------------------------------------------

interface Case {
  label: string;
  call: () => Promise<unknown>;
  /** The lookup that places the row in a tenant (the entity unless the action addresses a field). */
  lookup: () => Mock;
  row: (tenantId: string) => unknown;
  /** The answer for a foreign / missing row (default: `{ error: "Entity not found", code: "NOT_FOUND" }`). */
  notFound?: unknown;
  /** Everything that must NOT run for a foreign / missing row: writes, emitters, services. */
  mustNotRun: () => Mock[];
  /** What the legit path must reach. */
  main: () => Mock;
  /** A throw here (instead of `main` succeeding) must come back generic; null = the action has no catch (compile-and-apply). */
  failing: (() => Mock[]) | null;
  /** Is a successful result `success: true` (default) or does the action answer differently? */
  ok?: unknown;
  revalidates?: boolean;
}

const entityLookup = () => mk(p.entity.findUnique);
const WRITES = () => [mk(p.field.create), mk(p.field.update), mk(p.field.delete), mk(p.entity.update), mk(p.$transaction), mk(p.$executeRawUnsafe), mk(p.auditLog.create)];
const SERVICES = () => [
  mk(h.updateEntity), mk(h.createEntityOverride), mk(h.acknowledgeLossyMapping), mk(h.getVersionHistory), mk(h.compareVersionsStructured),
  mk(h.getChangeHistory), mk(h.emitEntity), mk(h.emitOfficial), mk(h.getDeploymentStatus), mk(h.markAsDeployed), mk(h.updateDriftStatus), mk(h.compile),
];
const ALL_EFFECTS = () => [...WRITES(), ...SERVICES()];

const CASES: Case[] = [
  {
    label: "addFieldAction (guards its PARENT entity)", call: () => actions.addFieldAction("ent-1", "email", "string"),
    lookup: entityLookup, row: (t) => entityRow(t), mustNotRun: ALL_EFFECTS, main: () => mk(p.field.create),
    failing: () => [mk(p.field.create)], ok: { success: true, field: { id: "fld-new" } },
  },
  {
    label: "deleteFieldAction", call: () => actions.deleteFieldAction("fld-1"),
    lookup: () => mk(p.field.findUnique), row: (t) => fieldRow(t), notFound: { error: "Field not found", code: "NOT_FOUND" },
    mustNotRun: ALL_EFFECTS, main: () => mk(p.field.delete), failing: () => [mk(p.field.delete)],
  },
  {
    label: "updateEntityStatusAction", call: () => actions.updateEntityStatusAction("ent-1", "ACTIVE"),
    lookup: entityLookup, row: (t) => entityRow(t), mustNotRun: ALL_EFFECTS, main: () => mk(h.updateEntity), failing: () => [mk(h.updateEntity)],
  },
  {
    label: "updateEntityRelationshipsAction", call: () => actions.updateEntityRelationshipsAction("ent-1", []),
    lookup: entityLookup, row: (t) => entityRow(t), mustNotRun: ALL_EFFECTS, main: () => mk(p.entity.update), failing: () => [mk(p.entity.update)],
  },
  {
    label: "emitEntityAction", call: () => actions.emitEntityAction("ent-1"),
    lookup: entityLookup, row: (t) => entityRow(t), mustNotRun: ALL_EFFECTS, main: () => mk(h.emitEntity), failing: () => [mk(h.emitEntity)], revalidates: false,
  },
  {
    label: "createTypeMappingOverrideAction (per-entity)",
    call: () => actions.createTypeMappingOverrideAction({ sourceType: "string", targetFormat: "avro", mappedType: "string", justification: "j", scope: "per-entity", entityId: "ent-1", isLossy: false }),
    lookup: entityLookup, row: (t) => entityRow(t), mustNotRun: ALL_EFFECTS, main: () => mk(h.createEntityOverride), failing: () => [mk(h.createEntityOverride)], ok: { success: true, override: { id: "ov-2" } },
  },
  {
    label: "acknowledgeLossyMappingAction", call: () => actions.acknowledgeLossyMappingAction({ entityId: "ent-1", sourceType: "string", targetFormat: "avro" }),
    lookup: entityLookup, row: (t) => entityRow(t), mustNotRun: ALL_EFFECTS, main: () => mk(h.acknowledgeLossyMapping), failing: () => [mk(h.acknowledgeLossyMapping)],
  },
  {
    label: "getVersionHistoryAction", call: () => actions.getVersionHistoryAction("ent-1"),
    lookup: entityLookup, row: (t) => entityRow(t), notFound: { error: "Entity not found", code: "NOT_FOUND", versions: [] },
    mustNotRun: ALL_EFFECTS, main: () => mk(h.getVersionHistory), failing: () => [mk(h.getVersionHistory)], revalidates: false,
  },
  {
    label: "compareVersionsAction", call: () => actions.compareVersionsAction("ent-1", 1, 2),
    lookup: entityLookup, row: (t) => entityRow(t), mustNotRun: ALL_EFFECTS, main: () => mk(h.compareVersionsStructured), failing: () => [mk(h.compareVersionsStructured)], revalidates: false,
  },
  {
    label: "getChangeHistoryAction", call: () => actions.getChangeHistoryAction("ent-1"),
    lookup: entityLookup, row: (t) => entityRow(t), mustNotRun: ALL_EFFECTS, main: () => mk(h.getChangeHistory), failing: () => [mk(h.getChangeHistory)], revalidates: false,
  },
  {
    label: "generateTypeSpecPreviewAction", call: () => actions.generateTypeSpecPreviewAction("ent-1"),
    lookup: entityLookup, row: (t) => entityRow(t), notFound: { error: "Entity not found", code: "NOT_FOUND", source: "" },
    mustNotRun: () => [mk(p.field.findMany), ...ALL_EFFECTS()], main: () => mk(p.field.findMany), failing: () => [mk(p.field.findMany)], revalidates: false,
  },
  {
    label: "applyTypeSpecAction", call: () => actions.applyTypeSpecAction("ent-1", [{ name: "phone", type: "string", isOptional: true, isKey: false, decorators: {} }]),
    lookup: entityLookup, row: (t) => entityRow(t), notFound: { added: 0, updated: 0, removed: [], error: "Entity not found" },
    mustNotRun: () => [mk(p.field.findMany), ...ALL_EFFECTS()], main: () => mk(p.field.create), failing: () => [mk(p.field.create)], ok: { added: 1, updated: 0, removed: [] },
  },
  {
    label: "getSchemaVersionsAction", call: () => actions.getSchemaVersionsAction("ent-1"),
    lookup: entityLookup, row: (t) => entityRow(t), mustNotRun: ALL_EFFECTS, main: () => entityLookup(), failing: null, revalidates: false,
  },
  {
    label: "getSchemaTargetFieldMappingsAction", call: () => actions.getSchemaTargetFieldMappingsAction("ent-1", "bigquery"),
    lookup: entityLookup, row: (t) => entityRow(t), notFound: { error: "Entity not found" },
    mustNotRun: () => [mk(p.field.findMany), ...ALL_EFFECTS()], main: () => mk(p.field.findMany), failing: () => [mk(p.field.findMany)], revalidates: false,
  },
  {
    label: "saveSchemaFieldTypeOverrideAction", call: () => actions.saveSchemaFieldTypeOverrideAction({ entityId: "ent-1", target: "bigquery", fieldId: "fld-1", mappedType: "" }),
    lookup: entityLookup, row: (t) => entityRow(t), notFound: { error: "Entity not found" },
    mustNotRun: () => [mk(p.field.findMany), ...ALL_EFFECTS()], main: () => mk(p.entity.update), failing: () => [mk(p.entity.update)],
  },
  {
    label: "generateSchemaAction", call: () => actions.generateSchemaAction("ent-1", "bigquery"),
    lookup: entityLookup, row: (t) => entityRow(t), mustNotRun: ALL_EFFECTS, main: () => mk(h.emitOfficial), failing: () => [mk(h.emitOfficial)],
  },
  {
    label: "publishSchemaAction", call: () => actions.publishSchemaAction("ent-1", "bigquery", 1),
    lookup: entityLookup, row: (t) => entityRow(t, "draft"), mustNotRun: ALL_EFFECTS, main: () => mk(p.entity.update), failing: () => [mk(p.entity.update)],
  },
  {
    label: "deploySchemaAction", call: () => actions.deploySchemaAction("ent-1", "bigquery", 1),
    lookup: entityLookup, row: (t) => entityRow(t, "published"), mustNotRun: ALL_EFFECTS, main: () => mk(p.entity.update), failing: () => [mk(p.entity.update)],
  },
  {
    label: "updateEntityMetadataAction", call: () => actions.updateEntityMetadataAction("ent-1", { tags: ["a"] }),
    lookup: entityLookup, row: (t) => entityRow(t), mustNotRun: ALL_EFFECTS, main: () => mk(p.entity.update), failing: () => [mk(p.entity.update)],
  },
  {
    label: "updateEntityDescriptionAction (guards through the shared lookup)", call: () => actions.updateEntityDescriptionAction("ent-1", "New description"),
    lookup: entityLookup, row: (t) => entityRow(t), mustNotRun: ALL_EFFECTS, main: () => mk(p.entity.update), failing: () => [mk(p.entity.update)],
  },
  {
    label: "getEntityDeploymentStatusAction", call: () => actions.getEntityDeploymentStatusAction("ent-1"),
    lookup: entityLookup, row: (t) => entityRow(t), notFound: { error: "Entity not found" },
    mustNotRun: ALL_EFFECTS, main: () => mk(h.getDeploymentStatus), failing: () => [mk(h.getDeploymentStatus)], revalidates: false,
  },
  {
    label: "markEntityDeployedAction", call: () => actions.markEntityDeployedAction("ent-1", "ent-1:bigquery", "production"),
    lookup: entityLookup, row: (t) => entityRow(t), notFound: { error: "Entity not found" },
    mustNotRun: ALL_EFFECTS, main: () => mk(h.markAsDeployed), failing: () => [mk(h.markAsDeployed)],
  },
  {
    label: "checkTargetDriftAction", call: () => actions.checkTargetDriftAction("ent-1", "ent-1:bigquery"),
    lookup: entityLookup, row: (t) => entityRow(t, "deployed"), notFound: { error: "Entity not found" },
    mustNotRun: ALL_EFFECTS, main: () => mk(h.updateDriftStatus), failing: () => [mk(h.updateDriftStatus)],
  },
  {
    label: "getTypeSpecSourceAction", call: () => actions.getTypeSpecSourceAction("ent-1"),
    lookup: entityLookup, row: (t) => entityRow(t), mustNotRun: () => [mk(p.field.findMany), ...ALL_EFFECTS()], main: () => entityLookup(), failing: null, revalidates: false,
  },
  {
    label: "compileAndApplyTypeSpecSourceAction", call: () => actions.compileAndApplyTypeSpecSourceAction("ent-1", "model Order {}"),
    lookup: entityLookup, row: (t) => entityRow(t), notFound: { success: false, diagnostics: [], error: "Entity not found" },
    mustNotRun: () => [mk(p.field.findMany), ...ALL_EFFECTS()], main: () => mk(p.entity.update), failing: null,
  },
];

const NOT_FOUND = { error: "Entity not found", code: "NOT_FOUND" };

describe.each(CASES)("$label", (c) => {
  it("works on an entity of the active tenant", async () => {
    c.lookup().mockResolvedValue(c.row(T));
    const result = await c.call();
    expect(result).toMatchObject(c.ok ?? ({ success: true } as object));
    expect(c.main()).toHaveBeenCalled();
    if (c.revalidates !== false) expect(h.revalidatePath).toHaveBeenCalled();
  });

  it("answers an entity of ANOTHER tenant with NOT_FOUND and nothing reaches a write, an emitter or a service", async () => {
    c.lookup().mockResolvedValue(c.row(OTHER));
    const result = await c.call();
    expect(result).toEqual(c.notFound ?? NOT_FOUND);
    for (const effect of c.mustNotRun()) expect(effect).not.toHaveBeenCalled();
    expect(h.revalidatePath).not.toHaveBeenCalled();
  });

  it("answers a MISSING entity byte-identically (no existence oracle across tenants)", async () => {
    c.lookup().mockResolvedValue(c.row(OTHER));
    const foreign = await c.call();
    c.lookup().mockResolvedValue(null);
    const missing = await c.call();
    expect(JSON.stringify(foreign)).toBe(JSON.stringify(missing));
    for (const effect of c.mustNotRun()) expect(effect).not.toHaveBeenCalled();
  });

  it("follows the ACTIVE tenant: foreign today, the caller's after a tenant switch", async () => {
    c.lookup().mockResolvedValue(c.row(OTHER));
    expect(await c.call()).toEqual(c.notFound ?? NOT_FOUND);
    h.getActiveTenantId.mockResolvedValue(OTHER);
    expect(await c.call()).not.toEqual(c.notFound ?? NOT_FOUND);
  });

  it("requires a session before any query", async () => {
    h.auth.mockResolvedValue(null);
    const result = (await c.call()) as { error?: string };
    expect(result.error).toMatch(/Not authenticated/);
    expect(c.lookup()).not.toHaveBeenCalled();
    for (const effect of c.mustNotRun()) expect(effect).not.toHaveBeenCalled();
  });

  it("returns the generic message (and logs the original) when the lookup throws a Prisma error with a path and a source excerpt", async () => {
    if (!c.failing) return; // compile-and-apply / pure reads have no catch of their own (an unhandled throw is hidden by Next in production)
    const spy = vi.spyOn(console, "error").mockImplementation(() => undefined);
    c.lookup().mockRejectedValue(new Error(PRISMA_TEXT));
    const result = (await c.call()) as { error?: string };
    expect(result.error).toBe(GENERIC_ACTION_ERROR);
    expect(JSON.stringify(result)).not.toMatch(LEAKS);
    expect(spy).toHaveBeenCalled();
    spy.mockRestore();
  });

  it("returns the generic message when the write / service behind it throws such an error", async () => {
    if (!c.failing) return;
    const spy = vi.spyOn(console, "error").mockImplementation(() => undefined);
    c.lookup().mockResolvedValue(c.row(T));
    for (const failing of c.failing()) failing.mockRejectedValue(new Error(PRISMA_TEXT));
    const result = (await c.call()) as { error?: string; success?: boolean };
    expect(result.error).toBe(GENERIC_ACTION_ERROR);
    expect(result.success).not.toBe(true);
    expect(JSON.stringify(result)).not.toMatch(LEAKS);
    spy.mockRestore();
  });
});

// ---------------------------------------------------------------------------
// Action-specific behaviour
// ---------------------------------------------------------------------------

describe("addFieldAction names and input", () => {
  it("stores the TRIMMED name (and slugs the trimmed text)", async () => {
    await actions.addFieldAction("ent-1", "  Email Address  ", "string");
    expect(p.field.create).toHaveBeenCalledWith({ data: expect.objectContaining({ name: "Email Address", slug: "email-address" }) });
  });

  it.each([[""], ["   "], ["\n\t"], [asAny(5)], [asAny(null)], [asAny(undefined)], [asAny({})]])("rejects the name %j with VALIDATION_ERROR before any query", async (name) => {
    expect(await actions.addFieldAction("ent-1", name, "string")).toEqual({ error: "Field name is required", code: "VALIDATION_ERROR" });
    expect(p.entity.findUnique).not.toHaveBeenCalled();
    expect(p.field.create).not.toHaveBeenCalled();
  });

  it("rejects a non-string type with VALIDATION_ERROR before any query", async () => {
    expect(await actions.addFieldAction("ent-1", "email", asAny(5))).toEqual({ error: "Field type is required", code: "VALIDATION_ERROR" });
    expect(p.entity.findUnique).not.toHaveBeenCalled();
  });

  it("does not even read the foreign entity's field numbers (no information leaves another tenant)", async () => {
    p.entity.findUnique.mockResolvedValue(entityRow(OTHER));
    p.field.findFirst.mockResolvedValue({ name: "secret_field", fieldNumber: 7, sortOrder: 7 });
    expect(await actions.addFieldAction("ent-1", "email", "string")).toEqual(NOT_FOUND);
    expect(p.field.findFirst).not.toHaveBeenCalled();
  });

  it("the Prisma validation text (absolute path + source excerpt) is logged, never returned", async () => {
    const spy = vi.spyOn(console, "error").mockImplementation(() => undefined);
    p.field.findFirst.mockRejectedValue(new Error(PRISMA_TEXT));
    const result = await actions.addFieldAction("ent-1", "email", "string");
    expect(result).toEqual({ error: GENERIC_ACTION_ERROR, code: "INTERNAL_ERROR" });
    expect(spy).toHaveBeenCalledWith("[addFieldAction] unexpected error", expect.objectContaining({ message: PRISMA_TEXT }));
    spy.mockRestore();
  });

  it("still reports a duplicate name by name", async () => {
    p.$transaction.mockRejectedValue(new Error("Unique constraint failed on the fields: (`entityId`,`slug`)"));
    expect(await actions.addFieldAction("ent-1", " email ", "string")).toEqual({ error: 'Field "email" already exists' });
  });
});

describe("updateFieldAction names (F2 guarded the field; names are new)", () => {
  const update = (data: unknown) => actions.updateFieldAction("fld-1", asAny(data));

  it("stores a TRIMMED rename and slugs the trimmed text", async () => {
    expect(await update({ name: "  email_address  " })).toEqual({ success: true });
    expect(p.field.update).toHaveBeenCalledWith({ where: { id: "fld-1" }, data: { name: "email_address", slug: "email-address" } });
  });

  it("a padded name that equals the stored one after trimming is no rename (no slug churn)", async () => {
    expect(await update({ name: " email " })).toEqual({ success: true });
    expect(p.field.update).toHaveBeenCalledWith({ where: { id: "fld-1" }, data: { name: "email" } });
  });

  it.each([[""], ["   "], ["\t\n"]])("rejects the blank name %j with VALIDATION_ERROR before any read or write", async (name) => {
    expect(await update({ name })).toEqual({ error: "Field name is required", code: "VALIDATION_ERROR" });
    expect(p.field.findUnique).not.toHaveBeenCalled();
    expect(p.field.update).not.toHaveBeenCalled();
    expect(p.$transaction).not.toHaveBeenCalled();
  });

  it("an update without a name is untouched by the name rule", async () => {
    expect(await update({ description: "d" })).toEqual({ success: true });
    expect(p.field.update).toHaveBeenCalledWith({ where: { id: "fld-1" }, data: { description: "d" } });
  });

  it("rejects non-plain objects (a Date has no own keys: it used to be a no-op update that still marked the draft changed)", async () => {
    for (const data of [new Date(), new Map(), new Set(), /x/, new Error("x"), [], null, "x", 5]) {
      expect(await update(data), String(Object.prototype.toString.call(data))).toMatchObject({ code: "VALIDATION_ERROR" });
    }
    expect(p.field.update).not.toHaveBeenCalled();
    expect(p.$executeRawUnsafe).not.toHaveBeenCalled();
  });

  it("rejects a `decorators` value that is not a plain object", async () => {
    expect(await update({ decorators: new Date() })).toMatchObject({ code: "VALIDATION_ERROR" });
    expect(await update({ decorators: [] })).toMatchObject({ code: "VALIDATION_ERROR" });
    expect(p.field.update).not.toHaveBeenCalled();
  });

  it("a throw in the reads BEFORE the write (the field-number check) is generic too, not an unhandled rejection", async () => {
    const spy = vi.spyOn(console, "error").mockImplementation(() => undefined);
    p.field.findFirst.mockRejectedValue(new Error(PRISMA_TEXT));
    expect(await update({ fieldNumber: 3 })).toEqual({ error: GENERIC_ACTION_ERROR, code: "INTERNAL_ERROR" });
    spy.mockRestore();
  });
});

describe("the second client-supplied id of the deployment actions (the emission target) must be one of THIS entity's", () => {
  it("markEntityDeployedAction refuses another entity's target id (it would write that entity's deployment record) even when the entity id itself is the caller's", async () => {
    // same length as a real id: `slice(entityId.length + 1)` used to turn it into a valid target key
    const result = await actions.markEntityDeployedAction("ent-1", "ent-9:bigquery", "production");
    expect(result).toEqual({ error: "Emission target not found", code: "NOT_FOUND" });
    expect(h.markAsDeployed).not.toHaveBeenCalled();
  });

  it.each([[""], ["ent-1"], ["ent-1:"], [asAny(5)], [asAny(null)], [asAny(undefined)], [asAny({})]])("markEntityDeployedAction / checkTargetDriftAction refuse the target id %j", async (targetId) => {
    expect(await actions.markEntityDeployedAction("ent-1", targetId, "production")).toMatchObject({ error: "Emission target not found" });
    expect(await actions.checkTargetDriftAction("ent-1", targetId)).toMatchObject({ error: "Emission target not found" });
    expect(h.markAsDeployed).not.toHaveBeenCalled();
    expect(h.updateDriftStatus).not.toHaveBeenCalled();
  });

  it("checkTargetDriftAction refuses another entity's target id before any drift write", async () => {
    expect(await actions.checkTargetDriftAction("ent-1", "ent-9:bigquery")).toEqual({ error: "Emission target not found", code: "NOT_FOUND" });
    expect(h.updateDriftStatus).not.toHaveBeenCalled();
  });

  it("markEntityDeployedAction rejects a non-string environment before any query", async () => {
    expect(await actions.markEntityDeployedAction("ent-1", "ent-1:bigquery", asAny(5))).toEqual({ error: "The environment is required" });
    expect(p.entity.findUnique).not.toHaveBeenCalled();
  });
});

describe("input validation that used to reach a spread / a Prisma validator", () => {
  it("updateEntityRelationshipsAction rejects relationships that are not a list", async () => {
    for (const bad of [null, undefined, {}, "x", 5]) {
      expect(await actions.updateEntityRelationshipsAction("ent-1", asAny(bad))).toEqual({ error: "The relationships must be a list", code: "VALIDATION_ERROR" });
    }
    expect(p.entity.update).not.toHaveBeenCalled();
  });

  it("updateEntityMetadataAction rejects a metadata patch that is not a plain object (a Date / Map / array / string would still mark the draft changed)", async () => {
    for (const bad of [new Date(), new Map(), [], null, undefined, "tags", 5]) {
      expect(await actions.updateEntityMetadataAction("ent-1", asAny(bad))).toEqual({ error: "The metadata changes must be an object", code: "VALIDATION_ERROR" });
    }
    expect(p.entity.findUnique).not.toHaveBeenCalled();
    expect(p.entity.update).not.toHaveBeenCalled();
  });

  it("updateEntityDescriptionAction rejects a description that is not text", async () => {
    for (const bad of [null, undefined, 5, {}, ["x"]]) {
      expect(await actions.updateEntityDescriptionAction("ent-1", asAny(bad))).toEqual({ error: "The description must be text", code: "VALIDATION_ERROR" });
    }
    expect(p.$transaction).not.toHaveBeenCalled();
  });

  it("applyTypeSpecAction rejects parsed fields that are not a list", async () => {
    expect(await actions.applyTypeSpecAction("ent-1", asAny(null))).toMatchObject({ error: "The parsed fields must be a list", added: 0 });
    expect(p.field.findMany).not.toHaveBeenCalled();
  });

  it("createTypeMappingOverrideAction: a GLOBAL override names no entity (no entity lookup); an unknown scope or a non-object input is a validation failure", async () => {
    const base = { sourceType: "string", targetFormat: "avro", mappedType: "string", justification: "j", entityId: "ignored", isLossy: false };
    expect(await actions.createTypeMappingOverrideAction({ ...base, scope: "global" })).toMatchObject({ success: true });
    expect(p.entity.findUnique).not.toHaveBeenCalled();
    expect(h.createGlobalOverride).toHaveBeenCalledTimes(1);
    for (const bad of [{ ...base, scope: "tenant" }, { ...base, scope: undefined }, null, "x"]) {
      expect(await actions.createTypeMappingOverrideAction(asAny(bad))).toMatchObject({ code: "VALIDATION_ERROR" });
    }
    expect(h.createEntityOverride).not.toHaveBeenCalled();
  });

  it("acknowledgeLossyMappingAction / saveSchemaFieldTypeOverrideAction reject a non-object input", async () => {
    expect(await actions.acknowledgeLossyMappingAction(asAny(null))).toMatchObject({ code: "VALIDATION_ERROR" });
    expect(await actions.saveSchemaFieldTypeOverrideAction(asAny("x"))).toMatchObject({ code: "VALIDATION_ERROR" });
  });
});

describe("service failures keep their message, except opaque codes", () => {
  it("updateEntityStatusAction: a domain failure keeps its text and code; a DB_ERROR becomes the generic message", async () => {
    const spy = vi.spyOn(console, "error").mockImplementation(() => undefined);
    h.updateEntity.mockResolvedValue({ success: false, error: { code: "INVALID_TRANSITION", message: "Cannot transition from DRAFT to RETIRED" } });
    expect(await actions.updateEntityStatusAction("ent-1", "RETIRED")).toEqual({ error: "Cannot transition from DRAFT to RETIRED", code: "INVALID_TRANSITION" });
    h.updateEntity.mockResolvedValue({ success: false, error: { code: "DB_ERROR", message: 'relation "entities" does not exist at 10.0.0.5:5432' } });
    expect(await actions.updateEntityStatusAction("ent-1", "RETIRED")).toEqual({ error: GENERIC_ACTION_ERROR, code: "DB_ERROR" });
    spy.mockRestore();
  });

  it("the history and deployment reads turn an opaque service failure into the generic message", async () => {
    const spy = vi.spyOn(console, "error").mockImplementation(() => undefined);
    const dbError = { success: false, error: { code: "INTERNAL_ERROR", message: "connect ECONNREFUSED 10.0.0.5:5432" } };
    h.getVersionHistory.mockResolvedValue(dbError);
    h.getChangeHistory.mockResolvedValue(dbError);
    h.getDeploymentStatus.mockResolvedValue(dbError);
    expect(await actions.getVersionHistoryAction("ent-1")).toMatchObject({ error: GENERIC_ACTION_ERROR, versions: [] });
    expect(await actions.getChangeHistoryAction("ent-1")).toMatchObject({ error: GENERIC_ACTION_ERROR });
    expect(await actions.getEntityDeploymentStatusAction("ent-1")).toMatchObject({ error: GENERIC_ACTION_ERROR });
    spy.mockRestore();
  });

  it("a Next control-flow error (redirect) thrown by a service passes through untouched", async () => {
    const redirect = Object.assign(new Error("NEXT_REDIRECT"), { digest: "NEXT_REDIRECT;replace;/schemas;307;" });
    h.getVersionHistory.mockRejectedValue(redirect);
    await expect(actions.getVersionHistoryAction("ent-1")).rejects.toBe(redirect);
  });
});

describe("the draft mark still rides with the write (F2 atomicity is intact)", () => {
  it("addFieldAction: ONE $transaction batch holds the field create and the draft + stale mark", async () => {
    await actions.addFieldAction("ent-1", "email", "string");
    expect(p.$transaction).toHaveBeenCalledTimes(1);
    expect(p.$transaction.mock.calls[0][0]).toHaveLength(2);
    expect(p.$executeRawUnsafe).toHaveBeenCalledWith(MARK_DRAFT_CHANGED_SQL, "ent-1");
  });
});
