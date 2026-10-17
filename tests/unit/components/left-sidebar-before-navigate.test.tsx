// @vitest-environment jsdom
// The explorer rows navigate with `router.push` from a click handler, which no link interception or history event can stop before Next has
// rendered the new route. So a row asks the page first (`canNavigate`): a page with unsaved work vetoes it and asks the user itself.
import { cleanup, fireEvent, render, screen, within } from "@testing-library/react";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { LeftSidebar } from "@/components/layout/LeftSidebar";
import { assetHref } from "@/lib/navigation/asset-href";
import { BEFORE_NAVIGATE_EVENT, beforeNavigateHref } from "@/lib/navigation/before-navigate";

const push = vi.fn();
const location = vi.hoisted(() => ({ pathname: "/schemas/payments", search: "" }));
vi.mock("next/navigation", () => ({
  usePathname: () => location.pathname,
  useRouter: () => ({ push }),
  useSearchParams: () => new URLSearchParams(location.search),
}));

const zeroCounts = { dataTypes: 0, apis: 0, entities: 0, traits: 0, events: 0 };
const tree = {
  enterprise: { counts: { dataTypes: 0, entities: 0, traits: 0 }, entities: [] },
  domains: [
    {
      id: "d1", name: "Payments", slug: "payments", isSystem: false, counts: { dataTypes: 0, apis: 0, traits: 0 },
      products: [{ id: "p1", name: "Checkout", slug: "checkout", isSystem: false, counts: { ...zeroCounts, events: 2 }, entities: [] }],
    },
  ],
};
vi.mock("@/hooks/useDomainsTree", () => ({
  useDomainsTree: () => ({ data: tree, isLoading: false, isError: false, refetch: vi.fn() }),
}));

const props = { width: 260, isCollapsed: false, onMouseDown: vi.fn(), onDoubleClick: vi.fn() };
const EVENTS_HREF = assetHref({ kind: "events", domainSlug: "payments", productSlug: "checkout" });

const asked: Array<string | null> = [];
let veto = false;
const listener = (e: Event) => {
  asked.push(beforeNavigateHref(e));
  if (veto) e.preventDefault();
};

beforeEach(() => {
  push.mockReset();
  asked.length = 0;
  veto = false;
  location.pathname = "/schemas/payments";
  location.search = "";
  document.addEventListener(BEFORE_NAVIGATE_EVENT, listener);
});
afterEach(() => {
  document.removeEventListener(BEFORE_NAVIGATE_EVENT, listener);
  cleanup();
});

describe("LeftSidebar: a page with unsaved work can veto a row's navigation", () => {
  it("asks the page where the row goes, then navigates when nobody objects", () => {
    render(<LeftSidebar {...props} />);
    fireEvent.click(screen.getByTestId("product-p1-events"));
    expect(asked).toEqual([EVENTS_HREF]);
    expect(push).toHaveBeenCalledTimes(1);
    expect(push).toHaveBeenCalledWith(EVENTS_HREF);
  });

  it("does not navigate when the page vetoes it", () => {
    veto = true;
    render(<LeftSidebar {...props} />);
    fireEvent.click(screen.getByTestId("product-p1-events"));
    expect(asked).toEqual([EVENTS_HREF]);
    expect(push).not.toHaveBeenCalled();
    expect(screen.getByTestId("product-p1-events").getAttribute("data-pending")).toBe("false"); // no spinner for a navigation that did not start
  });

  it("asks nothing for the row of the page the user is already on", () => {
    location.pathname = "/schemas/payments/checkout";
    location.search = "tab=events";
    render(<LeftSidebar {...props} />);
    fireEvent.click(screen.getByTestId("product-p1-events"));
    expect(asked).toEqual([]);
    expect(push).not.toHaveBeenCalled();
  });

  // A folder row expands AND navigates; a vetoed click does neither (the page stays, so nothing should change under the user's hand).
  describe("a folder row", () => {
    const expandButton = () => within(screen.getByTestId("domain-d1")).queryByRole("button", { name: "Expand Payments" });
    const collapseButton = () => within(screen.getByTestId("domain-d1")).queryByRole("button", { name: "Collapse Payments" });

    it("stays collapsed when the page vetoes the click", () => {
      location.pathname = "/schemas"; // not under the domain: collapsed to begin with
      veto = true;
      render(<LeftSidebar {...props} />);
      expect(expandButton()).not.toBeNull();
      fireEvent.click(screen.getByTestId("domain-d1"));

      expect(asked).toEqual(["/schemas/payments"]);
      expect(push).not.toHaveBeenCalled();
      expect(expandButton()).not.toBeNull();
      expect(collapseButton()).toBeNull();
    });

    it("expands and navigates when nobody objects", () => {
      location.pathname = "/schemas";
      render(<LeftSidebar {...props} />);
      fireEvent.click(screen.getByTestId("domain-d1"));

      expect(push).toHaveBeenCalledWith("/schemas/payments");
      expect(collapseButton()).not.toBeNull();
    });
  });
});
