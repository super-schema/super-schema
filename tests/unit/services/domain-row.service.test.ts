import { beforeEach, describe, expect, it, vi } from "vitest";

// What a Domain row must be, in the ONE function the Domains page's action, the Admin tab and the tRPC `createDomain` all make it with.
const ACTIVE_TENANT = "tenant-a";
const h = vi.hoisted(() => ({
  withAudit: vi.fn(async ({ fn }: { fn: () => Promise<unknown> }) => fn()),
  ensureDefaultTenantId: vi.fn(async () => "tenant_default"),
}));
vi.mock("@/lib/active-tenant", () => ({ getActiveTenantId: vi.fn(async () => ACTIVE_TENANT) }));
vi.mock("@/lib/org-defaults", () => ({ ensureDefaultTenantId: h.ensureDefaultTenantId, DEFAULT_TENANT_ID: "tenant_default" }));
vi.mock("@/lib/audit", () => ({
  AuditUserMissingError: class AuditUserMissingError extends Error {},
  withAudit: h.withAudit,
}));

import { AuditUserMissingError } from "@/lib/audit";
import { createDomainRow } from "@/services/domain-row.service";
import type { PrismaClient } from "@/generated/prisma/client";

const db = {
  domain: {
    findFirst: vi.fn(),
    create: vi.fn(),
  },
};
const asDb = db as unknown as PrismaClient;
const input = (name: string, extra: Record<string, unknown> = {}) => ({ name, userId: "user-1", ...extra });

describe("createDomainRow", () => {
  beforeEach(() => {
    vi.clearAllMocks();
    db.domain.findFirst.mockResolvedValue(null);
    db.domain.create.mockImplementation(async ({ data }: { data: Record<string, unknown> }) => ({ id: "dom-1", ...data }));
  });

  it("makes the row in the tenant being viewed, with the slug of the name and the trimmed name, and audits it for the acting user", async () => {
    const result = await createDomainRow(input("  Finance Ops ", { description: "Money" }), asDb);

    expect(result.success).toBe(true);
    expect(db.domain.create).toHaveBeenCalledWith({ data: { name: "Finance Ops", slug: "finance-ops", description: "Money", tenantId: ACTIVE_TENANT } });
    expect(h.ensureDefaultTenantId).toHaveBeenCalledWith(db);
    expect(h.withAudit).toHaveBeenCalledTimes(1);
    expect(h.withAudit.mock.calls[0][0]).toMatchObject({ action: "CREATE", entityType: "Domain", entityId: "pending", userId: "user-1" });
  });

  it("accepts a name in a non-Latin script: its slug is a hash of the name, so two such domains do not share one", async () => {
    expect((await createDomainRow(input("日本"), asDb)).success).toBe(true);
    expect((await createDomainRow(input("中国"), asDb)).success).toBe(true);

    const slugs = db.domain.create.mock.calls.map(([args]) => (args as { data: { slug: string } }).data.slug);
    expect(slugs[0]).toMatch(/^item-[0-9a-z]+$/);
    expect(slugs[1]).toMatch(/^item-[0-9a-z]+$/);
    expect(slugs[0]).not.toBe(slugs[1]);
  });

  it("stores a policy template when one is given, and none when it is not", async () => {
    await createDomainRow(input("With Template", { policyTemplate: { classification: "PII" } }), asDb);
    expect(db.domain.create.mock.calls[0][0].data.policyTemplate).toEqual({ classification: "PII" });
    await createDomainRow(input("Without Template"), asDb);
    expect(db.domain.create.mock.calls[1][0].data).not.toHaveProperty("policyTemplate");
  });

  it.each([
    ["", "Domain name is required"],
    ["   ", "Domain name is required"],
    ["x".repeat(65), "Domain name must be 64 characters or less"],
    ["!!!", "Domain name must contain at least one letter or digit"],
    ["---", "Domain name must contain at least one letter or digit"],
    ["Type Mappings", '"type-mappings" is reserved for a schemas utility page'],
    ["Enterprise", '"enterprise" is reserved for a schemas utility page'],
  ])("refuses the name %j (%s) and writes nothing", async (name, message) => {
    const result = await createDomainRow(input(name), asDb);

    expect(result.success).toBe(false);
    if (!result.success) {
      expect(result.error.code).toBe("VALIDATION_ERROR");
      expect(result.error.message).toBe(message);
    }
    expect(db.domain.create).not.toHaveBeenCalled();
    expect(h.withAudit).not.toHaveBeenCalled();
  });

  it("a name of exactly 64 characters is allowed", async () => {
    const result = await createDomainRow(input("x".repeat(64)), asDb);
    expect(result.success).toBe(true);
  });

  it("refuses a name another domain of the tenant has in any case, and says which, before it writes", async () => {
    db.domain.findFirst.mockResolvedValue({ id: "dom-existing" });

    const result = await createDomainRow(input("FINANCE"), asDb);

    expect(result.success).toBe(false);
    if (!result.success) {
      expect(result.error.code).toBe("DUPLICATE");
      expect(result.error.message).toBe('A domain named "FINANCE" already exists');
    }
    expect(db.domain.findFirst).toHaveBeenCalledWith({ where: { tenantId: ACTIVE_TENANT, name: { equals: "FINANCE", mode: "insensitive" } }, select: { id: true } });
    expect(db.domain.create).not.toHaveBeenCalled();
  });

  it.each([
    ["Prisma P2002", Object.assign(new Error("Unique constraint failed on the fields: (`slug`,`tenantId`)"), { code: "P2002" })],
    ["a driver that only says it in words", new Error("Unique constraint failed on the fields: (`name`)")],
  ])("answers a clash the database finds (the same slug from another spelling): %s", async (_label, error) => {
    db.domain.create.mockRejectedValue(error);

    const result = await createDomainRow(input("order-data"), asDb);

    expect(result.success).toBe(false);
    if (!result.success) expect(result.error.code).toBe("DUPLICATE");
  });

  it("lets a session whose user no longer exists, and any other failure, THROW: the entry points word those themselves", async () => {
    h.withAudit.mockRejectedValueOnce(new AuditUserMissingError("gone"));
    await expect(createDomainRow(input("Gone User"), asDb)).rejects.toBeInstanceOf(AuditUserMissingError);

    db.domain.create.mockRejectedValue(Object.assign(new Error("connection lost"), { code: "P1001" }));
    await expect(createDomainRow(input("Lost Connection"), asDb)).rejects.toThrow("connection lost");
  });
});
