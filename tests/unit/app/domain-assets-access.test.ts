// @vitest-environment node
/**
 * Access control over the domain assets (`[domainSlug]/actions.ts`): the entity-creating paths, model fields, shared enums, scalars and unions,
 * API services and operations, and the bulk imports. Every action asks the policy BEFORE it reads or writes anything. The REAL guard runs here;
 * what is replaced is the database and the write services behind the actions, which are the "effects" a refused caller must never reach.
 *
 * Reading the table: creating an entity is `entity.write`, every other asset edit is `asset.write`, a bulk import is `import.run` (all three
 * are an author's act, judged over the domain or product the asset lives in). For each operation: nobody signed in, a user with no role, every
 * role of the ladder, a resource of another tenant (also for a user who holds a role there: it is not the tenant in view), a domain-scoped author
 * on the right and on the wrong domain.
 */
import { beforeEach, describe, expect, it, vi } from "vitest";
import { assign, principalModule, principalOf, roleless, signInAs, signedOut, tenantMember } from "../../helpers/access-mocks";
import { ROLE_HIERARCHY } from "@/types/schemas/rbac";
import { roleAtLeast } from "@/lib/access";

const T = "tenant-1";
const OTHER = "tenant-2";

const h = vi.hoisted(() => {
  const fn = () => vi.fn();
  return {
    activeTenant: fn(),
    revalidatePath: fn(),
    lookups: {
      domain: fn(), product: fn(), tenant: fn(), entity: fn(), model: fn(), modelField: fn(), sharedEnum: fn(), customScalar: fn(), unionType: fn(),
      service: fn(), operation: fn(),
    },
    effects: {
      auditCreate: fn(), transaction: fn(), createInScope: fn(), deleteEntityGuarded: fn(), ensureDefaultProduct: fn(),
      modelFieldCreate: fn(), modelFieldUpdate: fn(), modelFieldDelete: fn(), modelFieldFindFirst: fn(), enumUpdate: fn(), enumDelete: fn(),
      scalarUpdate: fn(), scalarDelete: fn(), unionUpdate: fn(), unionDelete: fn(), serviceFindFirst: fn(), serviceDelete: fn(),
      operationCreate: fn(), operationUpdate: fn(), operationDelete: fn(), paramDeleteMany: fn(), responseDeleteMany: fn(),
      modelFindFirst: fn(), entityCreate: fn(), executeRaw: fn(),
    },
  };
});

vi.mock("next/cache", () => ({ revalidatePath: h.revalidatePath }));
vi.mock("@/lib/auth", () => ({ auth: vi.fn() }));
vi.mock("@/lib/access/principal", async () => (await import("../../helpers/access-mocks")).principalModule);
vi.mock("@/lib/active-tenant", () => ({ getActiveTenantId: h.activeTenant }));
vi.mock("@/lib/db", () => ({
  prisma: {
    domain: { findUnique: h.lookups.domain },
    product: { findUnique: h.lookups.product },
    tenant: { findUnique: h.lookups.tenant },
    entity: { findUnique: h.lookups.entity, create: h.effects.entityCreate },
    modelDefinition: { findUnique: h.lookups.model, findFirst: h.effects.modelFindFirst },
    modelFieldDefinition: { findUnique: h.lookups.modelField, create: h.effects.modelFieldCreate, update: h.effects.modelFieldUpdate, delete: h.effects.modelFieldDelete, findFirst: h.effects.modelFieldFindFirst },
    sharedEnum: { findUnique: h.lookups.sharedEnum, update: h.effects.enumUpdate, delete: h.effects.enumDelete },
    customScalar: { findUnique: h.lookups.customScalar, update: h.effects.scalarUpdate, delete: h.effects.scalarDelete },
    unionType: { findUnique: h.lookups.unionType, update: h.effects.unionUpdate, delete: h.effects.unionDelete },
    serviceDefinition: { findUnique: h.lookups.service, findFirst: h.effects.serviceFindFirst, delete: h.effects.serviceDelete },
    operation: { findUnique: h.lookups.operation, create: h.effects.operationCreate, update: h.effects.operationUpdate, delete: h.effects.operationDelete },
    operationParameter: { deleteMany: h.effects.paramDeleteMany },
    operationResponse: { deleteMany: h.effects.responseDeleteMany },
    auditLog: { create: h.effects.auditCreate },
    $transaction: h.effects.transaction,
    $executeRaw: h.effects.executeRaw,
  },
}));
vi.mock("@/services/scoped-create.service", async (importOriginal) => ({ ...(await importOriginal<typeof import("@/services/scoped-create.service")>()), createInScope: h.effects.createInScope }));
vi.mock("@/services/events/entity-pin-usage", () => ({ deleteEntityGuarded: h.effects.deleteEntityGuarded, entityDeleteFailure: vi.fn() }));
vi.mock("@/lib/org-defaults", () => ({ ensureDefaultProductId: h.effects.ensureDefaultProduct }));

