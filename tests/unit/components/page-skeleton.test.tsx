/**
 * @vitest-environment jsdom
 */
import { afterEach, describe, expect, it } from "vitest";
import { cleanup, render, screen } from "@testing-library/react";
import { PageSkeleton, type PageSkeletonVariant } from "@/components/layout/PageSkeleton";

afterEach(cleanup);

describe("PageSkeleton", () => {
  const variants: PageSkeletonVariant[] = ["grid", "workspace", "entity"];

  it.each(variants)("renders the %s variant as an accessible, busy placeholder", (variant) => {
    render(<PageSkeleton variant={variant} />);
    const root = screen.getByTestId("page-skeleton");
    expect(root.getAttribute("data-variant")).toBe(variant);
    expect(root.getAttribute("aria-busy")).toBe("true");
    expect(root.getAttribute("role")).toBe("status");
    expect(screen.getByText("Loading…")).toBeDefined();
    expect(root.querySelectorAll(".animate-pulse").length).toBeGreaterThan(0);
  });

  it("renders a card grid for the grid variant, tabs for workspace, and field rows for entity", () => {
    const { unmount } = render(<PageSkeleton variant="grid" />);
    expect(screen.getAllByTestId("skeleton-card").length).toBeGreaterThan(1);
    expect(screen.queryByTestId("skeleton-tabs")).toBeNull();
    unmount();

    const workspace = render(<PageSkeleton variant="workspace" />);
    expect(screen.getByTestId("skeleton-tabs")).toBeDefined();
    expect(screen.getAllByTestId("skeleton-card").length).toBeGreaterThan(1);
    workspace.unmount();

    render(<PageSkeleton variant="entity" />);
    expect(screen.getAllByTestId("skeleton-field-row").length).toBeGreaterThan(3);
    expect(screen.queryByTestId("skeleton-card")).toBeNull();
  });

  it("defaults to the workspace variant", () => {
    render(<PageSkeleton />);
    expect(screen.getByTestId("page-skeleton").getAttribute("data-variant")).toBe("workspace");
  });
});
