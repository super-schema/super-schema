import { beforeEach, describe, expect, it, vi } from "vitest";

// `redirect` of next/navigation never returns: it throws. The mock throws an error that names the target, so a test can read it.
const h = vi.hoisted(() => ({
  redirect: vi.fn((url: string): never => {
    throw new Error(`NEXT_REDIRECT:${url}`);
  }),
  notFound: vi.fn((): never => {
    throw new Error("NEXT_NOT_FOUND");
  }),
  loadEventSpecPage: vi.fn(),
  loadMessagePage: vi.fn(),
  loadChannelPage: vi.fn(),
  loadTraitPage: vi.fn(),
}));
vi.mock("next/navigation", () => ({ redirect: h.redirect, notFound: h.notFound }));
// The old loaders must not run any more: a redirect never reads the old data.
vi.mock("@/features/events/event-specs/load-event-spec-page", () => ({ loadEventSpecPage: h.loadEventSpecPage }));
vi.mock("@/features/events/messages/load-message-page", () => ({ loadMessagePage: h.loadMessagePage }));
vi.mock("@/features/events/channels/load-channel-page", () => ({ loadChannelPage: h.loadChannelPage }));
vi.mock("@/features/events/traits/load-trait-page", () => ({ loadTraitPage: h.loadTraitPage }));

import EventSpecRedirect from "@/app/(dashboard)/schemas/[domainSlug]/[productSlug]/specs/[specId]/page";
import MessageRedirect from "@/app/(dashboard)/schemas/[domainSlug]/[productSlug]/messages/[messageId]/page";
import ChannelRedirect from "@/app/(dashboard)/schemas/[domainSlug]/[productSlug]/channels/[channelId]/page";
import ProductTraitRedirect from "@/app/(dashboard)/schemas/[domainSlug]/[productSlug]/traits/[traitId]/page";
import { assetHref } from "@/lib/navigation/asset-href";

const at = { domainSlug: "payments", productSlug: "checkout" };
const EVENTS_LIST = "/schemas/payments/checkout?tab=events";

/** Runs a route and returns the URL it redirected to; fails when the route returned or threw something else. */
async function redirectedTo(run: () => Promise<unknown>): Promise<string> {
  let thrown: unknown;
  try {
    await run();
  } catch (error) {
    thrown = error;
  }
  expect(thrown, "the route should redirect, not return").toBeInstanceOf(Error);
  const match = /^NEXT_REDIRECT:(.*)$/.exec((thrown as Error).message);
  expect(match, `the route threw ${(thrown as Error).message}, not a redirect`).not.toBeNull();
  return match![1];
}

beforeEach(() => vi.clearAllMocks());

describe("old event spec route /specs/[specId]", () => {
  it("redirects to the event page with the same id", async () => {
    const url = await redirectedTo(() => EventSpecRedirect({ params: Promise.resolve({ ...at, specId: "s1" }) }));
    expect(url).toBe("/schemas/payments/checkout/events/s1");
    expect(url).toBe(assetHref({ kind: "event", id: "s1", ...at }));
    expect(h.redirect).toHaveBeenCalledTimes(1);
    expect(h.redirect).toHaveBeenCalledWith("/schemas/payments/checkout/events/s1");
  });

  it("encodes the id and the slugs the same way assetHref does", async () => {
    const url = await redirectedTo(() => EventSpecRedirect({ params: Promise.resolve({ domainSlug: "pay ments", productSlug: "check out", specId: "a b/c" }) }));
    expect(url).toBe("/schemas/pay%20ments/check%20out/events/a%20b%2Fc");
  });

  it("does not carry the old ?version / ?tab (the event page has neither)", async () => {
    const url = await redirectedTo(() =>
      EventSpecRedirect({ params: Promise.resolve({ ...at, specId: "s1" }), searchParams: Promise.resolve({ version: "1.3", tab: "preview" }) } as never)
    );
    expect(url).toBe("/schemas/payments/checkout/events/s1");
  });

  it("never reads the old event spec", async () => {
    await redirectedTo(() => EventSpecRedirect({ params: Promise.resolve({ ...at, specId: "s1" }) }));
    expect(h.loadEventSpecPage).not.toHaveBeenCalled();
    expect(h.notFound).not.toHaveBeenCalled();
  });
});

