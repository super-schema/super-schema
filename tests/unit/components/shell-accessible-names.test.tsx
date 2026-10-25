// @vitest-environment jsdom
import { afterEach, describe, expect, it, vi } from "vitest";
import { cleanup, render, screen, within } from "@testing-library/react";

// The shell's icon-only controls had no accessible name (axe: `link-name`, `button-name`): found by the accessibility scan of the browser suite
// (tests/e2e/a11y.spec.ts), fixed here and kept fixed by these tests as well as by the baseline.

const pathname = vi.hoisted(() => ({ value: "/schemas" }));
vi.mock("next/navigation", () => ({ usePathname: () => pathname.value, useRouter: () => ({ push: () => {} }) }));

import { ActivityBar } from "@/components/layout/ActivityBar";
import { RightPanel } from "@/components/layout/RightPanel";
import { ComplianceResultsTable } from "@/features/compliance/ComplianceResultsTable";
import { AuditTrailList } from "@/features/compliance/AuditTrailList";
import { DriftBadge } from "@/components/custom/DriftBadge/DriftBadge";

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

describe("the pagers of the compliance pages", () => {
  it("name their buttons: the table's and the audit trail's, each with a Previous and a Next page", () => {
    const common = { total: 120, page: 2, pageSize: 25, onPageChange: () => {}, loading: false };
    const { unmount } = render(<ComplianceResultsTable {...common} fields={[]} sortBy="entityName" sortOrder="asc" onSort={() => {}} />);
    expect(screen.getByRole("button", { name: "Previous page" })).toBeTruthy();
    expect(screen.getByRole("button", { name: "Next page" })).toBeTruthy();
    unmount();
    const entry = { id: "a1", action: "UPDATE", entityType: "Entity", entityId: "e1", entityName: "Customer", userId: "u1", userName: "Admin", userAvatar: null, timestamp: new Date(0), beforeState: null, afterState: null, changeSummary: "changed" };
    render(<AuditTrailList {...common} entries={[entry]} />);
    expect(screen.getByRole("button", { name: "Previous page" })).toBeTruthy();
    expect(screen.getByRole("button", { name: "Next page" })).toBeTruthy();
  });

  it("the table's scroll area is reachable by keyboard and named", () => {
    render(<ComplianceResultsTable total={0} page={1} pageSize={25} fields={[]} sortBy="entityName" sortOrder="asc" onSort={() => {}} onPageChange={() => {}} loading={false} />);
    const region = screen.getByRole("region", { name: "Compliance results" });
    expect(region.getAttribute("tabindex")).toBe("0");
  });
});

describe("DriftBadge", () => {
  it("the compact dot is a button with a name that says what it shows, with the format when there is one", () => {
    const { unmount } = render(<DriftBadge status="unknown" compact />);
    expect(screen.getByRole("button", { name: "Unknown" })).toBeTruthy();
    unmount();
    render(<DriftBadge status="drifted" targetFormat="avro" compact />);
    expect(screen.getByRole("button", { name: /^avro: / })).toBeTruthy();
  });
});
