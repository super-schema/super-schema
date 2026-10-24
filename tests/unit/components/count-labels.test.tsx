/**
 * A count label is singular for exactly one: "1 field found", not "1 fields found". The first pass (src/lib/pluralize.ts, the entity card
 * and its family) missed these: found by grepping the UI strings once more.
 *
 * @vitest-environment jsdom
 */
import { QueryClient, QueryClientProvider } from "@tanstack/react-query";
import { cleanup, fireEvent, render, screen, waitFor } from "@testing-library/react";
import { afterEach, describe, expect, it, vi } from "vitest";

const invalidate = vi.hoisted(() => vi.fn());
vi.mock("@/hooks/useDomainsTree", () => ({ useInvalidateDomainsTree: () => invalidate }));
vi.mock("sonner", () => ({ toast: { error: vi.fn(), success: vi.fn(), warning: vi.fn() } }));
vi.mock("next/navigation", () => ({ useRouter: () => ({ push: vi.fn(), refresh: vi.fn() }) }));
vi.mock("@/app/(dashboard)/schemas/[domainSlug]/actions", () => ({
  createSharedEnumAction: vi.fn(),
  updateSharedEnumAction: vi.fn(),
  deleteSharedEnumAction: vi.fn(),
  createCustomScalarAction: vi.fn(),
  deleteCustomScalarAction: vi.fn(),
  createUnionTypeAction: vi.fn(),
  updateUnionTypeAction: vi.fn(),
  deleteUnionTypeAction: vi.fn(),
  createDomainAssetsFromImportAction: vi.fn(),
}));
vi.mock("@/app/(dashboard)/schemas/[domainSlug]/typespec-import-actions", () => ({ importTypeSpecDocumentAction: vi.fn() }));
vi.mock("@/app/(dashboard)/schemas/[domainSlug]/openapi-import-actions", () => ({ importOpenApiDocumentAction: vi.fn() }));

import { DomainTypesTab } from "@/app/(dashboard)/schemas/[domainSlug]/components/DomainTypesTab";
import { BulkImportReviewScreen } from "@/components/custom/ImportDialog/BulkImportReviewScreen";
import { ImportDialog } from "@/components/custom/ImportDialog";
import { ComplianceResultsTable } from "@/features/compliance/ComplianceResultsTable";
import { FieldEditor } from "@/app/(dashboard)/schemas/[domainSlug]/[productSlug]/[entityId]/field-editor";

afterEach(cleanup);

const queryClient = () => new QueryClient({ defaultOptions: { queries: { retry: false } } });

describe("enum card", () => {
  const target = { level: "DOMAIN" as const, domainId: "d1" };
  const enumOf = (values: string[]) => ({ id: "en1", name: "Status", values, description: "" });

  it.each([
    [["A"], "1 value"],
    [["A", "B"], "2 values"],
  ])("%j reads %j", (values, text) => {
    render(<DomainTypesTab domainId="d1" target={target} sharedEnums={[enumOf(values)]} customScalars={[]} unionTypes={[]} />);
    expect(screen.getByText(text, { exact: true })).toBeTruthy();
  });
});

describe("ImportDialog live parse", () => {
  const oneField = JSON.stringify({ title: "Order", type: "object", properties: { id: { type: "string" } } });
  const twoFields = JSON.stringify({ title: "Order", type: "object", properties: { id: { type: "string" }, total: { type: "number" } } });

  it.each([
    [oneField, "1 field found."],
    [twoFields, "2 fields found."],
  ])("says how many fields it found: %s", async (content, text) => {
    render(
      <QueryClientProvider client={queryClient()}>
        <ImportDialog isOpen onClose={vi.fn()} domains={[{ id: "domain-1", name: "Domain" }]} />
      </QueryClientProvider>
    );
    fireEvent.change(screen.getByPlaceholderText(/Paste TypeSpec, JSON Schema/), { target: { value: content } });
    // The live parse runs 300 ms after the last keystroke.
    await waitFor(() => expect(screen.getByText(new RegExp(`format — ${text.replace(".", "\\.")}$`))).toBeTruthy(), { timeout: 3000 });
    expect(screen.queryByText(/1 fields found/)).toBeNull();
  });
});

describe("bulk import review", () => {
  const entity = {
    name: "Order",
    sourceFormat: "json-schema",
    originalContent: "{}",
    fields: [{ name: "id", type: "string", nullable: false, isKey: true, description: "" }],
  };

  function renderBulk(props: Partial<Parameters<typeof BulkImportReviewScreen>[0]> = {}) {
    render(
      <BulkImportReviewScreen
        parsedEntities={[entity as never]}
        errors={[{ filename: "bad.json", error: "not a schema" }]}
        warnings={[]}
        onConfirm={vi.fn()}
        onCancel={vi.fn()}
        domains={[{ id: "d1", name: "Domain" }]}
        {...props}
      />
    );
  }

  it("counts one entity, one field and one error in the singular", () => {
    renderBulk();
    expect(screen.getByText("1 entity")).toBeTruthy();
    expect(screen.getByText(/, 1 field total/)).toBeTruthy();
    expect(screen.getByText("1 error")).toBeTruthy();
    expect(screen.getByText("1 field", { exact: true })).toBeTruthy();
    expect(screen.getByRole("button", { name: "Confirm Import (1 entity)" })).toBeTruthy();
  });

  it("says 'of 1 entity' while the only entity is created", () => {
    renderBulk({ isConfirming: true, progress: { current: 1, total: 1 } });
    expect(screen.getByText("Creating 1 of 1 entity...")).toBeTruthy();
  });
});

describe("compliance results", () => {
  function table(total: number) {
    render(
      <ComplianceResultsTable
        fields={[]}
        total={total}
        page={1}
        pageSize={25}
        sortBy="entityName"
        sortOrder="asc"
        onSort={vi.fn()}
        onPageChange={vi.fn()}
        loading={false}
      />
    );
  }

  it("says '1 field matching' for one result", () => {
    table(1);
    expect(screen.getByText(/of 1 field matching/)).toBeTruthy();
    expect(screen.queryByText(/of 1 fields matching/)).toBeNull();
  });

  it("says 'fields matching' for several", () => {
    table(2);
    expect(screen.getByText(/of 2 fields matching/)).toBeTruthy();
  });
});

describe("field editor", () => {
  const field = {
    id: "f1",
    name: "email",
    type: "string",
    precision: null,
    scale: null,
    nullable: false,
    isKey: false,
    fieldNumber: null,
    description: "The e-mail",
    classification: "PII",
    aliases: [],
    decorators: {},
    sortOrder: 0,
  };

  it("counts its one field in the singular (completeness)", () => {
    render(
      <FieldEditor
        entityId="e1"
        domainSlug="payments"
        productSlug="checkout"
        fields={[field]}
        domainPolicy={null}
        onAddField={async () => ({})}
        onUpdateField={async () => {}}
        onDeleteField={async () => {}}
      />
    );
    expect(screen.getByText(/ of 1 field complete$/)).toBeTruthy();
    expect(screen.queryByText(/1 fields/)).toBeNull();
  });
});
