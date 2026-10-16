import { beforeEach, describe, it, expect, vi } from "vitest";

// The product-level /traits/[traitId] and /channels/[channelId] routes are redirects now (tests/unit/app/event-redirects.test.tsx);
// what stays here are the Domain and Enterprise trait routes and the shared TraitRoutePage.
const h = vi.hoisted(() => ({ loadTraitPage: vi.fn() }));
vi.mock("next/navigation", () => ({ notFound: vi.fn(() => { throw new Error("not found"); }) }));
vi.mock("@/features/events/traits/load-trait-page", () => ({ loadTraitPage: h.loadTraitPage }));
vi.mock("@/features/events/traits/TraitEditor", () => ({ TraitEditor: () => null }));

import DomainTraitPage from "@/app/(dashboard)/schemas/[domainSlug]/traits/[traitId]/page";
import EnterpriseTraitPage from "@/app/(dashboard)/schemas/enterprise/traits/[traitId]/page";
import { TraitEditor } from "@/features/events/traits/TraitEditor";
import { TraitRoutePage } from "@/features/events/traits/TraitRoutePage";

beforeEach(() => vi.clearAllMocks());

describe("trait routes (Domain and Enterprise)", () => {
  it("routes the Domain and Enterprise levels through TraitRoutePage with the right slugs", async () => {
    const domain = await DomainTraitPage({ params: Promise.resolve({ domainSlug: "payments", traitId: "t1" }) });
    expect(domain.type).toBe(TraitRoutePage);
    expect(domain.props).toEqual({ domainSlug: "payments", productSlug: null, traitId: "t1" });
    const enterprise = await EnterpriseTraitPage({ params: Promise.resolve({ traitId: "t2" }) });
    expect(enterprise.type).toBe(TraitRoutePage);
    expect(enterprise.props).toEqual({ domainSlug: null, productSlug: null, traitId: "t2" });
  });

  it("TraitRoutePage 404s for a trait outside its level and renders the editor otherwise", async () => {
    h.loadTraitPage.mockResolvedValue(null);
    await expect(TraitRoutePage({ domainSlug: null, productSlug: null, traitId: "t2" })).rejects.toThrow("not found");
    expect(h.loadTraitPage).toHaveBeenCalledWith({ domainSlug: null, productSlug: null, traitId: "t2" });
    const data = { trait: { id: "t2" }, owner: { level: "TENANT", tenantId: "t" }, crumbs: [], listHref: "/x", entityOptions: [] };
    h.loadTraitPage.mockResolvedValue(data);
    const element = await TraitRoutePage({ domainSlug: "payments", productSlug: null, traitId: "t2" });
    expect(element.type).toBe(TraitEditor);
    expect(element.props).toEqual(data);
  });
});
