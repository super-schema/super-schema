// @vitest-environment jsdom
import { cleanup, fireEvent, render, screen, within } from "@testing-library/react";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { LeftSidebar } from "@/components/layout/LeftSidebar";
import { assetHref } from "@/lib/navigation/asset-href";

const push = vi.fn();
const location = vi.hoisted(() => ({ pathname: "/schemas/payments", search: "" }));
vi.mock("next/navigation", () => ({
  usePathname: () => location.pathname,
  useRouter: () => ({ push }),
  useSearchParams: () => new URLSearchParams(location.search),
}));

const zeroCounts = { dataTypes: 0, apis: 0, entities: 0, traits: 0, messages: 0, channels: 0, eventSpecs: 0 };
const order = { id: "e1", name: "Order", slug: "order", status: "DRAFT" };
const tree = {
  enterprise: { counts: { dataTypes: 0, entities: 1, traits: 3 }, entities: [{ id: "e2", name: "Party", slug: "party", status: "DRAFT" }] },
  domains: [
    {
      id: "d1", name: "Payments", slug: "payments", isSystem: false,
      counts: { dataTypes: 0, apis: 0, traits: 1 },
      products: [
        {
          // Events: 2. The product-level traits / messages / channels counts are the old model's and must not surface any leaf.
          id: "p1", name: "Checkout", slug: "checkout", isSystem: false,
          counts: { ...zeroCounts, entities: 1, traits: 1, messages: 1, channels: 1, eventSpecs: 2 },
          entities: [order],
        },
        { id: "p2", name: "Ledger", slug: "ledger", isSystem: false, counts: { ...zeroCounts }, entities: [] },
        // Only old-model counts, no events: no Events leaf.
        { id: "p3", name: "Billing", slug: "billing", isSystem: false, counts: { ...zeroCounts, channels: 2, messages: 1, traits: 2 }, entities: [] },
        { id: "p4", name: "Shipping", slug: "shipping", isSystem: false, counts: { ...zeroCounts, eventSpecs: 1 }, entities: [] },
      ],
    },
  ],
};
vi.mock("@/hooks/useDomainsTree", () => ({
  useDomainsTree: () => ({ data: tree, isLoading: false, isError: false, refetch: vi.fn() }),
}));

const props = { width: 260, isCollapsed: false, onMouseDown: vi.fn(), onDoubleClick: vi.fn() };

function visit(pathname: string, search = "") {
  cleanup();
  location.pathname = pathname;
  location.search = search;
  render(<LeftSidebar {...props} />);
}
const active = (testId: string) => screen.getByTestId(testId).getAttribute("data-active");
const eventsList = (productSlug: string) => assetHref({ kind: "events", domainSlug: "payments", productSlug });
const eventPage = (productSlug: string, id: string) => assetHref({ kind: "event", id, domainSlug: "payments", productSlug });
const OLD_PRODUCT_LEAVES = ["event-specs", "messages", "channels", "traits"];

describe("LeftSidebar: one Events leaf per product", () => {
  beforeEach(() => {
    push.mockReset();
    location.pathname = "/schemas/payments";
    location.search = "";
  });
  afterEach(() => cleanup());

  it("shows an Events leaf, with the event count, for products that have events and hides it for those that do not", () => {
    render(<LeftSidebar {...props} />);
    const leaf = screen.getByTestId("product-p1-events");
    expect(leaf.textContent).toContain("Events");
    expect(within(leaf).getByText("2")).toBeDefined();
    expect(screen.getByTestId("product-p4-events").textContent).toContain("Events");
    expect(screen.queryByTestId("product-p2-events")).toBeNull();
    expect(screen.queryByTestId("product-p3-events")).toBeNull();
  });

  it("opens the product's Events tab through assetHref", () => {
    render(<LeftSidebar {...props} />);
    fireEvent.click(screen.getByTestId("product-p1-events"));
    expect(push).toHaveBeenLastCalledWith(eventsList("checkout"));
    expect(push).toHaveBeenLastCalledWith(expect.stringContaining("/schemas/payments/checkout?tab=events"));
    fireEvent.click(screen.getByTestId("product-p4-events"));
    expect(push).toHaveBeenLastCalledWith(eventsList("shipping"));
  });

  it("no longer has Event Specs, Messages, Channels or Traits leaves under any product", () => {
    render(<LeftSidebar {...props} />);
    for (const id of ["p1", "p2", "p3", "p4"]) {
      for (const old of OLD_PRODUCT_LEAVES) expect(screen.queryByTestId(`product-${id}-${old}`)).toBeNull();
    }
    expect(screen.queryByText("Event Specs")).toBeNull();
    expect(screen.queryByText("Messages")).toBeNull();
    expect(screen.queryByText("Channels")).toBeNull();
  });

  it("keeps the Traits leaves of the Domain and the Enterprise, which own the trait library", () => {
    render(<LeftSidebar {...props} />);
    fireEvent.click(screen.getByTestId("domain-d1-traits"));
    expect(push).toHaveBeenLastCalledWith(assetHref({ kind: "traits", domainSlug: "payments", productSlug: null }));
    expect(push).toHaveBeenLastCalledWith("/schemas/payments?tab=traits");
    fireEvent.click(screen.getByTestId("enterprise-traits"));
    expect(push).toHaveBeenLastCalledWith("/schemas/enterprise?tab=traits");
  });
});

