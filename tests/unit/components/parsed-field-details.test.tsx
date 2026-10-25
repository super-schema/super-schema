/**
 * @vitest-environment jsdom
 */
import { afterEach, describe, expect, it, vi } from "vitest";
import { cleanup, render, screen, within, fireEvent } from "@testing-library/react";
import {
  ParsedFieldDetails,
  ParsedEntityDetails,
  MAX_VALUE_CHARS,
  MOUNT_DETAILS_ONLY_WHEN_EXPANDED_ABOVE,
} from "@/components/custom/ImportDialog/ParsedFieldDetails";
import type { ParsedEntity, ParsedField, ParsedFieldGovernance } from "@/lib/importers/types";

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
  nullableType: true,
  requiredNullable: true,
  isKey: true,
  description: "The amount",
  confidence: "medium",
  originalType: "integer/int32",
  format: "money",
  precision: 12,
  scale: 2,
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
  governance: { dataClass: "PII", dataCategory: "contact", protobufOneofGroup: "contact_oneof", avroFixedSize: 16 },
  mapKeyType: "string",
  mapValueType: "int64",
  summary: "Order total summary",
  visibility: ["Lifecycle.Read", "Lifecycle.Create"],
  encode: "base64",
  encodeSubType: "string",
  secret: true,
  discriminator: "kind",
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
  danglingRef: { ref: "./Customer.json", resolvedUri: "https://x.test/Customer.json", reason: "fetch failed (404)" },
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
    expect(screen.getByRole("heading", { name: "Not used by the app (also kept under Preserved)" })).toBeDefined();
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

  it("renders at most MAX_VALUE_CHARS of a huge extension value until expanded (the rest stays reachable)", () => {
    const huge = "x".repeat(5 * 1024 * 1024);
    const field: ParsedField = { ...FULL, extensions: { "x-big": huge }, ignoredKeywords: undefined };
    render(<ParsedFieldDetails field={field} />);
    const value = screen.getByTestId("parsed-extension-value-x-big");
    expect(value.textContent!.length).toBeLessThanOrEqual(MAX_VALUE_CHARS);
    expect(value.getAttribute("data-collapsed")).toBe("true");
    fireEvent.click(screen.getByRole("button", { name: /more characters — show all/ }));
    expect(screen.getByTestId("parsed-extension-value-x-big").textContent!.length).toBeGreaterThan(5 * 1024 * 1024);
    expect(screen.getByTestId("parsed-extension-value-x-big").getAttribute("data-collapsed")).toBe("false");
  });

  it("shows a value under the limit in full without a control", () => {
    const field: ParsedField = { ...FULL, extensions: { "x-small": { list: ["a", "b"] } } };
    render(<ParsedFieldDetails field={field} />);
    expect(screen.getByTestId("parsed-extension-value-x-small").textContent).toContain('"b"');
    expect(screen.queryByRole("button", { name: /show all/ })).toBeNull();
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
    expect(within(screen.getByTestId("parsed-entity-ignored")).getByText("not")).toBeDefined();
    for (const w of warnings) expect(screen.getByText(w)).toBeDefined();
  });
});

// ---------------------------------------------------------------------------
// Exhaustiveness guards: adding a property to ParsedField / ParsedEntity / ParsedFieldGovernance without deciding how
// the review shows it is a COMPILE error here. Every property marked as shown must render its label for a full object.
// ---------------------------------------------------------------------------

/** label rendered in the field details, or "internal: <reason>" for properties that are deliberately not shown. */
const FIELD_DISPLAY: Record<keyof ParsedField, string> = {
  name: "Name",
  type: "Type",
  nullable: "Required",
  nullableType: "Nullable type",
  requiredNullable: "Nullable type",
  description: "Description",
  fieldNumber: "Field number",
  confidence: "Confidence",
  originalType: "Original type",
  isKey: "Key",
  classification: "Classification",
  format: "Format",
  precision: "Precision",
  scale: "Scale",
  deprecated: "Deprecated",
  deprecatedMessage: "Deprecated",
  constraints: "Constraint: min length",
  summary: "Summary",
  visibility: "Visibility",
  encode: "Encode",
  encodeSubType: "Encode sub-type",
  minValueExclusive: "Exclusive min value",
  maxValueExclusive: "Exclusive max value",
  extensions: "x-owner",
  secret: "Secret",
  discriminator: "Discriminator",
  referencedEntityName: "References",
  arrayElementType: "Array element type",
  mapKeyType: "Map key type",
  mapValueType: "Map value type",
  enumName: "Enum",
  enumValues: "Enum values",
  unionName: "Union",
  unionMembers: "Union members",
  danglingRef: "Dangling reference",
  governance: "Data class",
  ignoredKeywords: "multipleOf",
};

