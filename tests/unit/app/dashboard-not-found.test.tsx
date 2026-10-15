// @vitest-environment jsdom
import { afterEach, describe, expect, it, vi } from "vitest";
import { cleanup, fireEvent, render, screen } from "@testing-library/react";
import { RightPanelContentProvider, useRightPanelContent } from "@/hooks/useRightPanelContent";
import { assetHref } from "@/lib/navigation/asset-href";
import DashboardNotFound from "@/app/(dashboard)/not-found";
import DashboardError from "@/app/(dashboard)/error";

afterEach(cleanup);

/** Stands in for the shell's right panel: reports whether the empty placeholder is hidden. */
function PanelProbe() {
  const { hideWhenEmpty } = useRightPanelContent();
  return <span data-testid="hide-empty">{String(hideWhenEmpty)}</span>;
}

describe("dashboard not-found (rendered inside the shell by every notFound())", () => {
  it("keeps the 404 markers tests/e2e/navigation.spec.ts detects, exactly once", () => {
    render(<DashboardNotFound />);
    const headings = screen.getAllByRole("heading", { level: 1 });
    expect(headings).toHaveLength(1);
    expect(headings[0].className).toContain("next-error-h1");
    expect(headings[0].textContent).toBe("This page could not be found.");
    // The e2e canary asserts a count of exactly 1 for both locators.
    expect(document.querySelectorAll("h1.next-error-h1")).toHaveLength(1);
    expect(screen.getAllByText(/This page could not be found/i)).toHaveLength(1);
  });

  it("links back to the domains list and Enterprise through the shared URL builder", () => {
    render(<DashboardNotFound />);
    expect(screen.getByRole("link", { name: "Domains" }).getAttribute("href")).toBe("/schemas");
    expect(screen.getByRole("link", { name: "Enterprise" }).getAttribute("href")).toBe(assetHref({ kind: "enterprise" }));
    expect(screen.getByRole("navigation", { name: "Where to go next" })).toBeDefined();
  });

  it("opts the page out of the empty right-panel placeholder while mounted", () => {
    const { unmount } = render(
      <RightPanelContentProvider>
        <PanelProbe />
        <DashboardNotFound />
      </RightPanelContentProvider>
    );
    expect(screen.getByTestId("hide-empty").textContent).toBe("true");
    unmount();
  });
});

describe("dashboard error boundary", () => {
  it("never shows the error text, offers retry and navigation, and surfaces only the digest", () => {
    const reset = vi.fn();
    const error = Object.assign(new Error("connect ECONNREFUSED 10.0.0.5:5432 password=hunter2"), { digest: "abc123" });
    render(<DashboardError error={error} reset={reset} />);
    expect(screen.getByRole("alert").textContent).not.toMatch(/ECONNREFUSED|hunter2|10\.0\.0\.5/);
    expect(screen.getByText("abc123")).toBeDefined();
    fireEvent.click(screen.getByRole("button", { name: "Try again" }));
    expect(reset).toHaveBeenCalledTimes(1);
    expect(screen.getByRole("link", { name: "Domains" }).getAttribute("href")).toBe("/schemas");
    expect(screen.getByRole("link", { name: "Enterprise" }).getAttribute("href")).toBe("/schemas/enterprise");
  });

  it("omits the reference line when there is no digest", () => {
    render(<DashboardError error={new Error("boom")} reset={() => {}} />);
    expect(screen.queryByText(/Reference:/)).toBeNull();
  });
});
