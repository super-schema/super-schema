import { beforeEach, describe, expect, it, vi } from "vitest";

// The product actions address a domain (create) or a product (update / delete) by a bare id and the product service trusts
// it: the id must belong to the caller's ACTIVE tenant. A foreign id gets the very answer the service gives a missing one.
// (`ctx.userRole` is never read by product.service: no role gate exists below these actions; noted in the F7 report.)

const h = vi.hoisted(() => ({
  auth: vi.fn(),
  revalidatePath: vi.fn(),
  getEffectiveRole: vi.fn(),
  resolveCurrentUserId: vi.fn(),
  getActiveTenantId: vi.fn(),
  createProduct: vi.fn(),
  updateProduct: vi.fn(),
  deleteProduct: vi.fn(),
  findDomain: vi.fn(),
  findProduct: vi.fn(),
}));

vi.mock("next/cache", () => ({ revalidatePath: h.revalidatePath }));
vi.mock("@/lib/auth", () => ({ auth: h.auth }));
vi.mock("@/lib/db", () => ({ prisma: { domain: { findUnique: h.findDomain }, product: { findUnique: h.findProduct } } }));
vi.mock("@/lib/active-tenant", () => ({ getActiveTenantId: h.getActiveTenantId }));
vi.mock("@/services/rbac.service", () => ({ getEffectiveRole: h.getEffectiveRole }));
vi.mock("@/lib/current-user", () => ({ resolveCurrentUserId: h.resolveCurrentUserId }));
vi.mock("@/services/product.service", () => ({ createProduct: h.createProduct, updateProduct: h.updateProduct, deleteProduct: h.deleteProduct }));

import { GENERIC_ACTION_ERROR } from "@/types/action-result";
import { createProductAction, deleteProductAction, updateProductAction } from "@/app/(dashboard)/schemas/[domainSlug]/product-actions";

const T = "tenant-1";
const OTHER = "tenant-2";
const asAny = (v: unknown) => v as never;
const PRISMA_TEXT = "Invalid `prisma.product.findUnique()` invocation in\n/Users/dev/src/my/super-schema/src/lib/action-context.ts:40:20\n→ 40 prisma.product.findUnique({ where: { id: undefined";

const CREATE_INPUT = { domainId: "dom-1", name: "Billing" };

beforeEach(() => {
  vi.clearAllMocks();
  h.auth.mockResolvedValue({ user: { id: "session-id", email: "a@example.test" } });
  h.resolveCurrentUserId.mockResolvedValue("db-user");
  h.getEffectiveRole.mockResolvedValue({ success: true, data: "AUTHOR" });
  h.getActiveTenantId.mockResolvedValue(T);
  h.findDomain.mockResolvedValue({ tenantId: T });
  h.findProduct.mockResolvedValue({ domain: { tenantId: T } });
  h.createProduct.mockResolvedValue({ success: true, data: { id: "prd-1", slug: "billing" } });
  h.updateProduct.mockResolvedValue({ success: true, data: { id: "prd-1", slug: "billing-2" } });
  h.deleteProduct.mockResolvedValue({ success: true, data: { id: "prd-1" } });
});

describe("createProductAction guards the PARENT domain", () => {
  it("creates in a domain of the active tenant", async () => {
    expect(await createProductAction(CREATE_INPUT)).toEqual({ success: true, productId: "prd-1", slug: "billing" });
    expect(h.createProduct).toHaveBeenCalledTimes(1);
  });

  it("a domain of ANOTHER tenant reads exactly like a missing one; the service never runs, nothing is revalidated", async () => {
    h.findDomain.mockResolvedValue({ tenantId: OTHER });
    const foreign = await createProductAction(CREATE_INPUT);
    h.findDomain.mockResolvedValue(null);
    const missing = await createProductAction(CREATE_INPUT);
    expect(foreign).toEqual({ error: 'Domain "dom-1" not found' });
    expect(JSON.stringify(foreign)).toBe(JSON.stringify(missing));
    expect(h.createProduct).not.toHaveBeenCalled();
    expect(h.revalidatePath).not.toHaveBeenCalled();
  });

  it("a malformed input or domain id is answered without a query or a TypeError", async () => {
    for (const bad of [null, undefined, {}, { name: "x" }, { domainId: 5, name: "x" }, { domainId: "", name: "x" }]) {
      const result = (await createProductAction(asAny(bad))) as { error?: string };
      expect(result.error).toMatch(/not found/);
      expect(result.error).not.toMatch(/Cannot read properties|TypeError/);
    }
    expect(h.findDomain).not.toHaveBeenCalled();
    expect(h.createProduct).not.toHaveBeenCalled();
  });

  it("follows the ACTIVE tenant", async () => {
    h.findDomain.mockResolvedValue({ tenantId: OTHER });
    expect(await createProductAction(CREATE_INPUT)).toMatchObject({ error: expect.stringMatching(/not found/) });
    h.getActiveTenantId.mockResolvedValue(OTHER);
    expect(await createProductAction(CREATE_INPUT)).toMatchObject({ success: true });
  });
});

describe.each([
  { label: "updateProductAction", call: (id: unknown) => updateProductAction(asAny(id), { name: "Billing 2" }), service: () => h.updateProduct },
  { label: "deleteProductAction", call: (id: unknown) => deleteProductAction(asAny(id)), service: () => h.deleteProduct },
])("$label guards the product", ({ call, service }) => {
  it("works on a product whose domain belongs to the active tenant", async () => {
    expect(await call("prd-1")).toMatchObject({ success: true });
    expect(service()).toHaveBeenCalledTimes(1);
  });

  it("a product of ANOTHER tenant's domain reads exactly like a missing one (the service's own message); the service never runs", async () => {
    h.findProduct.mockResolvedValue({ domain: { tenantId: OTHER } });
    const foreign = await call("prd-9");
    h.findProduct.mockResolvedValue(null);
    const missing = await call("prd-9");
    expect(foreign).toEqual({ error: 'Product "prd-9" not found' });
    expect(JSON.stringify(foreign)).toBe(JSON.stringify(missing));
    expect(service()).not.toHaveBeenCalled();
    expect(h.revalidatePath).not.toHaveBeenCalled();
  });

  it("a malformed id is answered without a query", async () => {
    for (const bad of [undefined, null, "", "  ", 5, {}]) {
      expect(await call(bad)).toMatchObject({ error: expect.stringMatching(/^Product ".*" not found$/) });
    }
    expect(h.findProduct).not.toHaveBeenCalled();
    expect(service()).not.toHaveBeenCalled();
  });

  it("a throwing ownership lookup is logged and answered with the generic message", async () => {
    const spy = vi.spyOn(console, "error").mockImplementation(() => undefined);
    h.findProduct.mockRejectedValue(new Error(PRISMA_TEXT));
    const result = await call("prd-1");
    expect(result).toEqual({ error: GENERIC_ACTION_ERROR });
    expect(JSON.stringify(result)).not.toMatch(/prisma|Users\/dev|action-context/i);
    expect(service()).not.toHaveBeenCalled();
    spy.mockRestore();
  });

  it("still requires a session before any query", async () => {
    h.auth.mockResolvedValue(null);
    expect(await call("prd-1")).toEqual({ error: "You must be logged in" });
    expect(h.findProduct).not.toHaveBeenCalled();
  });
});
