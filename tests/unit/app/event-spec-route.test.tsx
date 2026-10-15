import { beforeEach, describe, expect, it, vi } from "vitest";

const h = vi.hoisted(() => ({ load: vi.fn() }));
vi.mock("next/navigation", () => ({
  notFound: () => {
    throw new Error("NEXT_NOT_FOUND");
  },
}));
vi.mock("@/features/events/event-specs/load-event-spec-page", () => ({ loadEventSpecPage: h.load }));
vi.mock("@/features/events/event-specs/EventSpecPage", () => ({ EventSpecPage: () => null }));

import EventSpecRoute from "@/app/(dashboard)/schemas/[domainSlug]/[productSlug]/specs/[specId]/page";
import { EventSpecPage } from "@/features/events/event-specs/EventSpecPage";

const params = Promise.resolve({ domainSlug: "payments", productSlug: "checkout", specId: "s1" });

beforeEach(() => vi.clearAllMocks());

describe("event spec route", () => {
  it("loads by route params, ?version and ?tab, then renders the page with the loaded data", async () => {
    h.load.mockResolvedValue({ marker: "data" });
    const element = await EventSpecRoute({ params, searchParams: Promise.resolve({ version: "1.3", tab: "preview" }) });
    expect(h.load).toHaveBeenCalledWith({ domainSlug: "payments", productSlug: "checkout", specId: "s1", version: "1.3", tab: "preview" });
    expect(element.type).toBe(EventSpecPage);
    expect(element.props).toEqual({ marker: "data" });
  });

  it("ignores repeated query values and works without search params", async () => {
    h.load.mockResolvedValue({});
    await EventSpecRoute({ params, searchParams: Promise.resolve({ version: ["1.0", "2.0"], tab: ["preview", "document"] }) });
    await EventSpecRoute({ params });
    const none = { domainSlug: "payments", productSlug: "checkout", specId: "s1", version: undefined, tab: undefined };
    expect(h.load).toHaveBeenNthCalledWith(1, none);
    expect(h.load).toHaveBeenNthCalledWith(2, none);
  });

  it("is a 404 when the loader finds nothing", async () => {
    h.load.mockResolvedValue(null);
    await expect(EventSpecRoute({ params })).rejects.toThrow("NEXT_NOT_FOUND");
  });
});
