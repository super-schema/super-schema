// @vitest-environment jsdom
import { afterEach, describe, expect, it, vi } from "vitest";
import { cleanup, fireEvent, render, screen, waitFor } from "@testing-library/react";
import { createLatestRequestGuard } from "@/lib/latest-request";

// The compliance page fetched again on every filter change and showed whichever answer arrived LAST: with two requests in flight, the slower
// (older) one replaced the newer one, and the Audit Trail showed the results of a filter that was no longer chosen (found by the browser suite
// under load: governance-compliance.spec.ts, the Audit Trail's type filter set to Domain and then Field).

vi.mock("next/navigation", () => ({ useRouter: () => ({ push: () => {} }), usePathname: () => "/compliance" }));

import CompliancePage from "@/app/(dashboard)/compliance/page";

afterEach(() => {
  cleanup();
  vi.unstubAllGlobals();
});

describe("createLatestRequestGuard", () => {
  it("lets only the answer to the latest request through", () => {
    const guard = createLatestRequestGuard();
    const first = guard.start();
    expect(first()).toBe(true);
    const second = guard.start();
    expect(first()).toBe(false);
    expect(second()).toBe(true);
    const third = guard.start();
    expect([first(), second(), third()]).toEqual([false, false, true]);
  });
});

/** A fetch whose answers to the audit trail are held until the test lets them go, in the order it chooses. */
function heldFetch() {
  const audit: Array<{ body: { filters: { entityType?: string } }; answer: (entries: unknown[]) => void }> = [];
  const fetchMock = vi.fn((url: string, init?: { body?: string }) => {
    if (url === "/api/domains-tree") return Promise.resolve(new Response(JSON.stringify({ domains: [] })));
    if (url === "/api/compliance/audit-trail") {
      return new Promise<Response>((resolve) => {
        audit.push({
          body: JSON.parse(init?.body ?? "{}"),
          answer: (entries) => resolve(new Response(JSON.stringify({ success: true, data: { entries, total: entries.length } }))),
        });
      });
    }
    return Promise.resolve(new Response(JSON.stringify({ success: true, data: { fields: [], total: 0, gaps: [], summary: { criticalCount: 0, warningCount: 0, affectedEntityCount: 0, countsByGapType: {} } } })));
  });
  vi.stubGlobal("fetch", fetchMock);
  return audit;
}

const entry = (id: string, type: string) => ({ id, action: "UPDATE", entityType: type, entityId: id, entityName: id, userId: "u", userName: "Admin", userAvatar: null, timestamp: new Date(0).toISOString(), beforeState: null, afterState: null, changeSummary: `changed ${id}` });

describe("the Audit Trail of the compliance page", () => {
  it("shows the answer to the filter that is chosen now, even when the answer to the one before it arrives after it", async () => {
    const audit = heldFetch();
    render(<CompliancePage />);
    fireEvent.click(screen.getByRole("button", { name: "Audit Trail" }));
    await waitFor(() => expect(audit.length).toBe(1)); // the tab's own first load: no filter
    fireEvent.change(screen.getByTestId("audit-filter-type"), { target: { value: "Domain" } });
    await waitFor(() => expect(audit.length).toBe(2));
    fireEvent.change(screen.getByTestId("audit-filter-type"), { target: { value: "Field" } });
    await waitFor(() => expect(audit.length).toBe(3));
    expect(audit.map((request) => request.body.filters.entityType)).toEqual([undefined, "Domain", "Field"]);

    // The newest answers first, then the older ones, in the worst order for a page that believes the last one to arrive.
    audit[2].answer([entry("field-row", "Field")]);
    await waitFor(() => expect(screen.getAllByTestId("audit-entry")).toHaveLength(1));
    audit[1].answer([]); // Domain: nothing
    audit[0].answer([entry("a", "Entity"), entry("b", "Entity")]); // no filter: two
    // Let the stale answers be processed.
    await Promise.resolve();
    await new Promise((resolve) => setTimeout(resolve, 20));
    expect(screen.getAllByTestId("audit-entry")).toHaveLength(1);
    expect(screen.getByTestId("audit-entry").getAttribute("data-entity-id")).toBe("field-row");
  });
});
