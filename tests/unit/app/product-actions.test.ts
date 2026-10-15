import { beforeEach, describe, expect, it, vi } from "vitest";

// The product actions run under getActionContext (the REAL role and the resolved user id), never a hardcoded AUTHOR,
// and a thrown service never reaches the form as a rejection or as raw driver text.

const h = vi.hoisted(() => ({
  auth: vi.fn(),
  revalidatePath: vi.fn(),
  getEffectiveRole: vi.fn(),
  resolveCurrentUserId: vi.fn(),
  createProduct: vi.fn(),
  updateProduct: vi.fn(),
  deleteProduct: vi.fn(),
}));

vi.mock("next/cache", () => ({ revalidatePath: h.revalidatePath }));
vi.mock("@/lib/auth", () => ({ auth: h.auth }));
vi.mock("@/lib/db", () => ({ prisma: { tag: "prisma" } }));
vi.mock("@/lib/active-tenant", () => ({ getActiveTenantId: vi.fn() }));
vi.mock("@/services/rbac.service", () => ({ getEffectiveRole: h.getEffectiveRole }));
vi.mock("@/lib/current-user", () => ({ resolveCurrentUserId: h.resolveCurrentUserId }));
vi.mock("@/services/product.service", () => ({
  createProduct: h.createProduct,
  updateProduct: h.updateProduct,
  deleteProduct: h.deleteProduct,
}));

import { AuditUserMissingError } from "@/lib/audit";
import { GENERIC_ACTION_ERROR } from "@/types/action-result";
import {
  createProductAction,
  deleteProductAction,
  updateProductAction,
} from "@/app/(dashboard)/schemas/[domainSlug]/product-actions";

const CREATE_INPUT = { domainId: "dom-1", name: "Billing" };

beforeEach(() => {
  vi.clearAllMocks();
  h.auth.mockResolvedValue({ user: { id: "session-id", email: "a@example.test" } });
  h.resolveCurrentUserId.mockResolvedValue("db-user");
  h.getEffectiveRole.mockResolvedValue({ success: true, data: "VIEWER" });
  h.createProduct.mockResolvedValue({ success: true, data: { id: "prd-1", slug: "billing" } });
  h.updateProduct.mockResolvedValue({ success: true, data: { id: "prd-1", slug: "billing-2" } });
  h.deleteProduct.mockResolvedValue({ success: true, data: undefined });
});

describe("product actions use the real action context", () => {
  it("createProductAction passes the resolved user id and the REAL role (not a hardcoded AUTHOR) to the service", async () => {
    expect(await createProductAction(CREATE_INPUT)).toEqual({ success: true, productId: "prd-1", slug: "billing" });
    expect(h.createProduct).toHaveBeenCalledWith(CREATE_INPUT, expect.objectContaining({ userId: "db-user", userRole: "VIEWER" }));
    expect(h.revalidatePath).toHaveBeenCalledWith("/schemas");
  });

  it("update / delete get the same real context", async () => {
    expect(await updateProductAction("prd-1", { name: "Billing 2" })).toEqual({ success: true, slug: "billing-2" });
    expect(h.updateProduct).toHaveBeenCalledWith("prd-1", { name: "Billing 2" }, expect.objectContaining({ userId: "db-user", userRole: "VIEWER" }));
    h.getEffectiveRole.mockResolvedValue({ success: true, data: "ADMIN" });
    expect(await deleteProductAction("prd-1")).toEqual({ success: true });
    expect(h.deleteProduct).toHaveBeenCalledWith("prd-1", expect.objectContaining({ userId: "db-user", userRole: "ADMIN" }));
  });

  it("a role lookup failure fails closed to VIEWER", async () => {
    h.getEffectiveRole.mockResolvedValue({ success: false, error: { code: "DB_ERROR", message: "x" } });
    await createProductAction(CREATE_INPUT);
    expect(h.createProduct).toHaveBeenCalledWith(CREATE_INPUT, expect.objectContaining({ userRole: "VIEWER" }));
  });

  it("without a session, or with a stale one, nothing runs and nothing revalidates", async () => {
    h.auth.mockResolvedValueOnce(null);
    expect(await createProductAction(CREATE_INPUT)).toEqual({ error: "You must be logged in" });
    h.resolveCurrentUserId.mockRejectedValueOnce(new AuditUserMissingError("session-id"));
    expect(await updateProductAction("prd-1", { name: "x" })).toEqual({ error: "You must be logged in" });
    h.auth.mockResolvedValueOnce(null);
    expect(await deleteProductAction("prd-1")).toEqual({ error: "You must be logged in" });
    expect(h.createProduct).not.toHaveBeenCalled();
    expect(h.updateProduct).not.toHaveBeenCalled();
    expect(h.deleteProduct).not.toHaveBeenCalled();
    expect(h.revalidatePath).not.toHaveBeenCalled();
  });
});

describe("product action failures", () => {
  it("a service failure keeps its message and revalidates nothing", async () => {
    h.createProduct.mockResolvedValue({ success: false, error: { code: "DUPLICATE", message: 'A product named "Billing" already exists in this domain' } });
    expect(await createProductAction(CREATE_INPUT)).toEqual({ error: 'A product named "Billing" already exists in this domain' });
    expect(h.revalidatePath).not.toHaveBeenCalled();
  });

  it("a DB_ERROR / INTERNAL_ERROR failure becomes the generic message", async () => {
    for (const code of ["DB_ERROR", "INTERNAL_ERROR"]) {
      h.deleteProduct.mockResolvedValue({ success: false, error: { code, message: "relation \"products\" does not exist" } });
      expect(await deleteProductAction("prd-1")).toEqual({ error: GENERIC_ACTION_ERROR });
    }
  });

  it("a THROWN service (the product service rethrows anything but a unique-constraint hit) is logged and answered generically, never as a rejection or raw text", async () => {
    const spy = vi.spyOn(console, "error").mockImplementation(() => undefined);
    const thrown = new Error("Invalid `prisma.product.create()` invocation: Foreign key constraint violated: `products_domainId_fkey`");
    h.createProduct.mockRejectedValue(thrown);
    h.updateProduct.mockRejectedValue(thrown);
    h.deleteProduct.mockRejectedValue(thrown);
    for (const result of [await createProductAction(CREATE_INPUT), await updateProductAction("prd-1", { name: "x" }), await deleteProductAction("prd-1")]) {
      expect(result).toEqual({ error: GENERIC_ACTION_ERROR });
    }
    expect(spy).toHaveBeenCalledWith("[createProductAction] unexpected error", thrown);
    expect(h.revalidatePath).not.toHaveBeenCalled();
    spy.mockRestore();
  });

  it("Next control-flow errors (redirect / notFound digests) are re-thrown, not swallowed", async () => {
    const control = Object.assign(new Error("NEXT_REDIRECT"), { digest: "NEXT_REDIRECT;replace;/schemas;307;" });
    h.createProduct.mockRejectedValue(control);
    await expect(createProductAction(CREATE_INPUT)).rejects.toBe(control);
  });
});
