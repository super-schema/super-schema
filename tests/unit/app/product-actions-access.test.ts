// @vitest-environment node
/**
 * Access control over the product actions (`[domainSlug]/product-actions.ts`). Every action asks the policy BEFORE the product service or any
 * other read: the REAL guard runs here; what is replaced is the database look-ups and the product service, which are the "effects" a refused
 * caller must never reach.
 *
 * The table: creating a product is a STEWARD's act over the DOMAIN it goes into (`product.create`), editing one is a STEWARD's over the product
 * (`product.update`), deleting one is the TENANT ADMINISTRATOR's (`product.delete`: a domain or product administrator does not reach it).
 * For each operation: nobody signed in, a user with no role, every role of the ladder at tenant scope, a product of another tenant (also for a
 * user who holds a role there: it is not the tenant in view), domain-scoped and product-scoped holders on the right and the wrong scope.
 */
import { beforeEach, describe, expect, it, vi } from "vitest";
import { assign, principalOf, roleless, signInAs, signedOut, tenantMember } from "../../helpers/access-mocks";
import { ROLE_HIERARCHY, type Role } from "@/types/schemas/rbac";
import { roleAtLeast } from "@/lib/access";

const T = "tenant-1";
const OTHER = "tenant-2";

const h = vi.hoisted(() => ({
  activeTenant: vi.fn(),
  revalidatePath: vi.fn(),
  findDomain: vi.fn(),
  findProduct: vi.fn(),
  createProduct: vi.fn(),
  updateProduct: vi.fn(),
  deleteProduct: vi.fn(),
}));

vi.mock("next/cache", () => ({ revalidatePath: h.revalidatePath }));
vi.mock("@/lib/auth", () => ({ auth: vi.fn() }));
vi.mock("@/lib/access/principal", async () => (await import("../../helpers/access-mocks")).principalModule);
vi.mock("@/lib/active-tenant", () => ({ getActiveTenantId: h.activeTenant }));
vi.mock("@/lib/db", () => ({ prisma: { domain: { findUnique: h.findDomain }, product: { findUnique: h.findProduct } } }));
vi.mock("@/services/product.service", () => ({ createProduct: h.createProduct, updateProduct: h.updateProduct, deleteProduct: h.deleteProduct }));

import { createProductAction, deleteProductAction, updateProductAction } from "@/app/(dashboard)/schemas/[domainSlug]/product-actions";

const GENERIC_FORBIDDEN = { error: "You do not have permission to do this" };
const EFFECTS = [h.createProduct, h.updateProduct, h.deleteProduct, h.revalidatePath];
const reached = () => EFFECTS.filter((effect) => effect.mock.calls.length > 0);

/** Where the domain `dom-a` and its product `prod-a` live. */
function place(tenantId: string, domainId = "dom-a") {
  h.findDomain.mockResolvedValue({ tenantId });
  h.findProduct.mockResolvedValue({ domainId, domain: { tenantId } });
}

type Op = { label: string; call: () => Promise<unknown>; min: Role; tenantWide: boolean };

const OPS: Op[] = [
  { label: "createProductAction", call: () => createProductAction({ domainId: "dom-a", name: "Billing" }), min: "STEWARD", tenantWide: false },
  { label: "updateProductAction", call: () => updateProductAction("prod-a", { name: "Billing 2" }), min: "STEWARD", tenantWide: false },
  { label: "deleteProductAction", call: () => deleteProductAction("prod-a"), min: "ADMIN", tenantWide: true },
];

beforeEach(() => {
  vi.clearAllMocks();
  vi.spyOn(console, "error").mockImplementation(() => undefined);
  signInAs(tenantMember("ADMIN", T));
  h.activeTenant.mockResolvedValue(T);
  place(T);
  h.createProduct.mockResolvedValue({ success: true, data: { id: "prod-new", slug: "billing" } });
  h.updateProduct.mockResolvedValue({ success: true, data: { id: "prod-a", slug: "billing-2" } });
  h.deleteProduct.mockResolvedValue({ success: true, data: undefined });
});

const refused = (answer: unknown) => (answer as { error?: string }).error !== undefined;
const isNotFound = (answer: unknown) => /not found$/.test((answer as { error?: string }).error ?? "");

