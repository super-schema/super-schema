/**
 * FINAL WAVE 2b, G8: a TypeSpec source the compiler refuses is recorded (a COMPILATION_ERROR audit row) so Admin > Health's "Compilation
 * Errors" card has something to count; a source that saves, and a refusal that is not the compiler's (a reserved name), record none.
 * Prisma, auth and Next are mocked; the compiler is REAL.
 */
import { describe, it, expect, vi, beforeEach } from "vitest";

const { mockPrisma } = vi.hoisted(() => ({
  mockPrisma: {
    entity: { findUnique: vi.fn(), update: vi.fn() },
    field: { findMany: vi.fn(), create: vi.fn(), update: vi.fn(), delete: vi.fn() },
    auditLog: { create: vi.fn() },
    $executeRawUnsafe: vi.fn(),
    $transaction: vi.fn(),
  },
}));

vi.mock("server-only", () => ({}));
vi.mock("@/lib/db", () => ({ prisma: mockPrisma }));
vi.mock("@/lib/access/principal", async () => (await import("../../helpers/access-mocks")).sessionPrincipalModule);
vi.mock("@/lib/auth", () => ({ auth: vi.fn().mockResolvedValue({ user: { id: "user-1" } }) }));
vi.mock("next/cache", () => ({ revalidatePath: vi.fn() }));
vi.mock("@/lib/active-tenant", () => ({ getActiveTenantId: vi.fn().mockResolvedValue("tenant-1") }));

import { compileAndApplyTypeSpecSourceAction } from "@/app/(dashboard)/schemas/[domainSlug]/[productSlug]/[entityId]/actions";

beforeEach(() => {
  vi.clearAllMocks();
  mockPrisma.auditLog.create.mockResolvedValue({ id: "audit-1" });
  mockPrisma.entity.update.mockResolvedValue({ id: "ent-1" });
  mockPrisma.entity.findUnique.mockResolvedValue({ id: "ent-1", name: "Customer", typespecSource: null, tenantId: "tenant-1" });
  mockPrisma.field.findMany.mockResolvedValue([]);
  mockPrisma.field.create.mockResolvedValue({ id: "new" });
  mockPrisma.$transaction.mockImplementation(async (ops: unknown[]) => Promise.all(ops));
});

const failures = () => mockPrisma.auditLog.create.mock.calls.map((c) => (c[0] as { data: { action: string } }).data).filter((d) => d.action === "COMPILATION_ERROR");

describe("compileAndApplyTypeSpecSourceAction records what the compiler refused", () => {
  it("a source that does not compile is answered with its diagnostics and recorded as a COMPILATION_ERROR of the entity, by the user", async () => {
    const res = await compileAndApplyTypeSpecSourceAction("ent-1", "model Customer {\n  id: string\n  broken: ;\n}\n");
    expect(res).toMatchObject({ success: false });
    expect(failures()).toEqual([
      expect.objectContaining({ action: "COMPILATION_ERROR", entityType: "Entity", entityId: "ent-1", userId: "user-1", afterState: { messages: expect.any(Array) } }),
    ]);
    expect((failures()[0] as unknown as { afterState: { messages: string[] } }).afterState.messages.length).toBeGreaterThan(0);
  }, 60_000);

  it("a source that compiles and saves records none", async () => {
    const res = await compileAndApplyTypeSpecSourceAction("ent-1", "model Customer {\n  id: string;\n}\n");
    expect(res).toMatchObject({ success: true });
    expect(failures()).toEqual([]);
  }, 60_000);

  it("a failure to write the row does not change the answer (best effort)", async () => {
    mockPrisma.auditLog.create.mockRejectedValue(new Error("db down"));
    vi.spyOn(console, "error").mockImplementation(() => {});
    const res = await compileAndApplyTypeSpecSourceAction("ent-1", "model Customer {\n  id: string\n  broken: ;\n}\n");
    expect(res).toMatchObject({ success: false });
    expect(res).toHaveProperty("diagnostics");
  }, 60_000);
});
