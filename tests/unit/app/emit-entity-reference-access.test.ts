// @vitest-environment node
/**
 * KD-045 on the entity page: the emission preview (`emitEntityAction`) and a schema generation (`generateSchemaAction`) build the entity together
 * with everything it references, and only what the caller's roles cover. The REAL guard, emission service and reference closure run here; the
 * session, the database and the emitters are stand-ins. A domain-scoped author whose entity references an entity of another domain is refused with
 * REFERENCE_NOT_READABLE (the toast and status of every other closure refusal: `{ error, code }` for a generation, `result.refusal` and INVALID
 * closure targets for the preview), before any row of the other entity is read or any file built; the same domain and the wider roles are unaffected.
 */
import { beforeEach, describe, expect, it, vi } from "vitest";
import { assign, resetSessionPrincipal, setSessionPrincipal } from "../../helpers/access-mocks";
import type { Assignment } from "@/lib/access";

const T = "tenant-1";

const h = vi.hoisted(() => ({
  emitClosure: vi.fn(),
  emitStandalone: vi.fn(),
  prisma: {
    entity: { findUnique: vi.fn(), findMany: vi.fn(), update: vi.fn() },
    field: { findMany: vi.fn() },
    entityVersion: { findUnique: vi.fn() },
  },
}));

vi.mock("server-only", () => ({}));
vi.mock("@/lib/db", () => ({ prisma: h.prisma }));
vi.mock("@/lib/access/principal", async () => (await import("../../helpers/access-mocks")).sessionPrincipalModule);
vi.mock("@/lib/auth", () => ({ auth: vi.fn().mockResolvedValue({ user: { id: "user-1" } }) }));
vi.mock("next/cache", () => ({ revalidatePath: vi.fn() }));
vi.mock("@/lib/active-tenant", () => ({ getActiveTenantId: vi.fn().mockResolvedValue("tenant-1") }));
vi.mock("@/lib/audit", async (importOriginal) => ({
  ...(await importOriginal<typeof import("@/lib/audit")>()),
  withAudit: async ({ fn }: { fn: () => Promise<unknown> }) => fn(),
  recordAuditFailure: vi.fn(),
}));
vi.mock("@/lib/typespec-official/closure-emit", async (importOriginal) => ({
  ...(await importOriginal<typeof import("@/lib/typespec-official/closure-emit")>()),
  emitClosure: h.emitClosure,
}));
vi.mock("@/lib/typespec-official/emitter.service", async (importOriginal) => ({
  ...(await importOriginal<typeof import("@/lib/typespec-official/emitter.service")>()),
  emitOfficialTypeSpecTargetFromData: h.emitStandalone,
}));

import { emitEntityAction, generateSchemaAction } from "@/app/(dashboard)/schemas/[domainSlug]/[productSlug]/[entityId]/actions";

type Row = { id: string; name: string; domain: string; product: string; references?: string };
const ROWS: Row[] = [
  { id: "order", name: "Order", domain: "sales", product: "orders", references: "customer" },
  { id: "customer", name: "Customer", domain: "finance", product: "ledger" },
  { id: "invoice", name: "Invoice", domain: "sales", product: "orders", references: "line" },
  { id: "line", name: "InvoiceLine", domain: "sales", product: "orders" },
];
const fieldsOf = (r: Row) =>
  r.references
    ? [{
        id: `${r.id}-f`, entityId: r.id, name: `${r.references}Ref`, type: "reference", precision: null, scale: null, nullable: true, isKey: false, fieldNumber: null,
        description: "", classification: null, aliases: [], sortOrder: 0,
        decorators: { referencedEntityId: r.references, referencedEntityName: ROWS.find((x) => x.id === r.references)?.name },
      }]
    : [];
const entityRow = (r: Row) => ({
  id: r.id, tenantId: T, name: r.name, description: "", status: "DRAFT", version: 1, metadata: null, latestVersionId: null,
  domainId: `d-${r.domain}`, productId: `p-${r.product}`, domain: { id: `d-${r.domain}`, name: r.domain, slug: r.domain },
  product: { name: r.product, domainId: `d-${r.domain}` }, fields: fieldsOf(r),
});

const touched = { fieldsOf: [] as string[], metadataOf: [] as string[] };

