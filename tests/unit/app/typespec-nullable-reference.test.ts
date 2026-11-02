import { beforeEach, describe, expect, it, vi } from "vitest";

// A field typed `Customer | null` is the reference to Customer, nullable: the Source save and the preview's Apply both link it to a readable
// entity of the tenant (the null is the field's own fact), and refuse it as an unknown name when the entity is not readable.

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
import {
  applyTypeSpecAction,
  compileAndApplyTypeSpecSourceAction,
} from "@/app/(dashboard)/schemas/[domainSlug]/[productSlug]/[entityId]/actions";

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
const CUSTOMER_D1 = row("ent-customer-d1", "Customer", "dom-1");
const CUSTOMER_D2 = row("ent-customer-d2", "Customer", "dom-2");

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
  setSessionPrincipal([assign.domain("AUTHOR", "tenant-1", "dom-1")]);
  mockPrisma.auditLog.create.mockResolvedValue({ id: "audit-1" });
  mockPrisma.field.findMany.mockResolvedValue([]);
  mockPrisma.field.create.mockResolvedValue({ id: "fld-new" });
  mockPrisma.field.update.mockResolvedValue({ id: "fld-1" });
  mockPrisma.entity.update.mockResolvedValue({ id: "ent-order" });
  mockPrisma.$transaction.mockImplementation(async (ops: unknown[]) => Promise.all(ops));
});

const SOURCE = "model Order { customer: Customer | null; }";

describe("a nullable entity reference (`Customer | null`) is the reference to that entity", () => {
  it("the Source save links the field to the readable Customer, nullable, and stores the reference", async () => {
    tenantHolds(CUSTOMER_D1);

    const result = await compileAndApplyTypeSpecSourceAction("ent-order", SOURCE);

    expect(result).toMatchObject({ success: true });
    expect(mockPrisma.field.create).toHaveBeenCalledTimes(1);
    expect(mockPrisma.field.create.mock.calls[0][0].data).toMatchObject({
      name: "customer",
      type: "reference",
      nullable: true,
      decorators: { referencedEntityId: CUSTOMER_D1.id },
    });
  });

  it("the preview's Apply links the field the same way, nullable, and writes the reference", async () => {
    tenantHolds(CUSTOMER_D1);

    const result = await applyTypeSpecAction("ent-order", SOURCE);

    expect(result).toMatchObject({ added: 1, updated: 0, removed: [] });
    expect(result.error).toBeUndefined();
    expect(mockPrisma.field.create.mock.calls[0][0].data).toMatchObject({
      name: "customer",
      type: "reference",
      nullable: true,
      decorators: { referencedEntityId: CUSTOMER_D1.id },
    });
  });

  it("a nullable name no readable entity answers to is an unknown identifier on Save and on Apply, and stores nothing", async () => {
    tenantHolds(CUSTOMER_D2);

    const saved = await compileAndApplyTypeSpecSourceAction("ent-order", SOURCE);
    expect(saved.success).toBe(false);
    expect(saved.diagnostics).toEqual([expect.objectContaining({ code: "invalid-ref", message: "Unknown identifier Customer" })]);
    expect(JSON.stringify(saved)).not.toContain(CUSTOMER_D2.id);

    const applied = await applyTypeSpecAction("ent-order", SOURCE);
    expect(applied.error).toContain("Unknown identifier Customer");
    expect(JSON.stringify(applied)).not.toContain(CUSTOMER_D2.id);
    nothingWritten();
  });
});

describe("a union of values is refused with the way to write it", () => {
  it("Save names the enum to declare instead of the member text of the union", async () => {
    tenantHolds();

    const result = await compileAndApplyTypeSpecSourceAction("ent-order", 'model Order { status: "open" | "closed"; }');

    expect(result.success).toBe(false);
    expect(result.error).toContain('Field "status" is typed "string | string"');
    expect(result.error).toContain("declared as an enum");
    nothingWritten();
  });
});
