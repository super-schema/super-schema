/**
 * LeftSidebar explorer tests (Enterprise → Domain → Product).
 *
 * @vitest-environment jsdom
 */

import { cleanup, fireEvent, render, screen } from "@testing-library/react";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { LeftSidebar } from "@/components/layout/LeftSidebar";

const push = vi.fn();
const location = vi.hoisted(() => ({ pathname: "/schemas/payments" }));
vi.mock("next/navigation", () => ({
  usePathname: () => location.pathname,
  useRouter: () => ({ push }),
  useSearchParams: () => new URLSearchParams(""),
}));

const tree = {
  enterprise: {
    counts: { dataTypes: 2, entities: 1, traits: 0 },
    entities: [{ id: "e0", name: "Customer", slug: "customer", status: "ACTIVE" }],
  },
  domains: [
    {
      id: "d1",
      name: "Payments",
      slug: "payments",
      isSystem: false,
      counts: { dataTypes: 0, apis: 1, traits: 0 },
      products: [
        {
          id: "p1",
          name: "Checkout",
          slug: "checkout",
          isSystem: false,
          counts: { dataTypes: 3, apis: 0, entities: 1, traits: 0, messages: 0, channels: 0, eventSpecs: 0 },
          entities: [{ id: "e1", name: "Order", slug: "order", status: "DRAFT" }],
        },
      ],
    },
    {
      id: "d2",
      name: "Billing",
      slug: "billing",
      isSystem: false,
      counts: { dataTypes: 0, apis: 0, traits: 0 },
      products: [
        {
          id: "p2",
          name: "Ledger",
          slug: "ledger",
          isSystem: false,
          counts: { dataTypes: 0, apis: 0, entities: 1, traits: 0, messages: 0, channels: 0, eventSpecs: 0 },
          entities: [{ id: "e2", name: "Invoice", slug: "invoice", status: "ACTIVE" }],
        },
      ],
    },
  ],
};
vi.mock("@/hooks/useDomainsTree", () => ({
  useDomainsTree: () => ({ data: tree, isLoading: false, isError: false, refetch: vi.fn() }),
}));

const props = { width: 260, isCollapsed: false, onMouseDown: vi.fn(), onDoubleClick: vi.fn() };

describe("LeftSidebar", () => {
  beforeEach(() => {
    push.mockReset();
    location.pathname = "/schemas/payments";
  });
  afterEach(() => cleanup());

  it("renders Enterprise with its non-empty categories", () => {
    render(<LeftSidebar {...props} />);
    expect(screen.getByText("Enterprise")).toBeDefined();
    fireEvent.click(screen.getByTestId("enterprise-data-types"));
    expect(push).toHaveBeenCalledWith("/schemas/enterprise?tab=data-types");
  });

  it("hides empty domain categories and shows non-empty ones", () => {
    render(<LeftSidebar {...props} />);
    expect(screen.queryByTestId("domain-d1-data-types")).toBeNull();
    fireEvent.click(screen.getByTestId("domain-d1-apis"));
    expect(push).toHaveBeenCalledWith("/schemas/payments?tab=apis");
  });

  it("renders products with their categories and links entities canonically", () => {
    render(<LeftSidebar {...props} />);
    fireEvent.click(screen.getByText("Checkout"));
    expect(push).toHaveBeenCalledWith("/schemas/payments/checkout");
    expect(screen.queryByTestId("product-p1-apis")).toBeNull();
    fireEvent.click(screen.getByTestId("product-p1-data-types"));
    expect(push).toHaveBeenCalledWith("/schemas/payments/checkout?tab=data-types");
    fireEvent.click(screen.getByText("Order"));
    expect(push).toHaveBeenCalledWith("/schemas/payments/checkout/order");
  });

  it("uses the label Data Types, never Types", () => {
    render(<LeftSidebar {...props} />);
    expect(screen.queryByText(/^Types$/)).toBeNull();
    expect(screen.getAllByText("Data Types").length).toBeGreaterThan(0);
  });

  describe("search", () => {
    const filter = () => screen.getByPlaceholderText("Filter domains, entities...");

    it("expands collapsed nodes so a match in a non-active domain is visible and links canonically", () => {
      location.pathname = "/schemas";
      render(<LeftSidebar {...props} />);
      expect(screen.queryByText("Invoice")).toBeNull();

      fireEvent.change(filter(), { target: { value: "invoice" } });
      expect(screen.getByText("Invoice")).toBeDefined();
      expect(screen.queryByText("Order")).toBeNull();

      fireEvent.click(screen.getByText("Invoice"));
      expect(push).toHaveBeenCalledWith("/schemas/billing/ledger/invoice");
    });

    it("expands enterprise entities that match while the enterprise node was collapsed", () => {
      location.pathname = "/schemas";
      render(<LeftSidebar {...props} />);
      fireEvent.click(screen.getByLabelText("Collapse Enterprise"));
      expect(screen.queryByText("Customer")).toBeNull();

      fireEvent.change(filter(), { target: { value: "custom" } });
      expect(screen.getByText("Customer")).toBeDefined();
      fireEvent.click(screen.getByText("Customer"));
      expect(push).toHaveBeenCalledWith("/schemas/enterprise/entities/customer");
    });

    it("tracks chevron toggles made during a search separately and resets them when the query clears", () => {
      location.pathname = "/schemas";
      render(<LeftSidebar {...props} />);

      fireEvent.change(filter(), { target: { value: "invoice" } });
      fireEvent.click(screen.getByLabelText("Collapse Ledger"));
      expect(screen.queryByText("Invoice")).toBeNull();

      fireEvent.change(filter(), { target: { value: "" } });
      expect(screen.queryByText("Invoice")).toBeNull();
      // The browsing-state expansion was untouched by the search toggle.
      expect(screen.getByLabelText("Expand Billing")).toBeDefined();

      fireEvent.change(filter(), { target: { value: "invoice" } });
      expect(screen.getByText("Invoice")).toBeDefined();
    });
  });
});