describe("LeftSidebar: Events leaf highlighting", () => {
  afterEach(() => cleanup());

  it("is highlighted on the product's Events tab, whatever the old section param says", () => {
    visit("/schemas/payments/checkout", "tab=events");
    expect(active("product-p1-events")).toBe("true");
    visit("/schemas/payments/checkout", "tab=events&section=messages");
    expect(active("product-p1-events")).toBe("true");
    visit("/schemas/payments/checkout", "tab=events&section=bogus");
    expect(active("product-p1-events")).toBe("true");
  });

  it("is highlighted on an event page, with or without the page's own query", () => {
    visit(eventPage("checkout", "ev1"));
    expect(active("product-p1-events")).toBe("true");
    visit(eventPage("checkout", "ev1"), "tab=preview&section=channels&item=orders");
    expect(active("product-p1-events")).toBe("true");
    visit(eventPage("shipping", "ev2"));
    expect(active("product-p4-events")).toBe("true");
    expect(active("product-p1-events")).toBe("false");
  });

  it("is not highlighted on another tab of the product or on another product's Events tab", () => {
    visit("/schemas/payments/checkout", "tab=apis");
    expect(active("product-p1-events")).toBe("false");
    visit("/schemas/payments/checkout");
    expect(active("product-p1-events")).toBe("false");
    // A product's own retired tab does not light the Events leaf either.
    visit("/schemas/payments/checkout", "tab=traits");
    expect(active("product-p1-events")).toBe("false");
    visit("/schemas/payments/shipping", "tab=events");
    expect(active("product-p1-events")).toBe("false");
    expect(active("product-p4-events")).toBe("true");
  });

  it("highlights the Traits leaf of the Domain and the Enterprise on their trait pages, and no product leaf", () => {
    visit("/schemas/payments/traits/t1");
    expect(active("domain-d1-traits")).toBe("true");
    expect(active("product-p1-events")).toBe("false");
    visit("/schemas/enterprise/traits/t1");
    expect(active("enterprise-traits")).toBe("true");
    visit("/schemas/payments", "tab=traits");
    expect(active("domain-d1-traits")).toBe("true");
  });
});

describe("LeftSidebar: the Entities row", () => {
  afterEach(() => cleanup());

  it("is not highlighted on an event page, but is on an entity page", () => {
    visit(eventPage("checkout", "ev1"));
    expect(active("product-p1-entities")).toBe("false");
    visit("/schemas/payments/checkout/order");
    expect(active("product-p1-entities")).toBe("true");
    expect(active("entity-e1")).toBe("true");
    expect(active("product-p1-events")).toBe("false");
  });

  it("is not highlighted on a product-level trait URL (the old route redirects to the Events list)", () => {
    visit("/schemas/payments/checkout/traits/t1");
    expect(active("product-p1-entities")).toBe("false");
  });

  it("keeps the Enterprise rows: entities row on entity pages only, not on trait pages", () => {
    visit("/schemas/enterprise/traits/t1");
    expect(active("enterprise-entities")).toBe("false");
    visit("/schemas/enterprise/entities/party");
    expect(active("enterprise-entities")).toBe("true");
    expect(active("entity-e2")).toBe("true");
  });

  it("highlights the Enterprise Entities row on the explicit ?tab=entities URL the workspace writes, and no other row", () => {
    visit("/schemas/enterprise", "tab=entities");
    expect(active("enterprise-entities")).toBe("true");
    expect(active("enterprise-traits")).toBe("false");
    visit("/schemas/enterprise");
    expect(active("enterprise-entities")).toBe("true");
    visit("/schemas/enterprise", "tab=data-types");
    expect(active("enterprise-entities")).toBe("false");
    visit("/schemas/enterprise", "tab=traits");
    expect(active("enterprise-entities")).toBe("false");
  });
});
