/**
 * @vitest-environment jsdom
 */
import { afterEach, describe, expect, it, vi } from "vitest";
import { cleanup, render, screen, within, fireEvent } from "@testing-library/react";
import {
  ParsedFieldDetails,
  ParsedEntityDetails,
} from "@/components/custom/ImportDialog/ParsedFieldDetails";
import type { ParsedField } from "@/lib/importers/types";

vi.mock("@/components/custom/ValidationIndicator", () => ({
  ValidationIndicator: ({ status, tooltipContent }: { status: string; tooltipContent: string }) => (
    <span data-testid="validation-indicator" data-status={status} data-tooltip={tooltipContent} />
  ),
}));

afterEach(cleanup);

const FULL: ParsedField = {
  name: "amount",
  type: "int32",
  nullable: false,
  isKey: true,
  description: "The amount",
  confidence: "medium",
  originalType: "integer/int32",
  format: "money",
  constraints: [
    { type: "minLength", value: 2 },
    { type: "maxLength", value: 9 },
    { type: "pattern", value: "^a" },
    { type: "minValue", value: 1 },
    { type: "maxValue", value: 99 },
    { type: "minItems", value: 3 },
    { type: "maxItems", value: 4 },
  ],
  minValueExclusive: 0,
  maxValueExclusive: 100,
  deprecated: true,
  deprecatedMessage: "use total",
  classification: "PII",
  governance: { dataClass: "PII", dataCategory: "contact" },
  enumName: "Kind",
  enumValues: ["A", "B"],
  referencedEntityName: "Customer",
  arrayElementType: "reference",
  unionName: "Payment",
  unionMembers: ["Card", "Bank"],
  fieldNumber: 7,
  extensions: {
    "x-securityClassification": { data_class: "PII", data_category: "contact" },
    "x-owner": "team-a",
  },
  ignoredKeywords: ["not", "multipleOf"],
  danglingRef: { ref: "./Customer.json", reason: "fetch failed (404)" },
};