beforeEach(() => {
  vi.clearAllMocks();
  resetSessionPrincipal();
  touched.fieldsOf = [];
  touched.metadataOf = [];
  h.prisma.entity.findMany.mockImplementation(async () => ROWS.map(entityRow));
  h.prisma.entity.findUnique.mockImplementation(async ({ where, select }: { where: { id: string }; select?: { metadata?: boolean } }) => {
    const row = ROWS.find((r) => r.id === where.id);
    if (select?.metadata && !("tenantId" in select)) {
      touched.metadataOf.push(where.id);
      return row ? { metadata: null, version: 1, fields: [] } : null;
    }
    return row ? entityRow(row) : null;
  });
  h.prisma.entity.update.mockResolvedValue({});
  h.prisma.field.findMany.mockImplementation(async ({ where }: { where: { entityId: string } }) => {
    touched.fieldsOf.push(where.entityId);
    const row = ROWS.find((r) => r.id === where.entityId);
    return row ? fieldsOf(row) : [];
  });
  h.prisma.entityVersion.findUnique.mockResolvedValue(null);
  h.emitClosure.mockImplementation(async (_closure: unknown, key: string) => ({
    success: true,
    data: { files: [{ path: `${key}.out`, content: key, target: key, entityId: "x" }], warnings: [], entityFiles: {} },
  }));
  h.emitStandalone.mockResolvedValue({ output: "DDL", validationStatus: "VALID", warnings: [], errors: [] });
});

const authorOfSales: Assignment[] = [assign.domain("AUTHOR", T, "d-sales")];
const closureOf = () => h.emitClosure.mock.calls[0][0] as { entities: Array<{ entityId: string }> };

describe("emitEntityAction (the emission preview of the entity page)", () => {
  it("a domain-scoped author whose entity references another domain's entity gets the refusal, every closure target INVALID, nothing built or read", async () => {
    setSessionPrincipal(authorOfSales);
    const answer = (await emitEntityAction("order")) as { success: true; result: { refusal?: { code: string; message: string; details?: unknown }; targets: Record<string, { validationStatus: string; output: string; errors: Array<{ message: string }> }> } };
    expect(answer.success).toBe(true);
    const { refusal, targets } = answer.result;
    expect(refusal).toMatchObject({ code: "REFERENCE_NOT_READABLE", details: { field: "customerRef" } });
    expect(JSON.stringify(refusal)).not.toMatch(/Customer|finance|ledger/);
    expect(h.emitClosure).not.toHaveBeenCalled();
    const invalid = Object.values(targets).filter((t) => t.validationStatus === "INVALID" && t.errors[0]?.message === refusal?.message);
    expect(invalid.length).toBeGreaterThan(0);
    for (const target of invalid) expect(target.output).toBe("");
    expect(touched.fieldsOf).not.toContain("customer");
    expect(touched.metadataOf).not.toContain("customer");
  });

  it("the same domain is previewed whole", async () => {
    setSessionPrincipal(authorOfSales);
    const answer = (await emitEntityAction("invoice")) as { result: { refusal?: unknown } };
    expect(answer.result.refusal).toBeUndefined();
    expect(closureOf().entities.map((e) => e.entityId)).toEqual(["invoice", "line"]);
  });

  it.each([
    ["a tenant administrator", [assign.tenant("ADMIN", T)]],
    ["a tenant-wide viewer", [assign.tenant("VIEWER", T)]],
    ["a platform administrator", [assign.global()]],
  ] as Array<[string, Assignment[]]>)("%s is unaffected", async (_who, assignments) => {
    setSessionPrincipal(assignments);
    const answer = (await emitEntityAction("order")) as { result: { refusal?: unknown } };
    expect(answer.result.refusal).toBeUndefined();
    expect(closureOf().entities.map((e) => e.entityId)).toEqual(["order", "customer"]);
  });
});

describe("generateSchemaAction (a closure target)", () => {
  it("refuses a domain-scoped author with the same code and the toast text, before any row of the other entity is read and nothing is stored", async () => {
    setSessionPrincipal(authorOfSales);
    const answer = (await generateSchemaAction("order", "json-schema")) as { error?: string; code?: string };
    expect(answer.code).toBe("REFERENCE_NOT_READABLE");
    expect(answer.error).toContain('"customerRef"');
    expect(answer.error).not.toMatch(/Customer|finance|ledger/);
    expect(h.emitClosure).not.toHaveBeenCalled();
    expect(h.prisma.entity.update).not.toHaveBeenCalled();
    expect(touched.fieldsOf).not.toContain("customer");
  });

  it("generates for the same domain", async () => {
    setSessionPrincipal(authorOfSales);
    const answer = (await generateSchemaAction("invoice", "json-schema")) as { success?: boolean; error?: string };
    expect(answer.error).toBeUndefined();
    expect(answer.success).toBe(true);
    expect(closureOf().entities.map((e) => e.entityId)).toEqual(["invoice", "line"]);
  });

  it.each([
    ["a tenant administrator", [assign.tenant("ADMIN", T)]],
    ["a tenant steward", [assign.tenant("STEWARD", T)]],
    ["a platform administrator", [assign.global()]],
  ] as Array<[string, Assignment[]]>)("%s generates across domains", async (_who, assignments) => {
    setSessionPrincipal(assignments);
    const answer = (await generateSchemaAction("order", "json-schema")) as { success?: boolean; error?: string };
    expect(answer.error).toBeUndefined();
    expect(answer.success).toBe(true);
    expect(closureOf().entities.map((e) => e.entityId)).toEqual(["order", "customer"]);
  });
});
