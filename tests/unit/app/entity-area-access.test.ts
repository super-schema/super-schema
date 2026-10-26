// @vitest-environment node
/**
 * Access control over the entity area (fields, schema generation, publish, deploy, type mapping, TypeSpec source, versions): every action of
 * `[entityId]/actions.ts` and `version-actions.ts` asks the policy BEFORE it reads or writes anything. The REAL guard runs here (nothing of
 * src/lib/action-context.ts or src/lib/access is replaced); what is replaced is the database and the services behind the actions, which are the
 * "effects" a refused caller must never reach.
 *
 * For each operation: nobody signed in, a user with no role, every role of the ladder (allowed exactly from the role the action table names),
 * a resource of another tenant (also for a user who holds a role there, because it is not the tenant in view), a domain-scoped author on the right
 * and on the wrong domain, and a tenant-level entity.
 */
import { beforeEach, describe, expect, it, vi } from "vitest";
import { ACTIONS, roleAtLeast } from "@/lib/access";
import { ROLE_HIERARCHY } from "@/types/schemas/rbac";
import { assign, principalModule, principalOf, roleless, signInAs, signedOut, tenantMember } from "../../helpers/access-mocks";
import type { ActionId } from "@/lib/access";
import type { Role } from "@/types/schemas/rbac";

const T = "tenant-1";
const OTHER = "tenant-2";

const h = vi.hoisted(() => {
  const fn = () => vi.fn();
  return {
    activeTenant: fn(),
    revalidatePath: fn(),
    entityFindUnique: fn(),
    fieldFindUnique: fn(),
    effects: {
      entityUpdate: fn(), fieldCreate: fn(), fieldUpdate: fn(), fieldDelete: fn(), fieldUpdateMany: fn(), fieldFindMany: fn(), fieldFindFirst: fn(),
      auditCreate: fn(), transaction: fn(), executeRaw: fn(), entityVersionFind: fn(),
      updateEntity: fn(), markAsDeployed: fn(), updateDriftStatus: fn(), getDeploymentStatus: fn(), createGlobalOverride: fn(),
      createEntityOverride: fn(), acknowledgeLossyMapping: fn(), getOverridesForEntity: fn(), getVersionHistory: fn(), compareVersionsStructured: fn(),
      getChangeHistory: fn(), emitEntity: fn(), emitOfficial: fn(), publishEntity: fn(), previewPublish: fn(), listEntityVersions: fn(), compile: fn(),
    },
  };
});

vi.mock("next/cache", () => ({ revalidatePath: h.revalidatePath }));
vi.mock("@/lib/auth", () => ({ auth: vi.fn() }));
vi.mock("@/lib/access/principal", async () => (await import("../../helpers/access-mocks")).principalModule);
vi.mock("@/lib/active-tenant", () => ({ getActiveTenantId: h.activeTenant }));
vi.mock("@/lib/db", () => ({
  prisma: {
    entity: { findUnique: h.entityFindUnique, update: h.effects.entityUpdate },
    field: {
      findUnique: h.fieldFindUnique, findFirst: h.effects.fieldFindFirst, findMany: h.effects.fieldFindMany, create: h.effects.fieldCreate,
      update: h.effects.fieldUpdate, delete: h.effects.fieldDelete, updateMany: h.effects.fieldUpdateMany,
    },
    entityVersion: { findUnique: h.effects.entityVersionFind },
    auditLog: { create: h.effects.auditCreate },
    $transaction: h.effects.transaction,
    $executeRawUnsafe: h.effects.executeRaw,
  },
}));
vi.mock("@/services/entity.service", () => ({ updateEntity: h.effects.updateEntity }));
vi.mock("@/services/deployment.service", () => ({
  getDeploymentStatus: h.effects.getDeploymentStatus, markAsDeployed: h.effects.markAsDeployed, updateDriftStatus: h.effects.updateDriftStatus,
}));
vi.mock("@/services/type-mapping.service", () => ({
  createGlobalOverride: h.effects.createGlobalOverride, createEntityOverride: h.effects.createEntityOverride,
  acknowledgeLossyMapping: h.effects.acknowledgeLossyMapping, getOverridesForEntity: h.effects.getOverridesForEntity,
}));
vi.mock("@/services/version-history/version.service", () => ({
  getVersionHistory: h.effects.getVersionHistory, compareVersionsStructured: h.effects.compareVersionsStructured,
}));
vi.mock("@/services/change-history.service", () => ({ getChangeHistory: h.effects.getChangeHistory }));
vi.mock("@/services/entity-version.service", () => ({
  publishEntity: h.effects.publishEntity, previewPublish: h.effects.previewPublish, listEntityVersions: h.effects.listEntityVersions,
}));
vi.mock("@/lib/emission/emission.service", () => ({ emitEntity: h.effects.emitEntity }));
vi.mock("@/lib/typespec-official/emitter.service", () => ({ emitOfficialTypeSpecTargetForEntity: h.effects.emitOfficial }));
vi.mock("@/lib/compiler/typespec-compiler", () => ({ compileTypeSpecWithGovernance: h.effects.compile }));

