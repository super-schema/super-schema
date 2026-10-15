import { describe, it, expect, vi, beforeEach } from "vitest";

const h = vi.hoisted(() => ({ withAudit: vi.fn() }));
vi.mock("@/lib/audit", () => {
  class AuditUserMissingError extends Error {}
  return { withAudit: h.withAudit, AuditUserMissingError };
});

import { auditedWrite } from "@/services/events/audited";
import { AuditUserMissingError } from "@/lib/audit";

beforeEach(() => {
  h.withAudit.mockReset();
  h.withAudit.mockImplementation(async ({ fn }: { fn: () => Promise<unknown> }) => fn());
});
const base = { action: "CREATE", entityType: "Channel", entityId: "pending", userId: "u1" };

describe("auditedWrite", () => {
  it("returns the data and audits once on success", async () => {
    const r = await auditedWrite({ ...base, run: async () => ({ success: true as const, data: { id: "c1" } }) });
    expect(r).toEqual({ success: true, data: { id: "c1" } });
    expect(h.withAudit).toHaveBeenCalledTimes(1);
  });

  it("passes a Result failure through without auditing it", async () => {
    const r = await auditedWrite({ ...base, run: async () => ({ success: false as const, error: { code: "NAME_CONFLICT", message: "taken" } }) });
    expect(r).toEqual({ success: false, error: { code: "NAME_CONFLICT", message: "taken" } });
  });

  it("maps a missing audit user and Prisma errors to service errors", async () => {
    h.withAudit.mockRejectedValueOnce(new AuditUserMissingError("gone"));
    expect(await auditedWrite({ ...base, run: vi.fn() })).toMatchObject({ success: false, error: { code: "UNAUTHORIZED" } });
    h.withAudit.mockRejectedValueOnce(Object.assign(new Error("fk"), { code: "P2003" }));
    expect(await auditedWrite({ ...base, run: vi.fn() })).toMatchObject({ success: false, error: { code: "IN_USE" } });
    h.withAudit.mockRejectedValueOnce(Object.assign(new Error("dup"), { code: "P2002" }));
    expect(await auditedWrite({ ...base, run: vi.fn() })).toMatchObject({ success: false, error: { code: "CONFLICT" } });
    h.withAudit.mockRejectedValueOnce(new Error("boom"));
    expect(await auditedWrite({ ...base, run: vi.fn() })).toEqual({ success: false, error: { code: "DB_ERROR", message: "boom" } });
  });
});
