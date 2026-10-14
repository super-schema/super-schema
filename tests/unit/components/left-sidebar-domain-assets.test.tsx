/**
 * LeftSidebar explorer tests (Enterprise → Domain → Product).
 *
 * @vitest-environment jsdom
 */

import { cleanup, fireEvent, render, screen } from "@testing-library/react";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { LeftSidebar } from "@/components/layout/LeftSidebar";

const push = vi.fn();
vi.mock("next/navigation", () => ({
  usePathname: () => "/schemas/payments",
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
  ],
};
vi.mock("@/hooks/useDomainsTree", () => ({
  useDomainsTree: () => ({ data: tree, isLoading: false, isError: false, refetch: vi.fn() }),
}));

const props = { width: 260, isCollapsed: false, onMouseDown: vi.fn(), onDoubleClick: vi.fn() };

describe("LeftSidebar", () => {
  beforeEach(() => push.mockReset());
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
});
