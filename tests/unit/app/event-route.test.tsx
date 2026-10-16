import { beforeEach, describe, expect, it, vi } from "vitest";

const h = vi.hoisted(() => ({ load: vi.fn() }));
vi.mock("next/navigation", () => ({
  notFound: () => {
    throw new Error("NEXT_NOT_FOUND");
  },
}));
vi.mock("@/features/events/event-page/load-event-page", () => ({ loadEventPage: h.load }));
vi.mock("@/features/events/event-page/EventPage", () => ({ EventPage: () => null }));

import EventRoute from "@/app/(dashboard)/schemas/[domainSlug]/[productSlug]/events/[eventId]/page";
import Loading from "@/app/(dashboard)/schemas/[domainSlug]/[productSlug]/events/[eventId]/loading";
import { EventPage } from "@/features/events/event-page/EventPage";

const params = Promise.resolve({ domainSlug: "payments", productSlug: "checkout", eventId: "ev1" });

beforeEach(() => vi.clearAllMocks());

describe("event route", () => {
  it("loads by route params and ?tab / ?section / ?item, then renders the page with the loaded data as `data`", async () => {
    const data = { marker: "data" };
    h.load.mockResolvedValue(data);
    const element = await EventRoute({ params, searchParams: Promise.resolve({ tab: "preview", section: "channels", item: "orders" }) });
    expect(h.load).toHaveBeenCalledTimes(1);
    expect(h.load).toHaveBeenCalledWith({ domainSlug: "payments", productSlug: "checkout", eventId: "ev1", tab: "preview", section: "channels", item: "orders" });
    expect(element.type).toBe(EventPage);
    expect(element.props).toEqual({ data });
  });

  it("hands an old ?tab alias to the loader untouched (the loader normalizes it)", async () => {
    h.load.mockResolvedValue({});
    await EventRoute({ params, searchParams: Promise.resolve({ tab: "editor" }) });
    expect(h.load).toHaveBeenCalledWith(expect.objectContaining({ tab: "editor" }));
  });

  it("ignores repeated query values and works without search params", async () => {
    h.load.mockResolvedValue({});
    await EventRoute({ params, searchParams: Promise.resolve({ tab: ["preview", "design"], section: ["servers", "channels"], item: ["a", "b"] }) });
    await EventRoute({ params });
    const none = { domainSlug: "payments", productSlug: "checkout", eventId: "ev1", tab: undefined, section: undefined, item: undefined };
    expect(h.load).toHaveBeenNthCalledWith(1, none);
    expect(h.load).toHaveBeenNthCalledWith(2, none);
  });

  it("is a 404 when the loader finds nothing (unknown id, another product's or tenant's event, a legacy document)", async () => {
    h.load.mockResolvedValue(null);
    await expect(EventRoute({ params })).rejects.toThrow("NEXT_NOT_FOUND");
  });

  it("has a loading state", () => {
    expect(Loading()).toBeTruthy();
  });
});