import * as actions from "@/app/(dashboard)/schemas/[domainSlug]/[productSlug]/[entityId]/actions";
import * as versionActions from "@/app/(dashboard)/schemas/[domainSlug]/[productSlug]/[entityId]/version-actions";

const GENERIC_FORBIDDEN = { error: "You do not have permission to do this", code: "FORBIDDEN" };
const NOT_AUTHENTICATED = { error: "Not authenticated", code: "UNAUTHORIZED" };

const place = (tenantId: string, domainId: string | null = "dom-a") => ({ tenantId, domainId, productId: domainId ? "prod-a" : null, product: domainId ? { domainId } : null });
const entityRow = (tenantId: string, domainId: string | null = "dom-a") => ({
  id: "ent-1", name: "Order", description: "", status: "DRAFT", version: 1, slug: "order", typespecSource: "model Order {}", hasUnpublishedChanges: false,
  metadata: { schemaVersions: { bigquery: [{ version: 1, status: "published", output: "x", generatedAt: "2026-01-01", entityVersion: 1 }] } },
  domain: null, ...place(tenantId, domainId),
});

/** One operation: how to call it, and the action(s) of the table it needs (all are required: the role must reach the highest). */
type Op = { label: string; call: () => Promise<unknown>; needs: ActionId[]; subject?: "entity" | "field" | "tenant"; refusalCode?: string };