import * as actions from "@/app/(dashboard)/schemas/[domainSlug]/actions";

const GENERIC_FORBIDDEN = { error: "You do not have permission to do this", code: "FORBIDDEN" };

const entityLike = (tenantId: string, domainId = "dom-a") => ({ tenantId, domainId, productId: "prod-a", product: { domainId } });
/** Where every addressed row lives. */
function place(tenantId: string, domainId = "dom-a") {
  h.lookups.domain.mockImplementation(async () => ({ id: domainId, tenantId }));
  h.lookups.product.mockResolvedValue({ id: "prod-a", domainId, domain: { tenantId } });
  h.lookups.tenant.mockResolvedValue({ id: tenantId });
  h.lookups.entity.mockResolvedValue({ id: "ent-1", name: "Order", ...entityLike(tenantId, domainId) });
  h.lookups.model.mockResolvedValue({ domainId, domain: { tenantId }, _count: { fields: 0 } });
  h.lookups.modelField.mockResolvedValue({ name: "x", model: { domainId, domain: { tenantId } } });
  for (const kind of ["sharedEnum", "customScalar", "unionType", "service"] as const) h.lookups[kind].mockResolvedValue(entityLike(tenantId, domainId));
  h.lookups.operation.mockResolvedValue({ service: entityLike(tenantId, domainId) });
}

type Op = { label: string; call: () => Promise<unknown>; needs: "entity.write" | "asset.write" | "import.run" };

const form = (name = "Order") => {
  const fd = new FormData();
  fd.set("name", name);
  return fd;
};
const OP_DETAILS = { name: "getOrder", httpMethod: "GET", httpPath: "/orders", parameters: [], responses: [] };
const IMPORT = { domainId: "dom-a", models: [], services: [], decoratorDefinitions: [], entities: [], sourceFormat: "typespec" } as never;