const GOVERNANCE_DISPLAY: Record<keyof ParsedFieldGovernance, string> = {
  protobufOneofGroup: "Oneof group",
  avroFixedSize: "Fixed size",
  dataClass: "Data class",
  dataCategory: "Data category",
};

const ENTITY_DISPLAY: Record<keyof ParsedEntity, string> = {
  name: "Entity name",
  description: "Description",
  fields: "internal: each field is rendered by ParsedFieldDetails",
  extensions: "x-links",
  extends: "Extends",
  ignoredKeywords: "not",
  sourceFormat: "Source format",
  originalContent: "internal: raw source text kept only for drift detection",
  importWarnings: "internal: said by the import service as warnings of the import (not part of the entity's details)",
};

describe("display exhaustiveness", () => {
  it("every ParsedField property (all populated in FULL) is rendered under its label", () => {
    expect(Object.keys(FULL).sort()).toEqual(Object.keys(FIELD_DISPLAY).sort());
    render(<ParsedFieldDetails field={FULL} />);
    const root = screen.getByTestId("parsed-field-details-amount");
    for (const [prop, label] of Object.entries(FIELD_DISPLAY)) {
      if (label.startsWith("internal")) continue;
      expect(root.textContent, `${prop} -> ${label}`).toContain(label);
    }
    for (const [prop, label] of Object.entries(GOVERNANCE_DISPLAY)) {
      expect(root.textContent, `governance.${prop} -> ${label}`).toContain(label);
    }
    expect(Object.keys(FULL.governance!).sort()).toEqual(Object.keys(GOVERNANCE_DISPLAY).sort());
    // the values too, not only the labels
    for (const value of ["Order total summary", "Lifecycle.Read, Lifecycle.Create", "base64", "kind", "contact_oneof", "16"]) {
      expect(root.textContent).toContain(value);
    }
    expect(root.textContent).toContain("resolved to https://x.test/Customer.json");
    expect(screen.getByTestId("validation-indicator").getAttribute("data-tooltip")).toContain("https://x.test/Customer.json");
  });

  it("every ParsedEntity property is rendered under its label (or marked internal)", () => {
    const entity: ParsedEntity = {
      name: "Order",
      description: "An order",
      fields: [],
      extensions: { "x-links": [1] },
      extends: "Base",
      ignoredKeywords: ["not"],
      sourceFormat: "json-schema",
      originalContent: "{}",
      importWarnings: ["a warning of the import"],
    };
    expect(Object.keys(entity).sort()).toEqual(Object.keys(ENTITY_DISPLAY).sort());
    render(<ParsedEntityDetails entity={entity} />);
    const text = screen.getByTestId("parsed-entity-details").textContent!;
    for (const [prop, label] of Object.entries(ENTITY_DISPLAY)) {
      if (label.startsWith("internal")) continue;
      expect(text, `${prop} -> ${label}`).toContain(label);
    }
    expect(text).toContain("json-schema");
  });
});

describe("large imports stay bounded", () => {
  it("a model with 300 fields mounts details only for expanded fields", async () => {
    const { TypeSpecImportReviewScreen } = await import("@/components/custom/ImportDialog/TypeSpecImportReviewScreen");
    const fields: ParsedField[] = Array.from({ length: 300 }, (_, i) => ({
      name: `f${i}`, type: "string", nullable: true, confidence: "high", originalType: "string",
      extensions: { "x-n": i },
    }));
    const started = performance.now();
    render(
      <TypeSpecImportReviewScreen
        importResult={{
          sourceFormat: "json-schema",
          models: [{
            name: "Big", fields, sourceFormat: "json-schema", originalContent: "",
            referencedModelNames: [], referencedByModelNames: [], recommendedAsEntity: true,
          }],
          sharedEnums: [], customScalars: [], unions: [], aliases: [], decoratorDefinitions: [], services: [], warnings: [],
        }}
        domains={[{ id: "d", name: "D" }]}
        onConfirm={vi.fn()}
        onCancel={vi.fn()}
      />,
    );
    expect(performance.now() - started).toBeLessThan(5000);
    expect(MOUNT_DETAILS_ONLY_WHEN_EXPANDED_ABOVE).toBe(50);
    expect(document.querySelectorAll('[data-testid^="parsed-field-details-"]').length).toBe(0);
    fireEvent.click(screen.getByRole("button", { name: "Show details of Big.f7", hidden: true }));
    expect(document.querySelectorAll('[data-testid^="parsed-field-details-"]').length).toBe(1);
    expect(screen.getByTestId("parsed-field-details-f7").hasAttribute("hidden")).toBe(false);
  });
});