const REF_INPUT = { sourceType: "string", targetFormat: "avro", mappedType: "STRING", justification: "because", isLossy: false };
const OPS: Op[] = [
  { label: "addFieldAction", call: () => actions.addFieldAction("ent-1", "email", "string"), needs: ["entity.write"] },
  { label: "updateFieldAction", call: () => actions.updateFieldAction("fld-1", { description: "x" }), needs: ["entity.write"], subject: "field" },
  { label: "deleteFieldAction", call: () => actions.deleteFieldAction("fld-1"), needs: ["entity.write"], subject: "field" },
  { label: "updateEntityStatusAction", call: () => actions.updateEntityStatusAction("ent-1", "ACTIVE"), needs: ["entity.lifecycle"] },
  { label: "updateEntityRelationshipsAction", call: () => actions.updateEntityRelationshipsAction("ent-1", []), needs: ["entity.write"] },
  { label: "emitEntityAction", call: () => actions.emitEntityAction("ent-1"), needs: ["entity.read"] },
  { label: "createTypeMappingOverrideAction (per-entity)", call: () => actions.createTypeMappingOverrideAction({ ...REF_INPUT, scope: "per-entity", entityId: "ent-1" }), needs: ["typemapping.entity"] },
  { label: "acknowledgeLossyMappingAction", call: () => actions.acknowledgeLossyMappingAction({ entityId: "ent-1", sourceType: "string", targetFormat: "avro" }), needs: ["typemapping.entity"] },
  { label: "getVersionHistoryAction", call: () => actions.getVersionHistoryAction("ent-1"), needs: ["entity.read"] },
  { label: "compareVersionsAction", call: () => actions.compareVersionsAction("ent-1", 1, 2), needs: ["entity.read"] },
  { label: "getChangeHistoryAction", call: () => actions.getChangeHistoryAction("ent-1"), needs: ["entity.read"] },
  { label: "generateTypeSpecPreviewAction", call: () => actions.generateTypeSpecPreviewAction("ent-1"), needs: ["entity.read"] },
  { label: "applyTypeSpecAction", call: () => actions.applyTypeSpecAction("ent-1", []), needs: ["entity.write"] },
  { label: "getSchemaVersionsAction", call: () => actions.getSchemaVersionsAction("ent-1"), needs: ["entity.read"] },
  { label: "getSchemaTargetFieldMappingsAction", call: () => actions.getSchemaTargetFieldMappingsAction("ent-1", "bigquery"), needs: ["entity.read"] },
  { label: "saveSchemaFieldTypeOverrideAction", call: () => actions.saveSchemaFieldTypeOverrideAction({ entityId: "ent-1", target: "bigquery", fieldId: "fld-1", mappedType: "STRING" }), needs: ["typemapping.entity"] },
  { label: "getSchemaGenerationRequirementsAction", call: () => actions.getSchemaGenerationRequirementsAction("ent-1", "bigquery"), needs: ["entity.read"] },
  { label: "setEntityPrimaryKeyAction", call: () => actions.setEntityPrimaryKeyAction("ent-1", ["email"]), needs: ["entity.write"] },
  { label: "setFieldReferenceAction", call: async () => unwrapResult(await actions.setFieldReferenceAction("ent-1", "fld-1", { entityId: "ent-2" })), needs: ["entity.write"] },
  { label: "generateSchemaAction", call: () => actions.generateSchemaAction("ent-1", "bigquery"), needs: ["schema.generate"] },
  { label: "publishSchemaAction", call: () => actions.publishSchemaAction("ent-1", "bigquery", 1), needs: ["entity.publish"] },
  { label: "deploySchemaAction", call: () => actions.deploySchemaAction("ent-1", "bigquery", 1), needs: ["deploy.run"] },
  { label: "updateEntityMetadataAction (tags)", call: () => actions.updateEntityMetadataAction("ent-1", { tags: ["a"] }), needs: ["entity.write"] },
  { label: "updateEntityMetadataAction (retention policy)", call: () => actions.updateEntityMetadataAction("ent-1", { retentionPolicy: {} }), needs: ["entity.write", "retention.write"] },
  { label: "updateEntityMetadataAction (schema versions)", call: () => actions.updateEntityMetadataAction("ent-1", { schemaVersions: {} }), needs: ["entity.write", "entity.publish", "deploy.run"] },
  { label: "updateEntityMetadataAction (deprecation)", call: () => actions.updateEntityMetadataAction("ent-1", { deprecation: { deprecated: true } }), needs: ["entity.write", "entity.lifecycle"] },
  { label: "updateEntityDescriptionAction", call: () => actions.updateEntityDescriptionAction("ent-1", "text"), needs: ["entity.write"] },
  { label: "getEntityDeploymentStatusAction", call: () => actions.getEntityDeploymentStatusAction("ent-1"), needs: ["deploy.read"] },
  { label: "markEntityDeployedAction", call: () => actions.markEntityDeployedAction("ent-1", "ent-1:bigquery", "prod"), needs: ["deploy.run"] },
  { label: "checkTargetDriftAction", call: () => actions.checkTargetDriftAction("ent-1", "ent-1:bigquery"), needs: ["deploy.read"] },
  { label: "getTypeSpecSourceAction", call: () => actions.getTypeSpecSourceAction("ent-1"), needs: ["entity.read"] },
  { label: "compileAndApplyTypeSpecSourceAction", call: () => actions.compileAndApplyTypeSpecSourceAction("ent-1", "model Order {}"), needs: ["entity.write"] },
  { label: "getPublishPreviewAction", call: () => versionActions.getPublishPreviewAction("ent-1"), needs: ["entity.read"] },
  { label: "publishEntityAction", call: () => versionActions.publishEntityAction("ent-1", {}), needs: ["entity.publish"] },
  { label: "listEntityVersionsAction", call: () => versionActions.listEntityVersionsAction("ent-1"), needs: ["entity.read"] },
];

