/**
 * TypeSpecImportReviewScreen shows every field's full import details (used / preserved / ignored).
 *
 * @vitest-environment jsdom
 */
import { afterEach, describe, expect, it, vi } from "vitest";
import { cleanup, fireEvent, render, screen, within } from "@testing-library/react";
import { TypeSpecImportReviewScreen } from "@/components/custom/ImportDialog/TypeSpecImportReviewScreen";
import { parseJsonSchemaDocument } from "@/lib/importers/jsonschema.importer";
import { toAssetImportResult } from "@/lib/importers/multi-asset";

vi.mock("@/components/custom/ValidationIndicator", () => ({
  ValidationIndicator: ({ status, tooltipContent }: { status: string; tooltipContent: string }) => (
    <span data-testid="validation-indicator" data-status={status} data-tooltip={tooltipContent} />
  ),
}));

afterEach(cleanup);

const SCHEMA = {
  title: "Order",
  description: "An order",
  type: "object",
  required: ["id", "status"],
  "x-team": "payments",
  not: { type: "null" },
  properties: {
    id: { type: "string", format: "uuid", description: "Order id", minLength: 5 },
    status: { enum: ["OPEN", "CLOSED"] },
    owner: { $ref: "https://example.com/missing/Owner.json" },
    payment: { oneOf: [{ $ref: "#/$defs/Card" }, { $ref: "#/$defs/Bank" }] },
    ssn: {
      type: "string",
      "x-securityClassification": { data_class: "PII", data_category: "identity" },
      "x-audit": { by: "bob" },
      multipleOf: 2,
    },
  },
  $defs: {
    Card: { type: "object", properties: { pan: { type: "string" } } },
    Bank: { type: "object", properties: { iban: { type: "string" } } },
    Priority: {
      allOf: [{ $ref: "#/$defs/Card" }],
      type: "object",
      properties: { level: { type: "integer", minimum: 1, exclusiveMaximum: 10, deprecated: true } },
    },
  },
};

function renderScreen() {
  const parsed = parseJsonSchemaDocument(JSON.stringify(SCHEMA));
  if (!parsed.success) throw new Error("import failed");
  const importResult = toAssetImportResult(parsed.data);
  // A URL-import style dangling marker on the unresolved ref.
  const owner = importResult.models.find((m) => m.name === "Order")!.fields.find((f) => f.name === "owner")!;
  owner.danglingRef = { ref: "https://example.com/missing/Owner.json", reason: "could not be fetched (404)" };
  render(
    <TypeSpecImportReviewScreen
      importResult={importResult}
      domains={[{ id: "d1", name: "Payments" }]}
      onConfirm={vi.fn()}
      onCancel={vi.fn()}
    />,
  );
  return importResult;
}

describe("TypeSpecImportReviewScreen field details", () => {
  it("has the details of every field of every model in the DOM", () => {
    const result = renderScreen();
    for (const model of result.models) {
      for (const field of model.fields) {
        expect(screen.getByTestId(`parsed-field-details-${field.name}`, { exact: false })).toBeDefined();
        expect(screen.getByTestId(`import-field-${model.name}-${field.name}`)).toBeDefined();
      }
    }
    expect(result.models.length).toBeGreaterThanOrEqual(4);
  });

  it("shows each kind of information for the Order model", () => {
    renderScreen();
    const order = within(screen.getByTestId("import-field-Order-id"));
    expect(order.getByText("Order id")).toBeDefined();
    expect(order.getByText("uuid")).toBeDefined();
    expect(order.getByText("Constraint: min length")).toBeDefined();

    const status = within(screen.getByTestId("import-field-Order-status"));
    expect(status.getByText("OPEN, CLOSED")).toBeDefined();

    const payment = within(screen.getByTestId("import-field-Order-payment"));
    expect(payment.getByText("Card | Bank")).toBeDefined();

    const ssn = within(screen.getByTestId("import-field-Order-ssn"));
    expect(ssn.getByText("identity")).toBeDefined();
    expect(ssn.getByText("x-audit")).toBeDefined();
    expect(ssn.getByText("raw classification block")).toBeDefined();
    expect(within(ssn.getByTestId("parsed-field-ignored")).getByText("multipleOf")).toBeDefined();
    expect(within(ssn.getByTestId("parsed-field-preserved")).getByText("multipleOf")).toBeDefined();

    const owner = within(screen.getByTestId("import-field-Order-owner"));
    expect(owner.getByTestId("validation-indicator").getAttribute("data-tooltip")).toContain("could not be fetched (404)");
  });

  it("shows entity-level extensions and ignored keywords, and extends / enum / union assets", () => {
    renderScreen();
    const entity = within(screen.getAllByTestId("parsed-entity-details")[0]);
    expect(entity.getByText("x-team")).toBeDefined();
    expect(within(entity.getByTestId("parsed-entity-ignored")).getByText("not")).toBeDefined();
    expect(within(entity.getByTestId("parsed-entity-preserved")).getByText("not")).toBeDefined();
    expect(screen.getAllByText(/extends Card/).length).toBeGreaterThan(0);
    expect(screen.getByText("OPEN, CLOSED", { exact: false })).toBeDefined();
    expect(screen.getAllByText("Card | Bank").length).toBeGreaterThan(0);
    const level = within(screen.getByTestId("import-field-Priority-level"));
    expect(level.getByText("Exclusive max value")).toBeDefined();
    expect(level.getByText("Yes")).toBeDefined();
  });

  it("starts collapsed per field and expands on click, keeping the selection checkboxes", () => {
    renderScreen();
    const details = screen.getByTestId("parsed-field-details-id");
    expect(details.hasAttribute("hidden")).toBe(true);
    fireEvent.click(screen.getByRole("button", { name: "Show details of Order.id", hidden: true }));
    expect(details.hasAttribute("hidden")).toBe(false);
    expect(screen.getByLabelText("Order model")).toBeDefined();
    expect(screen.getByLabelText("Order entity")).toBeDefined();
  });
});