describe("ParsedFieldDetails", () => {
  it("shows every Used item for a fully populated field", () => {
    render(<ParsedFieldDetails field={FULL} />);
    const used = within(screen.getByTestId("parsed-field-used"));
    for (const text of [
      "amount", "int32", "integer/int32", "Yes (required)", "The amount", "money",
      "min length", "max length", "pattern", "min value", "max value", "min items", "max items",
      "^a", "99", "Exclusive min value", "Exclusive max value", "Yes — use total",
      "contact", "Kind", "A, B", "Customer", "Card | Bank", "Payment", "7", "Medium confidence",
    ]) {
      expect(used.getAllByText(new RegExp(text.replace(/[.*+?^${}()|[\]\\]/g, "\\$&"))).length).toBeGreaterThan(0);
    }
    expect(used.getByText("Classification")).toBeDefined();
    expect(used.getByText("Data class")).toBeDefined();
    expect(used.getByText("Data category")).toBeDefined();
    expect(used.getByText("Array element type")).toBeDefined();
  });

  it("labels the three groups", () => {
    render(<ParsedFieldDetails field={FULL} />);
    expect(screen.getByRole("heading", { name: "Used" })).toBeDefined();
    expect(screen.getByRole("heading", { name: "Preserved (kept, not interpreted)" })).toBeDefined();
    expect(screen.getByRole("heading", { name: "Ignored (not supported)" })).toBeDefined();
  });

  it("lists every extension with its JSON value, plus the raw classification block", () => {
    render(<ParsedFieldDetails field={FULL} />);
    const preserved = within(screen.getByTestId("parsed-field-preserved"));
    expect(preserved.getByText("x-owner")).toBeDefined();
    expect(screen.getByTestId("parsed-extension-value-x-owner").textContent).toBe('"team-a"');
    expect(screen.getByTestId("parsed-extension-value-x-securityClassification").textContent).toContain('"data_class": "PII"');
    expect(preserved.getByText("raw classification block")).toBeDefined();
  });

  it("lists the ignored keywords", () => {
    render(<ParsedFieldDetails field={FULL} />);
    const ignored = within(screen.getByTestId("parsed-field-ignored"));
    expect(ignored.getByText("not")).toBeDefined();
    expect(ignored.getByText("multipleOf")).toBeDefined();
  });

  it("shows a dangling-reference badge whose tooltip carries the ref and the reason", () => {
    render(<ParsedFieldDetails field={FULL} />);
    const indicator = screen.getByTestId("validation-indicator");
    expect(indicator.getAttribute("data-status")).toBe("suggestion");
    expect(indicator.getAttribute("data-tooltip")).toContain("./Customer.json");
    expect(indicator.getAttribute("data-tooltip")).toContain("fetch failed (404)");
    expect(screen.getByTestId("parsed-field-dangling").textContent).toContain("fetch failed (404)");
  });

  it("infers a dangling reference from a low-confidence reference to an entity outside the import", () => {
    const field: ParsedField = {
      name: "owner", type: "reference", nullable: true, confidence: "low", originalType: "$ref", referencedEntityName: "Ghost",
    };
    const { rerender } = render(<ParsedFieldDetails field={field} entityNames={new Set(["Order"])} />);
    expect(screen.getByTestId("validation-indicator").getAttribute("data-tooltip")).toContain("Ghost");
    rerender(<ParsedFieldDetails field={field} entityNames={new Set(["Order", "Ghost"])} />);
    expect(screen.queryByTestId("validation-indicator")).toBeNull();
  });

  it("omits Preserved / Ignored / optional rows for a minimal field but still shows Used", () => {
    const minimal: ParsedField = { name: "id", type: "string", nullable: true, confidence: "high", originalType: "string" };
    render(<ParsedFieldDetails field={minimal} />);
    expect(screen.getByTestId("parsed-field-used")).toBeDefined();
    expect(screen.queryByTestId("parsed-field-preserved")).toBeNull();
    expect(screen.queryByTestId("parsed-field-ignored")).toBeNull();
    expect(screen.queryByText("Original type")).toBeNull();
    expect(screen.queryByText("Description")).toBeNull();
    expect(screen.queryByTestId("validation-indicator")).toBeNull();
    expect(screen.getByText("No (nullable)")).toBeDefined();
  });

  it("keeps a large extension value in the DOM, collapsed until expanded", () => {
    const big = { list: Array.from({ length: 60 }, (_, i) => `item-${i}`) };
    const field: ParsedField = { ...FULL, extensions: { "x-big": big }, ignoredKeywords: undefined };
    render(<ParsedFieldDetails field={field} />);
    const value = screen.getByTestId("parsed-extension-value-x-big");
    expect(value.textContent).toContain("item-59");
    expect(value.getAttribute("data-collapsed")).toBe("true");
    fireEvent.click(screen.getByRole("button", { name: "Expand value" }));
    expect(screen.getByTestId("parsed-extension-value-x-big").getAttribute("data-collapsed")).toBe("false");
  });

  it("collapsed hides the details but keeps them in the DOM", () => {
    render(<ParsedFieldDetails field={FULL} collapsed />);
    const root = screen.getByTestId("parsed-field-details-amount");
    expect(root.hasAttribute("hidden")).toBe(true);
    expect(root.textContent).toContain("team-a");
  });
});

describe("ParsedEntityDetails", () => {
  it("shows description, extends, extensions, ignored keywords and every warning", () => {
    const warnings = Array.from({ length: 30 }, (_, i) => `warning number ${i}`);
    render(
      <ParsedEntityDetails
        entity={{
          name: "Order",
          description: "An order",
          extends: "Base",
          extensions: { "x-links": [1] },
          ignoredKeywords: ["not"],
        }}
        warnings={warnings}
      />,
    );
    expect(screen.getByText("An order")).toBeDefined();
    expect(screen.getByText("Base")).toBeDefined();
    expect(screen.getByText("x-links")).toBeDefined();
    expect(screen.getByText("not")).toBeDefined();
    for (const w of warnings) expect(screen.getByText(w)).toBeDefined();
  });
});