const OPS: Op[] = [
  { label: "createEntityWithFieldsAction", call: () => actions.createEntityWithFieldsAction("dom-a", { name: "Order", description: "", fields: [] }), needs: "entity.write" },
  { label: "createEntityWithFieldsAction (into a product)", call: () => actions.createEntityWithFieldsAction("dom-a", { name: "Order", description: "", fields: [] }, "prod-a"), needs: "entity.write" },
  { label: "createEntityAction", call: () => actions.createEntityAction("dom-a", form()), needs: "entity.write" },
  { label: "deleteEntityAction", call: () => actions.deleteEntityAction("ent-1"), needs: "entity.write" },
  { label: "addModelFieldAction", call: () => actions.addModelFieldAction("model-1", { name: "x", type: "string" }), needs: "asset.write" },
  { label: "updateModelFieldAction", call: () => actions.updateModelFieldAction("mf-1", { description: "x" }), needs: "asset.write" },
  { label: "deleteModelFieldAction", call: () => actions.deleteModelFieldAction("mf-1"), needs: "asset.write" },
  { label: "createSharedEnumAction", call: () => actions.createSharedEnumAction("dom-a", { name: "E", values: ["a"] }), needs: "asset.write" },
  { label: "updateSharedEnumAction", call: () => actions.updateSharedEnumAction("enum-1", { description: "x" }), needs: "asset.write" },
  { label: "deleteSharedEnumAction", call: () => actions.deleteSharedEnumAction("enum-1"), needs: "asset.write" },
  { label: "createCustomScalarAction", call: () => actions.createCustomScalarAction("dom-a", { name: "S", baseType: "string" }), needs: "asset.write" },
  { label: "updateCustomScalarAction", call: () => actions.updateCustomScalarAction("scalar-1", { description: "x" }), needs: "asset.write" },
  { label: "deleteCustomScalarAction", call: () => actions.deleteCustomScalarAction("scalar-1"), needs: "asset.write" },
  { label: "createUnionTypeAction", call: () => actions.createUnionTypeAction("dom-a", { name: "U", memberTypes: ["a"] }), needs: "asset.write" },
  { label: "updateUnionTypeAction", call: () => actions.updateUnionTypeAction("union-1", { description: "x" }), needs: "asset.write" },
  { label: "deleteUnionTypeAction", call: () => actions.deleteUnionTypeAction("union-1"), needs: "asset.write" },
  { label: "createServiceAction", call: () => actions.createServiceAction("dom-a", { name: "Api", scope: "DOMAIN" }), needs: "asset.write" },
  { label: "createServiceAction (for an entity)", call: () => actions.createServiceAction("dom-a", { name: "Api", scope: "ENTITY", entityId: "ent-1" }), needs: "asset.write" },
  { label: "getOrCreateEntityServiceAction", call: () => actions.getOrCreateEntityServiceAction("dom-a", "ent-1", "Order"), needs: "asset.write" },
  { label: "deleteServiceAction", call: () => actions.deleteServiceAction("svc-1"), needs: "asset.write" },
  { label: "createOperationAction", call: () => actions.createOperationAction("svc-1", OP_DETAILS), needs: "asset.write" },
  { label: "updateOperationAction", call: () => actions.updateOperationAction("op-1", { description: "x" }), needs: "asset.write" },
  { label: "replaceOperationDetailsAction", call: () => actions.replaceOperationDetailsAction("op-1", OP_DETAILS), needs: "asset.write" },
  { label: "deleteOperationAction", call: () => actions.deleteOperationAction("op-1"), needs: "asset.write" },
  { label: "createDomainAssetsFromImportAction", call: () => actions.createDomainAssetsFromImportAction(IMPORT), needs: "import.run" },
  { label: "createEntitiesFromImportAction", call: () => actions.createEntitiesFromImportAction({ domainId: "dom-a", entities: [] } as never), needs: "import.run" },
];

/**
 * The answers differ in shape (`{ error, code }`, `{ error }`, the import's `{ errors: [...] }`): read every refusal as `{ error, code }`, the
 * code taken from the text when the shape has none.
 */
function normalize(answer: unknown): unknown {
  const a = answer as { error?: unknown; errors?: unknown; code?: unknown } | null;
  const error = typeof a?.error === "string" ? a.error : Array.isArray(a?.errors) && typeof a.errors[0] === "string" ? (a.errors[0] as string) : undefined;
  if (error === undefined) return answer;
  const code =
    typeof a?.code === "string"
      ? a.code
      : error === "Not authenticated" || error === "You must be logged in"
        ? "UNAUTHORIZED"
        : /not found$/i.test(error)
          ? "NOT_FOUND"
          : error === GENERIC_FORBIDDEN.error
            ? "FORBIDDEN"
            : undefined;
  return code ? { error, code } : { error };
}
for (const op of OPS) {
  const raw = op.call;
  op.call = async () => normalize((await raw()) ?? {});
}

const EFFECTS = Object.values(h.effects);
const reached = () => EFFECTS.filter((effect) => effect.mock.calls.length > 0);

beforeEach(() => {
  vi.clearAllMocks();
  vi.spyOn(console, "error").mockImplementation(() => undefined);
  signInAs(tenantMember("ADMIN", T));
  h.activeTenant.mockResolvedValue(T);
  place(T);
  for (const effect of EFFECTS) effect.mockResolvedValue(undefined);
  h.effects.transaction.mockImplementation(async (ops: unknown) => (Array.isArray(ops) ? Promise.all(ops) : undefined));
  h.effects.createInScope.mockResolvedValue({ success: true, data: { id: "created" } });
  h.effects.ensureDefaultProduct.mockResolvedValue("prod-a");
});

