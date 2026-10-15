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

const tree = {
  enterprise: { counts: { dataTypes: 0, entities: 0, traits: 3 }, entities: [] },
  domains: [
    {
      id: "d1", name: "Payments", slug: "payments", isSystem: false,
      counts: { dataTypes: 0, apis: 0, traits: 1 },
      products: [
        {
          id: "p1", name: "Checkout", slug: "checkout", isSystem: false,
          counts: { dataTypes: 0, apis: 0, entities: 0, traits: 1, messages: 1, channels: 0, eventSpecs: 2 },
          entities: [],
        },
        {
          id: "p2", name: "Ledger", slug: "ledger", isSystem: false,
          counts: { dataTypes: 0, apis: 0, entities: 0, traits: 0, messages: 0, channels: 0, eventSpecs: 0 },
          entities: [],
        },
      ],
    },
  ],
};
vi.mock("@/hooks/useDomainsTree", () => ({
  useDomainsTree: () => ({ data: tree, isLoading: false, isError: false, refetch: vi.fn() }),
}));

const props = { width: 260, isCollapsed: false, onMouseDown: vi.fn(), onDoubleClick: vi.fn() };

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
});