/**
 * The answers of these actions differ in shape (a Result, `{ error, code }`, `{ error }` with extra fields such as `versions: []`, the apply
 * results `{ added, ..., error }`): read every refusal as `{ error, code }`, the code taken from the text when the shape has none.
 */
function normalize(answer: unknown): unknown {
  const a = answer as { error?: unknown; code?: unknown } | null;
  if (!a || typeof a.error !== "string") return answer;
  const code =
    typeof a.code === "string"
      ? a.code
      : a.error === "Not authenticated"
        ? "UNAUTHORIZED"
        : /not found$/i.test(a.error)
          ? "NOT_FOUND"
          : a.error === "You do not have permission to do this"
            ? "FORBIDDEN"
            : undefined;
  return code ? { error: a.error, code } : { error: a.error };
}

const normalizeAnswer = (answer: unknown) => normalize(answer);

/** `setFieldReferenceAction` answers a Result; the rest answer `{ error, code }`: read both as one shape. */
function unwrapResult(result: { success: boolean; error?: { code: string; message: string } }): unknown {
  return result.success ? { success: true } : { error: result.error!.message, code: result.error!.code };
}

for (const op of OPS) {
  const raw = op.call;
  op.call = async () => normalize(await raw());
}

/** What a refused caller must never reach: every write, every service, every read beyond the guard's own place look-up. */
const EFFECTS = Object.values(h.effects);

/** The lowest rung that holds every action `needs` (the table is the source). */
function minimumRole(needs: ActionId[]): Role {
  return ROLE_HIERARCHY.find((role) => needs.every((id) => roleAtLeast(role, ACTIONS[id].minRole as Role))) as Role;
}

beforeEach(() => {
  vi.clearAllMocks();
  vi.spyOn(console, "error").mockImplementation(() => undefined);
  signInAs(tenantMember("ADMIN", T));
  h.activeTenant.mockResolvedValue(T);
  h.entityFindUnique.mockResolvedValue(entityRow(T));
  h.fieldFindUnique.mockImplementation(async (args: { select?: { entity?: unknown } }) =>
    args.select?.entity
      ? { id: "fld-1", entityId: "ent-1", name: "email", type: "string", decorators: {}, entity: place(T) }
      : { id: "fld-1", entityId: "ent-1", name: "email", slug: "email", type: "string", decorators: {} }
  );
  for (const effect of EFFECTS) effect.mockResolvedValue(undefined);
  h.effects.transaction.mockImplementation(async (ops: unknown[]) => Promise.all(ops));
  h.effects.updateEntity.mockResolvedValue({ success: true, data: { id: "ent-1" } });
});

const reached = () => EFFECTS.filter((effect) => effect.mock.calls.length > 0);