describe.each(OPS)("$label", (op) => {
  it("answers nobody signed in 'Not authenticated' / 'You must be logged in' and reaches nothing", async () => {
    signedOut();
    const answer = (await op.call()) as { error: string; code: string };
    expect(answer.code).toBe("UNAUTHORIZED");
    expect(reached()).toHaveLength(0);
    for (const lookup of Object.values(h.lookups)) expect(lookup).not.toHaveBeenCalled();
  });

  it("answers a user with no role at all as a missing resource and reaches nothing", async () => {
    signInAs(roleless());
    const answer = (await op.call()) as { code?: string; error: string };
    expect(answer.code).toBe("NOT_FOUND");
    expect(reached()).toHaveLength(0);
  });

  it("is allowed from AUTHOR up and refused (generic, nothing reached) below it", async () => {
    for (const role of ROLE_HIERARCHY) {
      vi.clearAllMocks();
      signInAs(tenantMember(role, T));
      h.activeTenant.mockResolvedValue(T);
      place(T);
      const answer = (await op.call()) as { code?: string; error?: string };
      if (roleAtLeast(role, "AUTHOR")) {
        expect(answer.code, role).not.toBe("FORBIDDEN");
        expect(answer.code, role).not.toBe("UNAUTHORIZED");
        expect(answer.code, role).not.toBe("NOT_FOUND");
      } else {
        expect(answer, role).toEqual(GENERIC_FORBIDDEN);
        expect(reached(), `${role} reached an effect`).toHaveLength(0);
      }
    }
  });

  it("answers a resource of ANOTHER tenant exactly as a missing one, even for an administrator of both tenants, and reaches nothing", async () => {
    signInAs(principalOf([assign.tenant("ADMIN", T), assign.tenant("ADMIN", OTHER)]));
    place(OTHER);
    const foreign = await op.call();
    for (const lookup of Object.values(h.lookups)) lookup.mockResolvedValue(null);
    const missing = await op.call();
    expect(JSON.stringify(foreign)).toBe(JSON.stringify(missing));
    expect((foreign as { code?: string }).code).toBe("NOT_FOUND");
    expect(reached()).toHaveLength(0);
  });

  it("follows the ACTIVE tenant: a role in the resource's tenant does not help while another tenant is in view", async () => {
    signInAs(principalOf([assign.tenant("ADMIN", T), assign.tenant("ADMIN", OTHER)]));
    h.activeTenant.mockResolvedValue(OTHER);
    expect(((await op.call()) as { code?: string }).code).toBe("NOT_FOUND");
    expect(reached()).toHaveLength(0);
  });

  it("a domain-scoped role takes effect: an author of the domain may, a viewer of it may not, an author of a sibling domain reads it as missing", async () => {
    signInAs(principalOf([assign.domain("AUTHOR", T, "dom-a")]));
    const own = (await op.call()) as { code?: string };
    expect(own.code).not.toBe("FORBIDDEN");
    expect(own.code).not.toBe("NOT_FOUND");
    signInAs(principalOf([assign.domain("VIEWER", T, "dom-a")]));
    expect(await op.call()).toEqual(GENERIC_FORBIDDEN);
    vi.clearAllMocks();
    signInAs(principalOf([assign.domain("ADMIN", T, "dom-b")]));
    expect(((await op.call()) as { code?: string }).code).toBe("NOT_FOUND");
    expect(reached()).toHaveLength(0);
  });
});

describe("a product-scoped author", () => {
  it("creates an entity in THEIR product and not in a sibling product of the same domain", async () => {
    signInAs(principalOf([assign.product("AUTHOR", T, "dom-a", "prod-a")]));
    const own = await actions.createEntityWithFieldsAction("dom-a", { name: "Order", description: "", fields: [] }, "prod-a");
    expect(own).not.toMatchObject({ code: "FORBIDDEN" });
    expect(own).not.toMatchObject({ code: "NOT_FOUND" });
    // The product the caller names is another one of the same domain: their role does not reach it.
    vi.clearAllMocks();
    const sibling = await actions.createEntityWithFieldsAction("dom-a", { name: "Order", description: "", fields: [] }, "prod-b");
    expect(sibling).toMatchObject({ code: "NOT_FOUND" });
    expect(h.effects.createInScope).not.toHaveBeenCalled();
  });
});

describe("who is nobody", () => {
  it("a disabled or unknown user (no principal) is refused by every operation as not authenticated", async () => {
    principalModule.getPrincipal.mockResolvedValue(null);
    for (const op of OPS) expect(((await op.call()) as { code?: string }).code, op.label).toBe("UNAUTHORIZED");
    expect(reached()).toHaveLength(0);
  });
});
