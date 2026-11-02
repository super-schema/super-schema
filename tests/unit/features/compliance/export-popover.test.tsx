// @vitest-environment jsdom
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { cleanup, fireEvent, render, screen, waitFor } from "@testing-library/react";
import { ComplianceExportPopover } from "@/features/compliance/ComplianceExportPopover";
import type { ComplianceFieldResult, ComplianceGap } from "@/types/schemas/compliance";

// The Query tab's export is every field the filters select, fetched on the server: the page on the screen is not what goes out. A cut-short export
// says so, in the dialog, with the number that matched.

const field = (id: string): ComplianceFieldResult => ({
  entityId: "ent-1",
  entityName: "Customer",
  fieldId: id,
  fieldName: `field_${id}`,
  fieldType: "string",
  classification: "PII",
  retention: null,
  anonymization: null,
  encryption: null,
  targetSystems: [],
  domain: "Commerce",
  domainId: "dom-1",
  domainSlug: "commerce",
  productSlug: "orders",
});

let downloads: Array<{ name: string; blob: Blob }>;
let fetchMock: ReturnType<typeof vi.fn>;

beforeEach(() => {
  downloads = [];
  // jsdom has no object URLs and no downloads: a download is recorded with the blob it would have saved.
  let lastBlob: Blob | undefined;
  URL.createObjectURL = vi.fn((blob: Blob) => {
    lastBlob = blob;
    return "blob:compliance";
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

function answerWith(body: unknown, status = 200) {
  fetchMock = vi.fn(async () => new Response(JSON.stringify(body), { status }));
  vi.stubGlobal("fetch", fetchMock);
}

function openAndChoose(format: "CSV" | "JSON") {
  fireEvent.click(screen.getByRole("button", { name: /^Export$/ }));
  fireEvent.click(screen.getByRole("button", { name: new RegExp(`^${format}`) }));
}

describe("the Query tab's export", () => {
  it("asks the server for every field the filters select, in the sort of the list, and downloads them all", async () => {
    answerWith({ success: true, data: { fields: [field("1"), field("2"), field("3")], total: 3, truncated: false, limit: 10_000 } });
    render(
      <ComplianceExportPopover
        filters={{ classifications: ["PII"] }}
        sortBy="fieldName"
        sortOrder="desc"
        activeTab="query"
      />
    );

    openAndChoose("CSV");

    await waitFor(() => expect(downloads).toHaveLength(1));
    expect(fetchMock).toHaveBeenCalledWith(
      "/api/compliance/query/export",
      expect.objectContaining({ method: "POST", body: JSON.stringify({ filters: { classifications: ["PII"] }, sort: { sortBy: "fieldName", sortOrder: "desc" } }) })
    );
    expect(downloads[0].name).toMatch(/^compliance-report-\d{4}-\d{2}-\d{2}-pii\.csv$/);
    const lines = (await readBlob(downloads[0].blob)).split("\n");
    expect(lines).toHaveLength(4);
    expect(screen.queryByTestId("compliance-export-notice")).toBeNull();
  });

  it("says so, with the number that matched, when the export was cut short", async () => {
    answerWith({ success: true, data: { fields: [field("1")], total: 12_001, truncated: true, limit: 10_000 } });
    render(<ComplianceExportPopover filters={{}} sortBy="entityName" sortOrder="asc" activeTab="query" />);

    openAndChoose("JSON");

    const notice = await screen.findByTestId("compliance-export-notice");
    expect(notice.getAttribute("role")).toBe("status");
    expect(notice.textContent).toBe("Only the first 10,000 of 12,001 matching fields were exported. Narrow the filters to export the rest.");
    expect(downloads[0].name).toMatch(/^compliance-report-\d{4}-\d{2}-\d{2}\.json$/);
  });

  it("a refused or failed export downloads nothing and says why", async () => {
    answerWith({ success: false, error: "Not authenticated" }, 401);
    render(<ComplianceExportPopover filters={{}} sortBy="entityName" sortOrder="asc" activeTab="query" />);

    openAndChoose("CSV");

    const notice = await screen.findByTestId("compliance-export-notice");
    expect(notice.getAttribute("role")).toBe("alert");
    expect(notice.textContent).toBe("Not authenticated");
    expect(downloads).toHaveLength(0);
  });
});

describe("the Gaps tab's export", () => {
  it("is the gaps the tab holds: written here, without a request", async () => {
    answerWith({ success: true, data: { fields: [], total: 0, truncated: false } });
    const gaps: ComplianceGap[] = [
      {
        entityId: "ent-1",
        entityName: "Customer",
        domainSlug: "commerce",
        productSlug: "orders",
        fieldId: "fld-1",
        fieldName: "notes",
        gapType: "UNCLASSIFIED",
        severity: "CRITICAL",
        suggestedFix: "Add classification to field",
      },
    ];
    render(<ComplianceExportPopover gaps={gaps} filters={{}} sortBy="entityName" sortOrder="asc" activeTab="gaps" />);

    openAndChoose("CSV");

    await waitFor(() => expect(downloads).toHaveLength(1));
    expect(fetchMock).not.toHaveBeenCalled();
    expect(await readBlob(downloads[0].blob)).toBe(
      'Entity Name,Field Name,Gap Type,Severity,Suggested Fix\n"Customer","notes","UNCLASSIFIED","CRITICAL","Add classification to field"'
    );
  });
});
