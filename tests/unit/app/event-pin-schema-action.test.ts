import { describe, it, expect, vi, beforeEach } from "vitest";

const h = vi.hoisted(() => ({
  auth: vi.fn(), revalidatePath: vi.fn(), resolveCurrentUserId: vi.fn(), withOwnedTarget: vi.fn(), getActiveTenantId: vi.fn(),
  renderPinJsonSchema: vi.fn(),
}));
// The real parent check is covered by tests/unit/app/events-actions-tenant-guard.test.ts; here it is a spy that lets every parent
// through unless a test says otherwise.
vi.mock("@/lib/action-context", async (importOriginal) => ({
  ...(await importOriginal<typeof import("@/lib/action-context")>()),
  withOwnedTarget: h.withOwnedTarget,
}));
vi.mock("@/lib/db", () => ({ prisma: { tag: "prisma" } }));
vi.mock("@/lib/auth", () => ({ auth: h.auth }));
vi.mock("@/lib/active-tenant", () => ({ getActiveTenantId: h.getActiveTenantId }));
vi.mock("@/lib/current-user", () => ({ resolveCurrentUserId: h.resolveCurrentUserId }));
vi.mock("next/cache", () => ({ revalidatePath: h.revalidatePath }));
vi.mock("@/services/rbac.service", () => ({ getEffectiveRole: vi.fn().mockResolvedValue({ success: true, data: "VIEWER" }) }));
vi.mock("@/services/events/pin-json-schema.service", () => ({ renderPinJsonSchema: h.renderPinJsonSchema }));

import { pinJsonSchemaAction } from "@/app/(dashboard)/schemas/[domainSlug]/[productSlug]/event-actions";
import { GENERIC_ACTION_ERROR } from "@/types/action-result";

const CTX = { userId: "u1", userRole: "VIEWER", prisma: { tag: "prisma" } };
const OWNER = { level: "PRODUCT", productId: "p1" };
const TENANT = "tenant-active";
const PIN = { entityId: "ent-1", entityVersionId: "ver-1" };
const SCHEMA = { type: "object", properties: { id: { type: "string" } } };

beforeEach(() => {
  vi.clearAllMocks();
  h.auth.mockResolvedValue({ user: { id: "u1" } });
  h.resolveCurrentUserId.mockResolvedValue("u1");
  h.getActiveTenantId.mockResolvedValue(TENANT);
  h.withOwnedTarget.mockImplementation(async (_target: unknown, run: () => Promise<unknown>) => run());
  h.renderPinJsonSchema.mockResolvedValue({ success: true, data: { schema: SCHEMA } });
});

describe("pinJsonSchemaAction", () => {
  it("hands the service the pin the client chose and the tenant the server resolved, and returns the schema", async () => {
    expect(await pinJsonSchemaAction("p1", PIN)).toEqual({ success: true, data: { schema: SCHEMA } });
    expect(h.renderPinJsonSchema).toHaveBeenCalledTimes(1);
    expect(h.renderPinJsonSchema).toHaveBeenCalledWith(CTX, { tenantId: TENANT, pin: PIN });
  });

  it("never takes the tenant from the client, whatever the pin says", async () => {
    await pinJsonSchemaAction("p1", { ...PIN, tenantId: "someone-elses" } as never);
    expect(h.renderPinJsonSchema.mock.calls[0][1].tenantId).toBe(TENANT);
  });

  it("checks the client-supplied product against the active tenant before the service", async () => {
    await pinJsonSchemaAction("p1", PIN);
    expect(h.withOwnedTarget).toHaveBeenCalledTimes(1);
    expect(h.withOwnedTarget.mock.calls[0][0]).toEqual(OWNER);
  });

  it("never reaches the service when the product is not in the active tenant", async () => {
    h.withOwnedTarget.mockResolvedValue({ success: false, error: { code: "NOT_FOUND", message: 'Product "p1" not found' } });
    expect(await pinJsonSchemaAction("p1", PIN)).toEqual({ success: false, error: 'Product "p1" not found', code: "NOT_FOUND" });
    expect(h.renderPinJsonSchema).not.toHaveBeenCalled();
  });

  it("answers UNAUTHORIZED without any lookup when there is no session", async () => {
    h.auth.mockResolvedValue(null);
    expect(await pinJsonSchemaAction("p1", PIN)).toEqual({ success: false, error: "Not authenticated", code: "UNAUTHORIZED" });
    for (const fn of [h.renderPinJsonSchema, h.withOwnedTarget, h.getActiveTenantId]) expect(fn).not.toHaveBeenCalled();
  });

  it("treats a stale session (the user row is gone) as not authenticated", async () => {
    const { AuditUserMissingError } = await import("@/lib/audit");
    h.resolveCurrentUserId.mockRejectedValue(new AuditUserMissingError("gone"));
    expect(await pinJsonSchemaAction("p1", PIN)).toMatchObject({ success: false, code: "UNAUTHORIZED" });
    expect(h.renderPinJsonSchema).not.toHaveBeenCalled();
  });

  it("is read-only: neither a success nor a failure revalidates", async () => {
    await pinJsonSchemaAction("p1", PIN);
    h.renderPinJsonSchema.mockResolvedValue({ success: false, error: { code: "NOT_FOUND", message: 'Entity "ent-1" not found' } });
    await pinJsonSchemaAction("p1", PIN);
    expect(h.revalidatePath).not.toHaveBeenCalled();
  });

  it("returns the service's own failures as they are: NOT_FOUND, the generic render failure, TOO_LARGE, a bad pin", async () => {
    for (const error of [
      { code: "NOT_FOUND", message: 'Entity "ent-1" not found' },
      { code: "ARTIFACT_RENDER_FAILED", message: "The schema of this entity could not be generated" },
      { code: "TOO_LARGE", message: "The schema of this entity is too large to check examples against (600 KB; the limit is 512 KB)" },
      { code: "VALIDATION_ERROR", message: "pin.entityId must be a non-empty string" },
    ]) {
      h.renderPinJsonSchema.mockResolvedValueOnce({ success: false, error });
      expect(await pinJsonSchemaAction("p1", PIN)).toEqual({ success: false, error: error.message, code: error.code });
    }
  });

  it("keeps raw database text and thrown errors out of the answer", async () => {
    const consoleError = vi.spyOn(console, "error").mockImplementation(() => undefined);
    const RAW = 'relation "entities" does not exist at 10.0.0.5:5432';
    h.renderPinJsonSchema.mockResolvedValue({ success: false, error: { code: "DB_ERROR", message: RAW } });
    expect(await pinJsonSchemaAction("p1", PIN)).toEqual({ success: false, error: GENERIC_ACTION_ERROR, code: "DB_ERROR" });
    h.renderPinJsonSchema.mockRejectedValue(new Error(RAW));
    expect(await pinJsonSchemaAction("p1", PIN)).toEqual({ success: false, error: GENERIC_ACTION_ERROR, code: "INTERNAL_ERROR" });
    h.getActiveTenantId.mockRejectedValue(new Error(RAW));
    expect(JSON.stringify(await pinJsonSchemaAction("p1", PIN))).not.toContain("10.0.0.5");
    consoleError.mockRestore();
  });
});