describe.each(OPS)("$label", (op) => {
  it("answers nobody signed in 'Not authenticated' and reaches nothing", async () => {
    signedOut();
    expect(await op.call()).toEqual(NOT_AUTHENTICATED);
    expect(reached()).toHaveLength(0);
    expect(h.entityFindUnique).not.toHaveBeenCalled();
  });

  it("answers a user with no role at all as a missing entity and reaches nothing", async () => {
    signInAs(roleless());
    const answer = (await op.call()) as { error: string; code: string };
    expect(answer.code).toBe("NOT_FOUND");
    expect(answer.error).toMatch(/not found/i);
    expect(reached()).toHaveLength(0);
  });

  it(`is allowed from ${minimumRole(op.needs)} up and refused (generic, nothing reached) below it`, async () => {
    const lowest = minimumRole(op.needs);
    for (const role of ROLE_HIERARCHY) {
      vi.clearAllMocks();
      signInAs(tenantMember(role, T));
      h.activeTenant.mockResolvedValue(T);
      h.entityFindUnique.mockResolvedValue(entityRow(T));
      const answer = (await op.call()) as { code?: string; error?: string };
      if (roleAtLeast(role, lowest)) {
        // The guard let the call through: whatever the action does next, it is not a refusal.
        expect(answer.code, `${role}`).not.toBe("FORBIDDEN");
        expect(answer.code, `${role}`).not.toBe("UNAUTHORIZED");
        expect(answer, `${role}`).not.toEqual({ error: "Entity not found", code: "NOT_FOUND" });
      } else {
        expect(answer, `${role}`).toEqual(GENERIC_FORBIDDEN);
        expect(reached(), `${role} reached an effect`).toHaveLength(0);
      }
    }
  });

  it.skipIf(op.subject === "tenant")("answers an entity of ANOTHER tenant exactly as a missing one, even for an administrator of both tenants, and reaches nothing", async () => {
    signInAs(principalOf([assign.tenant("ADMIN", T), assign.tenant("ADMIN", OTHER)]));
    h.entityFindUnique.mockResolvedValue(entityRow(OTHER));
    h.fieldFindUnique.mockImplementation(async () => ({ id: "fld-1", entityId: "ent-1", entity: place(OTHER) }));
    const foreign = await op.call();
    h.entityFindUnique.mockResolvedValue(null);
    h.fieldFindUnique.mockResolvedValue(null);
    const missing = await op.call();
    expect(JSON.stringify(foreign)).toBe(JSON.stringify(missing));
    expect((foreign as { code?: string }).code).toBe("NOT_FOUND");
    expect(reached()).toHaveLength(0);
  });

  it("follows the ACTIVE tenant: a role in the entity's tenant does not help while another tenant is in view", async () => {
    signInAs(principalOf([assign.tenant("ADMIN", T), assign.tenant("ADMIN", OTHER)]));
    h.activeTenant.mockResolvedValue(OTHER);
    const answer = (await op.call()) as { code?: string };
    if (op.subject !== "tenant") expect(answer.code).toBe("NOT_FOUND");
    if (op.subject === "tenant") expect(answer.code).not.toBe("FORBIDDEN"); // judged over the tenant in view (OTHER), where they are an administrator
    if (op.subject !== "tenant") expect(reached()).toHaveLength(0);
  });

  if (op.subject !== "tenant") {
    it("a domain-scoped role takes effect: the right domain is judged by the role, a sibling domain and a tenant-level entity read as missing", async () => {
      const lowest = minimumRole(op.needs);
      // An ADMIN of dom-a covers every action there is, so it is allowed on dom-a's entity ...
      signInAs(principalOf([assign.domain("ADMIN", T, "dom-a")]));
      const own = (await op.call()) as { code?: string };
      expect(own.code).not.toBe("FORBIDDEN");
      expect(own.code).not.toBe("NOT_FOUND");
      // ... a domain-scoped holder of the LOWEST role it needs is allowed too, and one rung below is refused (generic)
      signInAs(principalOf([assign.domain(lowest, T, "dom-a")]));
      expect(((await op.call()) as { code?: string }).code).not.toBe("FORBIDDEN");
      const below = ROLE_HIERARCHY[ROLE_HIERARCHY.indexOf(lowest) - 1];
      if (below) {
        signInAs(principalOf([assign.domain(below, T, "dom-a")]));
        expect(await op.call()).toEqual(GENERIC_FORBIDDEN);
      }
      // ... the same role on the SIBLING domain does not reach the entity: the answer of a missing entity
      vi.clearAllMocks();
      signInAs(principalOf([assign.domain("ADMIN", T, "dom-b")]));
      const sibling = (await op.call()) as { code?: string; error?: string };
      expect(sibling.code).toBe("NOT_FOUND");
      // ... and neither does it reach a TENANT-level entity (no domain, no product)
      h.entityFindUnique.mockResolvedValue(entityRow(T, null));
      h.fieldFindUnique.mockImplementation(async () => ({ id: "fld-1", entityId: "ent-1", entity: place(T, null) }));
      const tenantLevel = (await op.call()) as { code?: string };
      expect(tenantLevel.code).toBe("NOT_FOUND");
      expect(reached()).toHaveLength(0);
    });
  }
});