describe("old message route /messages/[messageId]", () => {
  it("redirects to the Events list", async () => {
    const url = await redirectedTo(() => MessageRedirect({ params: Promise.resolve({ ...at, messageId: "m1" }) }));
    expect(url).toBe(EVENTS_LIST);
    expect(url).toBe(assetHref({ kind: "events", ...at }));
    expect(h.redirect).toHaveBeenCalledTimes(1);
    expect(h.redirect).toHaveBeenCalledWith(EVENTS_LIST);
  });

  it("neither keeps the message id nor a section, and never reads the old message", async () => {
    const url = await redirectedTo(() => MessageRedirect({ params: Promise.resolve({ ...at, messageId: "m1" }) }));
    expect(url).not.toContain("m1");
    expect(url).not.toContain("section=");
    expect(h.loadMessagePage).not.toHaveBeenCalled();
  });

  it("encodes the slugs", async () => {
    const url = await redirectedTo(() => MessageRedirect({ params: Promise.resolve({ domainSlug: "pay ments", productSlug: "check out", messageId: "m1" }) }));
    expect(url).toBe("/schemas/pay%20ments/check%20out?tab=events");
  });
});

describe("old channel route /channels/[channelId]", () => {
  it("redirects to the Events list", async () => {
    const url = await redirectedTo(() => ChannelRedirect({ params: Promise.resolve({ ...at, channelId: "c1" }) }));
    expect(url).toBe(EVENTS_LIST);
    expect(url).toBe(assetHref({ kind: "events", ...at }));
    expect(h.redirect).toHaveBeenCalledTimes(1);
    expect(h.redirect).toHaveBeenCalledWith(EVENTS_LIST);
  });

  it("neither keeps the channel id nor a section, and never reads the old channel", async () => {
    const url = await redirectedTo(() => ChannelRedirect({ params: Promise.resolve({ ...at, channelId: "c1" }) }));
    expect(url).not.toContain("c1");
    expect(url).not.toContain("section=");
    expect(h.loadChannelPage).not.toHaveBeenCalled();
  });

  it("encodes the slugs", async () => {
    const url = await redirectedTo(() => ChannelRedirect({ params: Promise.resolve({ domainSlug: "pay ments", productSlug: "check out", channelId: "c1" }) }));
    expect(url).toBe("/schemas/pay%20ments/check%20out?tab=events");
  });
});

describe("old product trait route /traits/[traitId]", () => {
  it("redirects to the Events list", async () => {
    const url = await redirectedTo(() => ProductTraitRedirect({ params: Promise.resolve({ ...at, traitId: "t3" }) }));
    expect(url).toBe(EVENTS_LIST);
    expect(url).toBe(assetHref({ kind: "events", ...at }));
    expect(h.redirect).toHaveBeenCalledTimes(1);
    expect(h.redirect).toHaveBeenCalledWith(EVENTS_LIST);
  });

  it("neither keeps the trait id nor a section, and never reads the trait", async () => {
    const url = await redirectedTo(() => ProductTraitRedirect({ params: Promise.resolve({ ...at, traitId: "t3" }) }));
    expect(url).not.toContain("t3");
    expect(url).not.toContain("section=");
    expect(h.loadTraitPage).not.toHaveBeenCalled();
  });

  it("encodes the slugs", async () => {
    const url = await redirectedTo(() => ProductTraitRedirect({ params: Promise.resolve({ domainSlug: "pay ments", productSlug: "check out", traitId: "t3" }) }));
    expect(url).toBe("/schemas/pay%20ments/check%20out?tab=events");
  });
});
