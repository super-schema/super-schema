import { beforeEach, describe, expect, it, vi } from "vitest";

// A TypeSpec save may link a field's type name to an entity of the tenant, but only one the caller can READ: an entity in a domain the caller's
// roles do not cover is not a name at all for that caller. A name only such an entity answers to is an unknown identifier, exactly like a name
// nothing answers to, and the answer carries neither the entity's id nor its names (no auto-link, no candidates, no pick).

const { mockPrisma } = vi.hoisted(() => ({
  mockPrisma: {
    entity: { findUnique: vi.fn(), findMany: vi.fn(), update: vi.fn() },
    field: { findMany: vi.fn(), findUnique: vi.fn(), create: vi.fn(), update: vi.fn(), delete: vi.fn() },
    auditLog: { create: vi.fn() },
    $executeRawUnsafe: vi.fn(),
    $transaction: vi.fn(),
  },
}));

vi.mock("@/lib/db", () => ({ prisma: mockPrisma }));
vi.mock("@/lib/access/principal", async () => (await import("../../helpers/access-mocks")).sessionPrincipalModule);
vi.mock("@/lib/auth", () => ({ auth: vi.fn().mockResolvedValue({ user: { id: "user-1" } }) }));
vi.mock("next/cache", () => ({ revalidatePath: vi.fn() }));
vi.mock("@/lib/active-tenant", () => ({ getActiveTenantId: vi.fn().mockResolvedValue("tenant-1") }));

import { assign, resetSessionPrincipal, setSessionPrincipal } from "../../helpers/access-mocks";
import { compileAndApplyTypeSpecSourceAction } from "@/app/(dashboard)/schemas/[domainSlug]/[productSlug]/[entityId]/actions";

type Row = {
  id: string;
  name: string;
  tenantId: string;
  domainId: string;
  productId: string | null;
  description: string;
  status: string;
  version: number;
  latestVersionId: null;
  domain: { id: string; name: string; slug: string };
  product: null;
  metadata: Record<string, unknown>;
  typespecSource: null;
};

const row = (id: string, name: string, domainId: string, tenantId = "tenant-1"): Row => ({
  id, name, tenantId, domainId, productId: null, description: "", status: "DRAFT", version: 1, latestVersionId: null,
  domain: { id: domainId, name: `Domain ${domainId}`, slug: domainId }, product: null, metadata: {}, typespecSource: null,
});

const ORDER = row("ent-order", "Order", "dom-1");
const CUSTOMER_D2 = row("ent-customer-d2", "Customer", "dom-2");
const CUSTOMER_D3 = row("ent-customer-d3", "Customer", "dom-3");
const CUSTOMER_D1 = row("ent-customer-d1", "Customer", "dom-1");
const CUSTOMER_OTHER_TENANT = row("ent-customer-t2", "Customer", "dom-1", "tenant-2");

/** The tenant's rows the test is about (the caller's own entity is always among them). */
function tenantHolds(...rows: Row[]) {
  const all = [ORDER, ...rows];
  mockPrisma.entity.findUnique.mockImplementation(async ({ where }: { where: { id: string } }) => all.find((r) => r.id === where.id) ?? null);
  // The reference loader's tenant read: the tenant it names, narrowed by the `where` the caller built (the domains it may read).
  mockPrisma.entity.findMany.mockImplementation(async ({ where }: { where: { tenantId: string; OR?: Array<Record<string, { in: string[] }>> } }) =>
    all.filter(
      (r) => r.tenantId === where.tenantId && (where.OR === undefined || where.OR.some((c) => ("domainId" in c ? c.domainId.in.includes(r.domainId) : false))),
    ),
  );
}

const nothingWritten = () => {
  expect(mockPrisma.field.create).not.toHaveBeenCalled();
  expect(mockPrisma.field.update).not.toHaveBeenCalled();
  expect(mockPrisma.entity.update).not.toHaveBeenCalled();
  expect(mockPrisma.$transaction).not.toHaveBeenCalled();
};