describe("updateEntityMetadataAction: which keys, and who", () => {
  const patch = (metadata: Record<string, unknown>) => actions.updateEntityMetadataAction("ent-1", metadata);

  it("an AUTHOR may set tags, owner and custom properties", async () => {
    signInAs(tenantMember("AUTHOR", T));
    for (const metadata of [{ tags: ["a"] }, { owner: "team" }, { custom: { x: 1 } }, { tags: [], owner: null }]) {
      expect(await patch(metadata), JSON.stringify(metadata)).toEqual({ success: true });
    }
  });

  it("an AUTHOR cannot publish, deploy, deprecate or change retention through a metadata patch (each key needs the action that changes that state): nothing is written", async () => {
    signInAs(tenantMember("AUTHOR", T));
    for (const metadata of [{ schemaVersions: { bigquery: [] } }, { retentionPolicy: { days: 1 } }, { deprecation: { deprecated: true } }, { tags: ["ok"], schemaVersions: {} }]) {
      expect(await patch(metadata), JSON.stringify(metadata)).toEqual(GENERIC_FORBIDDEN);
    }
    expect(h.effects.entityUpdate).not.toHaveBeenCalled();
    expect(h.effects.auditCreate).not.toHaveBeenCalled();
  });

  it("a STEWARD may set every listed key", async () => {
    signInAs(tenantMember("STEWARD", T));
    for (const metadata of [{ schemaVersions: {} }, { retentionPolicy: {} }, { deprecation: { deprecated: true } }, { schemaTargetTypeOverrides: {} }]) {
      expect(await patch(metadata), JSON.stringify(metadata)).toEqual({ success: true });
    }
  });

  it("refuses a key that is not listed (server-owned bookkeeping), for everybody, and writes nothing", async () => {
    for (const principal of [tenantMember("ADMIN", T), principalOf([assign.global()])]) {
      signInAs(principal);
      for (const key of ["sourceStale", "importedFrom", "sourceFormat", "hasUnpublishedChanges", "__proto__x", "constructor", "relationships"]) {
        const answer = await patch({ [key]: 1 });
        expect(answer, key).toMatchObject({ code: "VALIDATION_ERROR" });
      }
    }
    expect(h.effects.entityUpdate).not.toHaveBeenCalled();
  });

  it("a refused patch is refused before the entity is read", async () => {
    signInAs(tenantMember("AUTHOR", T));
    h.entityFindUnique.mockClear();
    await patch({ unknown: 1 });
    expect(h.entityFindUnique).not.toHaveBeenCalled();
  });
});

describe("createTypeMappingOverrideAction (global): a platform administrator's act, because the override table has no tenant column", () => {
  const global = () => actions.createTypeMappingOverrideAction({ ...REF_INPUT, scope: "global", entityId: "ent-1" });

  it("answers nobody signed in 'Not authenticated' and reaches nothing", async () => {
    signedOut();
    expect(normalizeAnswer(await global())).toEqual(NOT_AUTHENTICATED);
    expect(reached()).toHaveLength(0);
  });

  it("refuses EVERY tenant-scoped role, an administrator of the tenant and of several tenants included, with the one generic text", async () => {
    for (const role of ROLE_HIERARCHY) {
      signInAs(tenantMember(role, T));
      expect(normalizeAnswer(await global()), role).toEqual(GENERIC_FORBIDDEN);
    }
    signInAs(principalOf([assign.tenant("ADMIN", T), assign.tenant("ADMIN", OTHER), assign.domain("ADMIN", T, "dom-a")]));
    expect(normalizeAnswer(await global())).toEqual(GENERIC_FORBIDDEN);
    signInAs(roleless());
    expect(normalizeAnswer(await global())).toEqual(GENERIC_FORBIDDEN);
    expect(reached()).toHaveLength(0);
  });

  it("lets a platform administrator through", async () => {
    signInAs(principalOf([assign.global()]));
    expect(normalizeAnswer(await global())).not.toMatchObject({ code: "FORBIDDEN" });
    expect(normalizeAnswer(await global())).not.toMatchObject({ code: "UNAUTHORIZED" });
  });
});

describe("who is nobody", () => {
  it("a disabled or unknown user (no principal) is refused by every operation as not authenticated, whatever the session says", async () => {
    principalModule.getPrincipal.mockResolvedValue(null);
    for (const op of OPS) expect(await op.call(), op.label).toEqual(NOT_AUTHENTICATED);
    expect(reached()).toHaveLength(0);
  });
});
