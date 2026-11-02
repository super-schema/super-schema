// @vitest-environment jsdom
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { cleanup, fireEvent, render, screen, waitFor } from "@testing-library/react";

// The Audit Trail's export is every entry the filters select: the server answers it, and the file is those rows, not the page on the screen.

vi.mock("next/navigation", () => ({ useRouter: () => ({ push: () => {} }), usePathname: () => "/compliance" }));

import CompliancePage from "@/app/(dashboard)/compliance/page";

const entry = (id: string) => ({
  id,
  action: "UPDATE",
  entityType: "Field",
  entityId: `fld-${id}`,
  entityName: null,
  userId: "u",
  userName: "Admin",
  userAvatar: null,
  timestamp: "2026-10-31T23:30:00.000Z",
  beforeState: null,
  afterState: null,
  changeSummary: `changed ${id}`,
});

let downloads: Array<{ name: string; blob: Blob }>;

beforeEach(() => {
  downloads = [];
  let lastBlob: Blob | undefined;
  URL.createObjectURL = vi.fn((blob: Blob) => {
    lastBlob = blob;
    return "blob:audit";
  });
  URL.revokeObjectURL = vi.fn();
  vi.spyOn(HTMLAnchorElement.prototype, "click").mockImplementation(function (this: HTMLAnchorElement) {
    downloads.push({ name: this.download, blob: lastBlob as Blob });
  });
});

afterEach(() => {
  cleanup();
  vi.restoreAllMocks();
  vi.unstubAllGlobals();
});

const readBlob = (blob: Blob) =>
  new Promise<string>((resolve, reject) => {
    const reader = new FileReader();
    reader.onload = () => resolve(String(reader.result));
    reader.onerror = () => reject(reader.error);
    reader.readAsText(blob);
  });

/** The page's requests: the list answers nothing (the page on the screen is empty); the export answers `exportAnswer`. */
function stubCompliance(exportAnswer: { status?: number; body: unknown }) {
  const exportRequests: unknown[] = [];
  vi.stubGlobal(
    "fetch",
    vi.fn((url: string, init?: { body?: string }) => {
      if (url === "/api/domains-tree") return Promise.resolve(new Response(JSON.stringify({ domains: [] })));
      if (url === "/api/compliance/audit-trail") {
        return Promise.resolve(new Response(JSON.stringify({ success: true, data: { entries: [], total: 0 } })));
      }
      if (url === "/api/compliance/audit-trail/export") {
        exportRequests.push(JSON.parse(init?.body ?? "{}"));
        return Promise.resolve(new Response(JSON.stringify(exportAnswer.body), { status: exportAnswer.status ?? 200 }));
      }
      return Promise.resolve(new Response(JSON.stringify({ success: true, data: { fields: [], total: 0 } })));
    })
  );
  return exportRequests;
}

async function openAuditExport(filterAction?: string) {
  render(<CompliancePage />);
  fireEvent.click(screen.getByRole("button", { name: "Audit Trail" }));
  await waitFor(() => expect(screen.getByTestId("audit-trail-view")).toBeTruthy());
  if (filterAction) fireEvent.change(screen.getByTestId("audit-filter-action"), { target: { value: filterAction } });
  fireEvent.click(screen.getByTestId("audit-export"));
}

describe("the Audit Trail's export", () => {
  it("sends the filters on the screen, and downloads every entry the server returns, with the header row", async () => {
    const requests = stubCompliance({ body: { success: true, data: { entries: [entry("a"), entry("b"), entry("c")], total: 3, truncated: false, limit: 10_000 } } });

    await openAuditExport("UPDATE");

    await waitFor(() => expect(downloads).toHaveLength(1));
    expect(requests).toEqual([{ filters: { actionTypes: ["UPDATE"] } }]);
    expect(downloads[0].name).toMatch(/^audit-trail-\d{4}-\d{2}-\d{2}\.csv$/);
    const lines = (await readBlob(downloads[0].blob)).split("\n");
    expect(lines[0]).toBe("Timestamp,User,Action,Entity Type,Entity ID,Change Summary");
    expect(lines).toHaveLength(4);
    expect(lines[1]).toBe('"2026-10-31T23:30:00.000Z","Admin","UPDATE","Field","fld-a","changed a"');
    expect(screen.queryByTestId("compliance-export-notice")).toBeNull();
  });

  it("says so when the export was cut short, with the number that matched", async () => {
    stubCompliance({ body: { success: true, data: { entries: [entry("a")], total: 12_001, truncated: true, limit: 10_000 } } });

    await openAuditExport();

    const notice = await screen.findByTestId("compliance-export-notice");
    expect(notice.textContent).toBe("Only the first 10,000 of 12,001 matching audit entries were exported. Narrow the filters to export the rest.");
    expect(downloads).toHaveLength(1);
  });

  it("a refused export downloads nothing and the page says why", async () => {
    stubCompliance({ status: 403, body: { success: false, error: "You do not have permission to do this" } });

    await openAuditExport();

    expect(await screen.findByTestId("compliance-error")).toBeTruthy();
    expect(screen.getByTestId("compliance-error").textContent).toBe("You do not have permission to do this");
    expect(downloads).toHaveLength(0);
  });

  it("the Export button is off while the export is made, so a second click sends nothing", async () => {
    let answer: (res: Response) => void = () => undefined;
    const exportRequests: unknown[] = [];
    vi.stubGlobal(
      "fetch",
      vi.fn((url: string, init?: { body?: string }) => {
        if (url === "/api/domains-tree") return Promise.resolve(new Response(JSON.stringify({ domains: [] })));
        if (url === "/api/compliance/audit-trail") return Promise.resolve(new Response(JSON.stringify({ success: true, data: { entries: [], total: 0 } })));
        if (url === "/api/compliance/audit-trail/export") {
          exportRequests.push(JSON.parse(init?.body ?? "{}"));
          return new Promise<Response>((resolve) => {
            answer = resolve;
          });
        }
        return Promise.resolve(new Response(JSON.stringify({ success: true, data: { fields: [], total: 0 } })));
      })
    );
    render(<CompliancePage />);
    fireEvent.click(screen.getByRole("button", { name: "Audit Trail" }));
    await waitFor(() => expect(screen.getByTestId("audit-trail-view")).toBeTruthy());

    fireEvent.click(screen.getByTestId("audit-export"));
    await waitFor(() => expect((screen.getByTestId("audit-export") as HTMLButtonElement).disabled).toBe(true));
    fireEvent.click(screen.getByTestId("audit-export"));
    expect(exportRequests).toHaveLength(1);

    answer(new Response(JSON.stringify({ success: true, data: { entries: [entry("a")], total: 1, truncated: false } })));
    await waitFor(() => expect(downloads).toHaveLength(1));
    expect((screen.getByTestId("audit-export") as HTMLButtonElement).disabled).toBe(false);
  });

  it("the notice of a cut-short export is not left on another tab", async () => {
    stubCompliance({ body: { success: true, data: { entries: [entry("a")], total: 12_001, truncated: true, limit: 10_000 } } });
    await openAuditExport();
    await screen.findByTestId("compliance-export-notice");

    fireEvent.click(screen.getByRole("button", { name: "Query" }));

    expect(screen.queryByTestId("compliance-export-notice")).toBeNull();
  });
});