describe.each(OPS)("$label", (op) => {
  it("answers nobody signed in 'You must be logged in' and reaches nothing, not even a look-up", async () => {
    signedOut();
    expect(await op.call()).toEqual({ error: "You must be logged in" });
    expect(reached()).toHaveLength(0);
    expect(h.findDomain).not.toHaveBeenCalled();
    expect(h.findProduct).not.toHaveBeenCalled();
  });

  it("answers a user with no role at all as a missing resource and reaches nothing", async () => {
    signInAs(roleless());
    const answer = await op.call();
    expect(isNotFound(answer)).toBe(true);
    expect(reached()).toHaveLength(0);
  });

  it("is allowed from its minimum role up and refused (generic, nothing reached) below it", async () => {
    for (const role of ROLE_HIERARCHY) {
      vi.clearAllMocks();
      signInAs(tenantMember(role, T));
      h.activeTenant.mockResolvedValue(T);
      place(T);
      h.createProduct.mockResolvedValue({ success: true, data: { id: "prod-new", slug: "billing" } });
      h.updateProduct.mockResolvedValue({ success: true, data: { id: "prod-a", slug: "billing-2" } });
      h.deleteProduct.mockResolvedValue({ success: true, data: undefined });
      const answer = await op.call();
      if (roleAtLeast(role, op.min)) {
        expect(refused(answer), `${role}: ${JSON.stringify(answer)}`).toBe(false);
        expect(reached(), role).not.toHaveLength(0);
      } else {
        expect(answer, role).toEqual(GENERIC_FORBIDDEN);
        expect(reached(), `${role} reached an effect`).toHaveLength(0);
      }
    }
  });

  it("a platform administrator may", async () => {
    signInAs(principalOf([assign.global()]));
    expect(refused(await op.call())).toBe(false);
  });

  it("answers a resource of ANOTHER tenant exactly as a missing one, even for an administrator of both tenants, and reaches nothing", async () => {
    signInAs(principalOf([assign.tenant("ADMIN", T), assign.tenant("ADMIN", OTHER)]));
    place(OTHER);
    const foreign = await op.call();
    h.findDomain.mockResolvedValue(null);
    h.findProduct.mockResolvedValue(null);
    const missing = await op.call();
    expect(JSON.stringify(foreign)).toBe(JSON.stringify(missing));
    expect(isNotFound(foreign)).toBe(true);
    expect(reached()).toHaveLength(0);
  });

  it("follows the ACTIVE tenant: a role in the resource's tenant does not help while another tenant is in view", async () => {
    signInAs(principalOf([assign.tenant("ADMIN", T), assign.tenant("ADMIN", OTHER)]));
    h.activeTenant.mockResolvedValue(OTHER);
    expect(isNotFound(await op.call())).toBe(true);
    expect(reached()).toHaveLength(0);
  });

  it("a malformed id is a missing resource, with no look-up", async () => {
    const malformed: Array<() => Promise<unknown>> = [
      () => createProductAction({ domainId: 5 as never, name: "x" }),
      () => updateProductAction("" as never, {}),
      () => deleteProductAction(undefined as never),
    ];
    for (const call of malformed) expect(isNotFound(await call())).toBe(true);
    expect(h.findDomain).not.toHaveBeenCalled();
    expect(h.findProduct).not.toHaveBeenCalled();
    expect(reached()).toHaveLength(0);
  });

  if (op.tenantWide) {
    it("is a tenant-wide act: a domain or product administrator does not reach it", async () => {
      signInAs(principalOf([assign.domain("ADMIN", T, "dom-a")]));
      expect(await op.call()).toEqual(GENERIC_FORBIDDEN);
      signInAs(principalOf([assign.product("ADMIN", T, "dom-a", "prod-a")]));
      expect(await op.call()).toEqual(GENERIC_FORBIDDEN);
      expect(reached()).toHaveLength(0);
    });
  } else {
    it("a domain-scoped role takes effect: a steward of the domain may, an author of it may not, a steward of a sibling domain reads it as missing", async () => {
      signInAs(principalOf([assign.domain("STEWARD", T, "dom-a")]));
      expect(refused(await op.call())).toBe(false);
      signInAs(principalOf([assign.domain("AUTHOR", T, "dom-a")]));
      expect(await op.call()).toEqual(GENERIC_FORBIDDEN);
      vi.clearAllMocks();
      signInAs(principalOf([assign.domain("ADMIN", T, "dom-b")]));
      h.activeTenant.mockResolvedValue(T);
      place(T);
      expect(isNotFound(await op.call())).toBe(true);
      expect(reached()).toHaveLength(0);
    });
  }
});

describe("product-scoped holders", () => {
  it("a steward of the product edits it, and reads a sibling product of the same domain as missing", async () => {
    signInAs(principalOf([assign.product("STEWARD", T, "dom-a", "prod-a")]));
    expect(refused(await updateProductAction("prod-a", { name: "x" }))).toBe(false);
    expect(h.updateProduct).toHaveBeenCalledTimes(1);

    // Their role is over another product of the same domain: it does not reach this one.
    vi.clearAllMocks();
    signInAs(principalOf([assign.product("STEWARD", T, "dom-a", "prod-other")]));
    h.activeTenant.mockResolvedValue(T);
    place(T);
    expect(isNotFound(await updateProductAction("prod-a", { name: "x" }))).toBe(true);
    expect(h.updateProduct).not.toHaveBeenCalled();
  });

  it("creating a product needs the domain: a product-scoped steward is refused as the domain is not theirs to extend", async () => {
    signInAs(principalOf([assign.product("STEWARD", T, "dom-a", "prod-a")]));
    expect(isNotFound(await createProductAction({ domainId: "dom-a", name: "New" }))).toBe(true);
    expect(h.createProduct).not.toHaveBeenCalled();
  });
});

describe("the context the service receives", () => {
  it("is the principal's: the user and the assignments the policy judged, never a role label", async () => {
    const assignments = [assign.tenant("ADMIN", T)];
    signInAs(principalOf(assignments, { userId: "u-9" }));
    await deleteProductAction("prod-a");
    expect(h.deleteProduct).toHaveBeenCalledWith("prod-a", expect.objectContaining({ userId: "u-9", assignments }));
  });
});