beforeEach(() => {
  vi.clearAllMocks();
  resetSessionPrincipal();
  mockPrisma.auditLog.create.mockResolvedValue({ id: "audit-1" });
  mockPrisma.field.findMany.mockResolvedValue([]);
  mockPrisma.field.create.mockResolvedValue({ id: "fld-new" });
  mockPrisma.field.update.mockResolvedValue({ id: "fld-1" });
  mockPrisma.entity.update.mockResolvedValue({ id: "ent-order" });
  mockPrisma.$transaction.mockImplementation(async (ops: unknown[]) => Promise.all(ops));
});

const SOURCE = "model Order { customer: Customer; }";

describe("a TypeSpec save links a type name only to an entity the caller can read", () => {
  it("an AUTHOR of D1 saving a name that only a D2 entity answers to gets the unknown-identifier answer, and stores nothing", async () => {
    setSessionPrincipal([assign.domain("AUTHOR", "tenant-1", "dom-1")]);
    tenantHolds(CUSTOMER_D2);

    const result = await compileAndApplyTypeSpecSourceAction("ent-order", SOURCE);

    expect(result.success).toBe(false);
    expect(result.diagnostics).toEqual([expect.objectContaining({ code: "invalid-ref", message: "Unknown identifier Customer" })]);
    expect(result.needsReference).toBeUndefined();
    // Nothing of the unreadable entity is revealed: not its id, not its names.
    expect(JSON.stringify(result)).not.toContain("ent-customer-d2");
    expect(JSON.stringify(result)).not.toContain("Billing");
    nothingWritten();
  });

  it("the same name with two candidates in unreadable domains is still unknown: nothing is asked, no candidate is listed", async () => {
    setSessionPrincipal([assign.domain("AUTHOR", "tenant-1", "dom-1")]);
    tenantHolds(CUSTOMER_D2, CUSTOMER_D3);

    const result = await compileAndApplyTypeSpecSourceAction("ent-order", SOURCE);

    expect(result.success).toBe(false);
    expect(result.needsReference).toBeUndefined();
    expect(result.diagnostics).toEqual([expect.objectContaining({ code: "invalid-ref", message: "Unknown identifier Customer" })]);
    nothingWritten();
  });

  it("a pick of an unreadable candidate is ignored, the name stays unknown", async () => {
    setSessionPrincipal([assign.domain("AUTHOR", "tenant-1", "dom-1")]);
    tenantHolds(CUSTOMER_D2, CUSTOMER_D3);

    const result = await compileAndApplyTypeSpecSourceAction("ent-order", SOURCE, { customer: CUSTOMER_D2.id });

    expect(result.success).toBe(false);
    expect(result.diagnostics).toEqual([expect.objectContaining({ code: "invalid-ref" })]);
    nothingWritten();
  });

  it("a name that matches a readable entity links to it, and the unreadable one of the same name is not a candidate", async () => {
    setSessionPrincipal([assign.domain("AUTHOR", "tenant-1", "dom-1")]);
    tenantHolds(CUSTOMER_D1, CUSTOMER_D2, CUSTOMER_OTHER_TENANT);

    const result = await compileAndApplyTypeSpecSourceAction("ent-order", SOURCE);

    expect(result).toMatchObject({ success: true });
    expect(mockPrisma.field.create).toHaveBeenCalledTimes(1);
    expect(mockPrisma.field.create.mock.calls[0][0].data).toMatchObject({
      name: "customer",
      type: "reference",
      decorators: { referencedEntityId: CUSTOMER_D1.id },
    });
    expect(JSON.stringify(mockPrisma.field.create.mock.calls[0][0].data)).not.toContain(CUSTOMER_D2.id);
  });

  it("the control: a principal who reads the D2 entity links the same name to it", async () => {
    tenantHolds(CUSTOMER_D2);

    const result = await compileAndApplyTypeSpecSourceAction("ent-order", SOURCE);

    expect(result).toMatchObject({ success: true });
    expect(mockPrisma.field.create.mock.calls[0][0].data).toMatchObject({ type: "reference", decorators: { referencedEntityId: CUSTOMER_D2.id } });
  });
});
