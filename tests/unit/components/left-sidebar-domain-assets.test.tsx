/**
 * LeftSidebar explorer tests (Enterprise → Domain → Product).
 *
 * @vitest-environment jsdom
 */

import { cleanup, fireEvent, render, screen, within } from "@testing-library/react";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { LeftSidebar } from "@/components/layout/LeftSidebar";

const push = vi.fn();
const location = vi.hoisted(() => ({ pathname: "/schemas/payments", search: "" }));
vi.mock("next/navigation", () => ({
  usePathname: () => location.pathname,
  useRouter: () => ({ push }),
  useSearchParams: () => new URLSearchParams(location.search),
}));

// Wraps the real `useTransition` so tests can observe which navigations start
// a transition and hold the transition "pending" without real async routing.
const transition = vi.hoisted(() => ({ started: 0, forcePending: false }));
vi.mock("react", async (importOriginal) => {
  const actual = await importOriginal<typeof import("react")>();
  return {
    ...actual,
    useTransition: () => {
      const [pending, start] = actual.useTransition();
      const wrapped: typeof start = (callback) => {
        transition.started += 1;
        start(callback);
      };
      return [pending || transition.forcePending, wrapped] as const;
    },
  };
});

// Counts how many times the Order row renders (SidebarEntityRow reads `name` once per render).
const renders = vi.hoisted(() => ({ order: 0 }));
const orderEntity = vi.hoisted(() => {
  const entity = { id: "e1", slug: "order", status: "DRAFT" } as {
    id: string;
    slug: string;
    status: string;
    name: string;
  };
  Object.defineProperty(entity, "name", {
    enumerable: true,
    get() {
      renders.order += 1;
      return "Order";
    },
  });
  return entity;
});

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
          counts: { dataTypes: 3, apis: 0, entities: 1, traits: 0, events: 0 },
          entities: [orderEntity],
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
          counts: { dataTypes: 0, apis: 0, entities: 1, traits: 0, events: 0 },
          entities: [{ id: "e2", name: "Invoice", slug: "invoice", status: "ACTIVE" }],
        },
      ],
    },
    {
      id: "d3",
      name: "Fresh",
      slug: "fresh",
      isSystem: false,
      counts: { dataTypes: 0, apis: 0, traits: 0 },
      products: [],
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
    location.search = "";
    transition.started = 0;
    transition.forcePending = false;
    renders.order = 0;
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

  it("domain '+' creates an entity in the domain's first product", () => {
    render(<LeftSidebar {...props} />);
    fireEvent.click(within(screen.getByTestId("domain-d1")).getByTitle("New Entity"));
    expect(push).toHaveBeenCalledWith("/schemas/payments/checkout/new");
  });

  it("domain '+' for a domain with no products links to its Products tab instead of a 404", () => {
    render(<LeftSidebar {...props} />);
    const row = screen.getByTestId("domain-d3");
    expect(within(row).queryByTitle("New Entity")).toBeNull();
    fireEvent.click(within(row).getByTitle("Create a product first"));
    expect(push).toHaveBeenCalledWith("/schemas/fresh");
    expect(push).not.toHaveBeenCalledWith(expect.stringContaining("/default"));
  });

  it("uses the label Data Types, never Types", () => {
    render(<LeftSidebar {...props} />);
    expect(screen.queryByText(/^Types$/)).toBeNull();
    expect(screen.getAllByText("Data Types").length).toBeGreaterThan(0);
  });

  describe("navigation", () => {
    const entitiesRow = () => screen.getByTestId("product-p1-entities");

    it("keeps the Entities category expanded and navigates to the product when clicked", () => {
      location.pathname = "/schemas/payments";
      render(<LeftSidebar {...props} />);
      expect(screen.getByText("Order")).toBeDefined();

      fireEvent.click(entitiesRow());
      expect(screen.getByText("Order")).toBeDefined();
      expect(push).toHaveBeenCalledTimes(1);
      expect(push).toHaveBeenCalledWith("/schemas/payments/checkout");
    });

    it("collapses the Entities list only through its chevron, without navigating", () => {
      render(<LeftSidebar {...props} />);
      fireEvent.click(within(entitiesRow()).getByLabelText("Collapse Entities"));
      expect(screen.queryByText("Order")).toBeNull();
      expect(push).not.toHaveBeenCalled();

      fireEvent.click(within(entitiesRow()).getByLabelText("Expand Entities"));
      expect(screen.getByText("Order")).toBeDefined();
      expect(push).not.toHaveBeenCalled();
    });

    it("clicking a collapsed Entities category expands it and navigates", () => {
      render(<LeftSidebar {...props} />);
      fireEvent.click(within(entitiesRow()).getByLabelText("Collapse Entities"));
      expect(screen.queryByText("Order")).toBeNull();

      fireEvent.click(entitiesRow());
      expect(screen.getByText("Order")).toBeDefined();
      expect(push).toHaveBeenCalledWith("/schemas/payments/checkout");
    });

    it("never pushes the URL it is already on; it only ensures the node is expanded", () => {
      location.pathname = "/schemas/payments/checkout";
      render(<LeftSidebar {...props} />);

      // Entities category (href = product base) while on the product page.
      fireEvent.click(within(entitiesRow()).getByLabelText("Collapse Entities"));
      expect(screen.queryByText("Order")).toBeNull();
      fireEvent.click(entitiesRow());
      expect(screen.getByText("Order")).toBeDefined();
      expect(push).not.toHaveBeenCalled();

      // Product row label while on the product page.
      fireEvent.click(screen.getByLabelText("Collapse Checkout"));
      expect(screen.queryByTestId("product-p1-entities")).toBeNull();
      fireEvent.click(screen.getByText("Checkout"));
      expect(screen.getByTestId("product-p1-entities")).toBeDefined();
      expect(push).not.toHaveBeenCalled();

      // Entity row while on its own page.
      location.pathname = "/schemas/payments/checkout/order";
      cleanup();
      render(<LeftSidebar {...props} />);
      fireEvent.click(screen.getByText("Order"));
      expect(push).not.toHaveBeenCalled();
      expect(transition.started).toBe(0);
    });

    it("treats pathname plus query as the URL, so a leaf category is not re-pushed on its own tab", () => {
      location.pathname = "/schemas/payments/checkout";
      location.search = "tab=data-types";
      render(<LeftSidebar {...props} />);
      fireEvent.click(screen.getByTestId("product-p1-data-types"));
      expect(push).not.toHaveBeenCalled();

      location.search = "";
      cleanup();
      render(<LeftSidebar {...props} />);
      fireEvent.click(screen.getByTestId("product-p1-data-types"));
      expect(push).toHaveBeenCalledWith("/schemas/payments/checkout?tab=data-types");
    });

    it("starts a transition for every navigation that pushes", () => {
      render(<LeftSidebar {...props} />);
      fireEvent.click(screen.getByText("Order"));
      fireEvent.click(screen.getByTestId("enterprise-data-types"));
      fireEvent.click(within(screen.getByTestId("product-p1")).getByTitle("New Entity"));
      expect(push).toHaveBeenCalledTimes(3);
      expect(transition.started).toBe(3);
    });

    it("marks only the clicked row as pending while the transition is pending", () => {
      render(<LeftSidebar {...props} />);
      expect(screen.getByTestId("product-p1").getAttribute("data-pending")).toBe("false");

      transition.forcePending = true;
      fireEvent.click(screen.getByTestId("product-p1"));
      expect(screen.getByTestId("product-p1").getAttribute("data-pending")).toBe("true");
      expect(screen.getByTestId("product-p1").getAttribute("aria-busy")).toBe("true");
      expect(screen.getByTestId("domain-d1").getAttribute("data-pending")).toBe("false");
      expect(screen.getByTestId("entity-e1").getAttribute("data-pending")).toBe("false");

      fireEvent.click(screen.getByTestId("entity-e1"));
      expect(screen.getByTestId("entity-e1").getAttribute("data-pending")).toBe("true");
      expect(screen.getByTestId("product-p1").getAttribute("data-pending")).toBe("false");

      transition.forcePending = false;
      cleanup();
      render(<LeftSidebar {...props} />);
      fireEvent.click(screen.getByTestId("product-p1-data-types"));
      // The transition settled within the click's act(): nothing stays pending.
      expect(screen.getByTestId("product-p1-data-types").getAttribute("data-pending")).toBe("false");
    });

    it("does not mark a row pending when the click is a same-URL no-op", () => {
      location.pathname = "/schemas/payments/checkout";
      transition.forcePending = true;
      render(<LeftSidebar {...props} />);
      fireEvent.click(screen.getByTestId("product-p1"));
      expect(screen.getByTestId("product-p1").getAttribute("data-pending")).toBe("false");
    });

    it("does not re-render unaffected entity rows when only the pathname changes", () => {
      location.pathname = "/schemas/payments";
      const { rerender } = render(<LeftSidebar {...props} />);
      const before = renders.order;
      expect(before).toBeGreaterThan(0);

      location.pathname = "/schemas/payments/checkout";
      rerender(<LeftSidebar {...props} />);
      expect(renders.order).toBe(before);
      expect(screen.getByTestId("product-p1").getAttribute("data-active")).toBe("true");
    });
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
