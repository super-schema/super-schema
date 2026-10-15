import { beforeEach, describe, it, expect, vi } from "vitest";

const h = vi.hoisted(() => ({ loadChannelPage: vi.fn(), loadTraitPage: vi.fn() }));
vi.mock("next/navigation", () => ({ notFound: vi.fn(() => { throw new Error("not found"); }) }));
vi.mock("@/features/events/channels/load-channel-page", () => ({ loadChannelPage: h.loadChannelPage }));
vi.mock("@/features/events/traits/load-trait-page", () => ({ loadTraitPage: h.loadTraitPage }));
vi.mock("@/features/events/channels/ChannelEditor", () => ({ ChannelEditor: () => null }));
vi.mock("@/features/events/traits/TraitEditor", () => ({ TraitEditor: () => null }));

import ChannelPage from "@/app/(dashboard)/schemas/[domainSlug]/[productSlug]/channels/[channelId]/page";
import ProductTraitPage from "@/app/(dashboard)/schemas/[domainSlug]/[productSlug]/traits/[traitId]/page";
import DomainTraitPage from "@/app/(dashboard)/schemas/[domainSlug]/traits/[traitId]/page";
import EnterpriseTraitPage from "@/app/(dashboard)/schemas/enterprise/traits/[traitId]/page";
import { ChannelEditor } from "@/features/events/channels/ChannelEditor";
import { TraitEditor } from "@/features/events/traits/TraitEditor";
import { TraitRoutePage } from "@/features/events/traits/TraitRoutePage";

beforeEach(() => vi.clearAllMocks());

describe("channel + trait routes", () => {
  it("404s when the channel is not in the addressed product", async () => {
    h.loadChannelPage.mockResolvedValue(null);
    await expect(ChannelPage({ params: Promise.resolve({ domainSlug: "payments", productSlug: "fraud", channelId: "c1" }) })).rejects.toThrow("not found");
    expect(h.loadChannelPage).toHaveBeenCalledWith({ domainSlug: "payments", productSlug: "fraud", channelId: "c1" });
  });

  it("renders the channel editor with the loaded page data", async () => {
    const data = { channel: { id: "c1" }, productId: "p1", crumbs: [], listHref: "/x", messageOptions: [] };
    h.loadChannelPage.mockResolvedValue(data);
    const element = await ChannelPage({ params: Promise.resolve({ domainSlug: "payments", productSlug: "fraud", channelId: "c1" }) });
    expect(element.type).toBe(ChannelEditor);
    expect(element.props).toEqual(data);
  });

  it("routes every trait level through TraitRoutePage with the right slugs", async () => {
    const domain = await DomainTraitPage({ params: Promise.resolve({ domainSlug: "payments", traitId: "t1" }) });
    expect(domain.type).toBe(TraitRoutePage);
    expect(domain.props).toEqual({ domainSlug: "payments", productSlug: null, traitId: "t1" });
    const enterprise = await EnterpriseTraitPage({ params: Promise.resolve({ traitId: "t2" }) });
    expect(enterprise.type).toBe(TraitRoutePage);
    expect(enterprise.props).toEqual({ domainSlug: null, productSlug: null, traitId: "t2" });
    const product = await ProductTraitPage({ params: Promise.resolve({ domainSlug: "payments", productSlug: "fraud", traitId: "t3" }) });
    expect(product.type).toBe(TraitRoutePage);
    expect(product.props).toEqual({ domainSlug: "payments", productSlug: "fraud", traitId: "t3" });
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
