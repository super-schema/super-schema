// @vitest-environment jsdom
import { cleanup, fireEvent, render, screen } from "@testing-library/react";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { LeftSidebar } from "@/components/layout/LeftSidebar";

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
          id: "p1", name: "Checkout", slug: "checkout", isSystem: false,
          counts: { ...zeroCounts, entities: 1, traits: 1, messages: 1, eventSpecs: 2 },
          entities: [order],
        },
        { id: "p2", name: "Ledger", slug: "ledger", isSystem: false, counts: { ...zeroCounts }, entities: [] },
        { id: "p3", name: "Billing", slug: "billing", isSystem: false, counts: { ...zeroCounts, channels: 2 }, entities: [] },
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

describe("LeftSidebar — events leaves (spec §4.6)", () => {
  beforeEach(() => {
    push.mockReset();
    location.pathname = "/schemas/payments";
    location.search = "";
  });
  afterEach(() => cleanup());

  it("shows non-empty Event Specs / Messages / Traits leaves and hides empty ones", () => {
    render(<LeftSidebar {...props} />);
    expect(screen.queryByTestId("product-p1-channels")).toBeNull();
    expect(screen.queryByTestId("product-p2-event-specs")).toBeNull();
    expect(screen.queryByTestId("product-p2-traits")).toBeNull();
    fireEvent.click(screen.getByTestId("product-p1-event-specs"));
    expect(push).toHaveBeenLastCalledWith("/schemas/payments/checkout?tab=events&section=specs");
    fireEvent.click(screen.getByTestId("product-p1-messages"));
    expect(push).toHaveBeenLastCalledWith("/schemas/payments/checkout?tab=events&section=messages");
    fireEvent.click(screen.getByTestId("product-p1-traits"));
    expect(push).toHaveBeenLastCalledWith("/schemas/payments/checkout?tab=traits");
  });

  it("shows the Channels leaf when the product has channels and opens the channels section", () => {
    render(<LeftSidebar {...props} />);
    expect(screen.queryByTestId("product-p3-event-specs")).toBeNull();
    expect(screen.queryByTestId("product-p3-messages")).toBeNull();
    fireEvent.click(screen.getByTestId("product-p3-channels"));
    expect(push).toHaveBeenLastCalledWith("/schemas/payments/billing?tab=events&section=channels");
  });

  it("shows Traits under the domain and the Enterprise", () => {
    render(<LeftSidebar {...props} />);
    fireEvent.click(screen.getByTestId("domain-d1-traits"));
    expect(push).toHaveBeenLastCalledWith("/schemas/payments?tab=traits");
    fireEvent.click(screen.getByTestId("enterprise-traits"));
    expect(push).toHaveBeenLastCalledWith("/schemas/enterprise?tab=traits");
  });

  it("highlights the leaf of the open detail page and of the selected section", () => {
    location.pathname = "/schemas/payments/checkout/messages/m1";
    render(<LeftSidebar {...props} />);
    expect(screen.getByTestId("product-p1-messages").getAttribute("data-active")).toBe("true");
    expect(screen.getByTestId("product-p1-event-specs").getAttribute("data-active")).toBe("false");
    cleanup();
    location.pathname = "/schemas/payments/checkout";
    location.search = "tab=events&section=specs";
    render(<LeftSidebar {...props} />);
    expect(screen.getByTestId("product-p1-event-specs").getAttribute("data-active")).toBe("true");
  });

  it("highlights the Event Specs leaf on a spec detail page and the Channels leaf on a channel detail page", () => {
    visit("/schemas/payments/checkout/specs/s1", "version=2.0");
    expect(active("product-p1-event-specs")).toBe("true");
    expect(active("product-p1-messages")).toBe("false");
    expect(active("product-p1-traits")).toBe("false");
    visit("/schemas/payments/billing/channels/c1");
    expect(active("product-p3-channels")).toBe("true");
  });

  it("highlights the selected section of the product Events tab, defaulting an unknown or missing section to specs", () => {
    visit("/schemas/payments/billing", "tab=events&section=channels");
    expect(active("product-p3-channels")).toBe("true");
    visit("/schemas/payments/checkout", "tab=events&section=messages");
    expect(active("product-p1-messages")).toBe("true");
    expect(active("product-p1-event-specs")).toBe("false");
    visit("/schemas/payments/checkout", "tab=events");
    expect(active("product-p1-event-specs")).toBe("true");
    visit("/schemas/payments/checkout", "tab=events&section=bogus");
    expect(active("product-p1-event-specs")).toBe("true");
    expect(active("product-p1-messages")).toBe("false");
    // The Events tab selection never lights a leaf of another tab.
    visit("/schemas/payments/checkout", "tab=traits");
    expect(active("product-p1-traits")).toBe("true");
    expect(active("product-p1-event-specs")).toBe("false");
  });

  it("highlights the Traits leaf of the level whose trait detail page is open", () => {
    visit("/schemas/payments/checkout/traits/t1");
    expect(active("product-p1-traits")).toBe("true");
    expect(active("domain-d1-traits")).toBe("false");
    visit("/schemas/payments/traits/t1");
    expect(active("domain-d1-traits")).toBe("true");
    expect(active("product-p1-traits")).toBe("false");
    visit("/schemas/enterprise/traits/t1");
    expect(active("enterprise-traits")).toBe("true");
    visit("/schemas/payments", "tab=traits");
    expect(active("domain-d1-traits")).toBe("true");
  });

  it("does not highlight the Entities row on events or trait detail pages, but does on an entity page", () => {
    visit("/schemas/payments/checkout/messages/m1");
    expect(active("product-p1-entities")).toBe("false");
    visit("/schemas/payments/checkout/specs/s1");
    expect(active("product-p1-entities")).toBe("false");
    visit("/schemas/payments/checkout/traits/t1");
    expect(active("product-p1-entities")).toBe("false");
    visit("/schemas/payments/checkout/order");
    expect(active("product-p1-entities")).toBe("true");
    expect(active("entity-e1")).toBe("true");

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
