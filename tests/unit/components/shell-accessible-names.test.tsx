// @vitest-environment jsdom
import { afterEach, describe, expect, it, vi } from "vitest";
import { cleanup, render, screen, within } from "@testing-library/react";

// The shell's icon-only controls had no accessible name (axe: `link-name`, `button-name`): found by the accessibility scan of the browser suite
// (tests/e2e/a11y.spec.ts), fixed here and kept fixed by these tests as well as by the baseline.

const pathname = vi.hoisted(() => ({ value: "/schemas" }));
vi.mock("next/navigation", () => ({ usePathname: () => pathname.value }));

import { ActivityBar } from "@/components/layout/ActivityBar";
import { RightPanel } from "@/components/layout/RightPanel";

afterEach(cleanup);

const LABELS: Record<string, string> = {
  "nav-schemas": "Schema Editor",
  "nav-glossary": "Glossary",
  "nav-lineage": "Lineage Graph",
  "nav-governance": "Governance",
  "nav-compliance": "Compliance",
  "nav-deployments": "Deployments",
  "nav-admin": "Admin",
};

describe("ActivityBar", () => {
  it("is a named navigation landmark, and each of its icon-only links has the name its tooltip shows", () => {
    pathname.value = "/glossary";
    render(<ActivityBar />);
    const nav = screen.getByRole("navigation", { name: "Main navigation" });
    expect(within(nav).getAllByRole("link")).toHaveLength(Object.keys(LABELS).length);
    for (const [testId, label] of Object.entries(LABELS)) {
      expect(within(nav).getByRole("link", { name: label }).getAttribute("data-testid")).toBe(testId);
    }
  });

  it("marks the link of the page the user is on as the current one, and only that link", () => {
    pathname.value = "/schemas/some-domain/some-product";
    render(<ActivityBar />);
    const current = screen.getAllByRole("link").filter((link) => link.getAttribute("aria-current") === "page");
    expect(current.map((link) => link.getAttribute("data-testid"))).toEqual(["nav-schemas"]);
  });
});

describe("RightPanel", () => {
  const props = { width: 320, isCollapsed: false, onMouseDown: () => {}, onDoubleClick: () => {}, onCollapse: () => {} };

  it("names its close button, with content and with the placeholder", () => {
    const { unmount } = render(<RightPanel {...props}>content</RightPanel>);
    expect(screen.getByRole("button", { name: "Close panel" })).toBeTruthy();
    unmount();
    render(<RightPanel {...props} />);
    expect(screen.getByRole("button", { name: "Close panel" })).toBeTruthy();
  });
});
