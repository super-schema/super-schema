import { beforeEach, describe, expect, it, vi } from "vitest";

const h = vi.hoisted(() => ({ load: vi.fn() }));
vi.mock("next/navigation", () => ({
  notFound: () => {
    throw new Error("NEXT_NOT_FOUND");
  },
}));
vi.mock("@/features/events/messages/load-message-page", () => ({ loadMessagePage: h.load }));
vi.mock("@/features/events/messages/MessagePage", () => ({ MessagePage: () => null }));

import MessageRoute from "@/app/(dashboard)/schemas/[domainSlug]/[productSlug]/messages/[messageId]/page";
import { MessagePage } from "@/features/events/messages/MessagePage";

const params = Promise.resolve({ domainSlug: "payments", productSlug: "checkout", messageId: "m1" });

beforeEach(() => vi.clearAllMocks());

describe("message route", () => {
  it("loads by route params and the ?version string, then renders the page with the loaded data", async () => {
    h.load.mockResolvedValue({ marker: "data" });
    const element = await MessageRoute({ params, searchParams: Promise.resolve({ version: "1.3" }) });
    expect(h.load).toHaveBeenCalledWith({ domainSlug: "payments", productSlug: "checkout", messageId: "m1", version: "1.3" });
    expect(element.type).toBe(MessagePage);
    expect(element.props).toEqual({ marker: "data" });
  });

  it("ignores a repeated ?version and works without search params", async () => {
    h.load.mockResolvedValue({});
    await MessageRoute({ params, searchParams: Promise.resolve({ version: ["1.0", "2.0"] }) });
    await MessageRoute({ params });
    expect(h.load).toHaveBeenNthCalledWith(1, { domainSlug: "payments", productSlug: "checkout", messageId: "m1", version: undefined });
    expect(h.load).toHaveBeenNthCalledWith(2, { domainSlug: "payments", productSlug: "checkout", messageId: "m1", version: undefined });
  });

  it("is a 404 when the loader finds nothing", async () => {
    h.load.mockResolvedValue(null);
    await expect(MessageRoute({ params })).rejects.toThrow("NEXT_NOT_FOUND");
  });
});
