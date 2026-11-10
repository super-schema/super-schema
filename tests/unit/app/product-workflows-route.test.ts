import { beforeEach, expect, it, vi } from "vitest";
const h = vi.hoisted(() => ({ find: vi.fn(), redirect: vi.fn((path: string) => { throw new Error(`Redirect: ${path}`); }) }));
vi.mock("@/lib/db", () => ({ prisma: { product: { findFirst: h.find } } }));
vi.mock("@/lib/access/page-access", () => ({ requirePageAccess: async () => ({ tenantId: "tenant", principal: { assignments: [{ role: "ADMIN", scope: { kind: "TENANT", tenantId: "tenant" } }] } }) }));
vi.mock("next/navigation", () => ({ redirect: h.redirect, notFound: () => { throw new Error("Not found"); } }));
import Page from "@/app/(dashboard)/schemas/[domainSlug]/[productSlug]/workflows/page";
beforeEach(() => { vi.clearAllMocks(); h.find.mockResolvedValue({ id: "product", domainId: "domain", name: "Accounts" }); });
it("keeps old workflow links working through the canonical product tab", async () => {
  await expect(Page({ params: Promise.resolve({ domainSlug: "identity", productSlug: "accounts" }) })).rejects.toThrow("Redirect: /schemas/identity/accounts?tab=workflows");
  expect(h.find).toHaveBeenCalledWith({ where: { slug: "accounts", domain: { slug: "identity", tenantId: "tenant" } } });
});
it("does not redirect a missing or foreign product", async () => {
  h.find.mockResolvedValue(null);
  await expect(Page({ params: Promise.resolve({ domainSlug: "identity", productSlug: "accounts" }) })).rejects.toThrow("Not found");
  expect(h.redirect).not.toHaveBeenCalled();
});
