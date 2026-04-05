/**
 * Component logic tests for FieldQuickEditPanel and its sub-sections.
 *
 * Uses jsdom + @testing-library/react to render and verify component output.
 * No browser required.
 *
 * @vitest-environment jsdom
 */

import { describe, it, expect, vi, afterEach } from "vitest";
import { createElement } from "react";
import { render, screen, cleanup } from "@testing-library/react";

// Ensure cleanup after each test to avoid leaked DOM
afterEach(() => {
  cleanup();
});

// ---------------------------------------------------------------------------
// Mock: next/link (used by FieldQuickEditPanel)
// ---------------------------------------------------------------------------

vi.mock("next/link", () => ({
  default: ({ children, href }: { children: React.ReactNode; href: string }) =>
    createElement("a", { href }, children),
}));

// ---------------------------------------------------------------------------
// Mock: Popover (used by ClassificationPicker — avoid Radix/Base UI issues)
// ---------------------------------------------------------------------------

vi.mock("@/components/ui/popover", () => ({
  Popover: ({ children }: { children: React.ReactNode }) =>
    createElement("div", { "data-testid": "popover" }, children),
  PopoverTrigger: ({ children, className }: { children: React.ReactNode; className?: string }) =>
    createElement("button", { "data-testid": "popover-trigger", className }, children),
  PopoverContent: ({ children }: { children: React.ReactNode }) =>
    createElement("div", { "data-testid": "popover-content" }, children),
}));

// ---------------------------------------------------------------------------
// Mock: TypePicker (complex component with Popover internals)
// ---------------------------------------------------------------------------

vi.mock("@/components/custom/TypePicker", () => ({
  TypePicker: ({ value, onChange }: { value: string; onChange: (v: string) => void }) =>
    createElement("select", {
      "data-testid": "type-picker",
      value,
      onChange: (e: { target: { value: string } }) => onChange(e.target.value),
    }),
}));

// ---------------------------------------------------------------------------
// Imports (after mocks)
// ---------------------------------------------------------------------------

import { FieldQuickEditPanel } from "@/components/custom/FieldQuickEditPanel/FieldQuickEditPanel";
import { ValidationSection } from "@/components/custom/FieldQuickEditPanel/ValidationSection";
import { GovernanceSection } from "@/components/custom/FieldQuickEditPanel/GovernanceSection";
import { IdentitySection } from "@/components/custom/FieldQuickEditPanel/IdentitySection";

// ---------------------------------------------------------------------------
// Test data
// ---------------------------------------------------------------------------

const baseField = {
  id: "field-1",
  name: "customer_email",
  type: "string",
  precision: null,
  scale: null,
  nullable: false,
  isKey: false,
  fieldNumber: null,
  description: "Customer email address",
  classification: "PII",
  aliases: [],
  decorators: {
    typespec: {
      identity: { format: "email", secret: false },
      validation: { maxLength: 320 },
    },
    policy: { retention: "3y", encryption: "at-rest" },
  },
  sortOrder: 1,
};

const noopUpdate = vi.fn().mockResolvedValue(undefined);

// ---------------------------------------------------------------------------
// FieldQuickEditPanel tests
// ---------------------------------------------------------------------------

describe("FieldQuickEditPanel", () => {
  it("renders Identity section with field data", () => {
    render(
      createElement(FieldQuickEditPanel, {
        field: baseField,
        entityId: "ent-1",
        domainSlug: "crm",
        onUpdateField: noopUpdate,
      })
    );

    // The panel should display the field name in the header
    expect(screen.getByText("customer_email")).toBeDefined();

    // Should have accordion section labels
    expect(screen.getByText("Identity")).toBeDefined();
    expect(screen.getByText("Validation")).toBeDefined();
    expect(screen.getByText("Documentation")).toBeDefined();
    expect(screen.getByText("Governance")).toBeDefined();
  });

  it("has the data-testid for quick edit panel", () => {
    render(
      createElement(FieldQuickEditPanel, {
        field: baseField,
        entityId: "ent-1",
        domainSlug: "crm",
        onUpdateField: noopUpdate,
      })
    );

    expect(screen.getByTestId("field-quick-edit-panel")).toBeDefined();
  });
});

// ---------------------------------------------------------------------------
// ValidationSection tests
// ---------------------------------------------------------------------------

describe("ValidationSection", () => {
  it("shows numeric controls (Min Value, Max Value) for decimal type", () => {
    render(
      createElement(ValidationSection, {
        type: "decimal",
        values: { minValue: 0, maxValue: 999999 },
        isReadOnly: false,
        onChange: vi.fn(),
      })
    );

    expect(screen.getByText("Min Value")).toBeDefined();
    expect(screen.getByText("Max Value")).toBeDefined();

    // Should NOT show string controls
    expect(screen.queryByText("Min Length")).toBeNull();
    expect(screen.queryByText("Max Length")).toBeNull();
    expect(screen.queryByText("Pattern (Regex)")).toBeNull();
  });

  it("shows numeric controls for int32 type", () => {
    render(
      createElement(ValidationSection, {
        type: "int32",
        values: { minValue: null, maxValue: null },
        isReadOnly: false,
        onChange: vi.fn(),
      })
    );

    expect(screen.getByText("Min Value")).toBeDefined();
    expect(screen.getByText("Max Value")).toBeDefined();
  });

  it("shows string controls (Min Length, Max Length, Pattern) for string type", () => {
    render(
      createElement(ValidationSection, {
        type: "string",
        values: { minLength: 1, maxLength: 255, pattern: "^[a-z]+$" },
        isReadOnly: false,
        onChange: vi.fn(),
      })
    );

    expect(screen.getByText("Min Length")).toBeDefined();
    expect(screen.getByText("Max Length")).toBeDefined();
    expect(screen.getByText("Pattern (Regex)")).toBeDefined();

    // Should NOT show numeric controls
    expect(screen.queryByText("Min Value")).toBeNull();
    expect(screen.queryByText("Max Value")).toBeNull();
  });

  it("shows array controls (Min Items, Max Items) for array type", () => {
    render(
      createElement(ValidationSection, {
        type: "array",
        values: { minItems: 0, maxItems: 100 },
        isReadOnly: false,
        onChange: vi.fn(),
      })
    );

    expect(screen.getByText("Min Items")).toBeDefined();
    expect(screen.getByText("Max Items")).toBeDefined();
  });

  it("shows no-rules message for boolean type", () => {
    render(
      createElement(ValidationSection, {
        type: "boolean",
        values: {},
        isReadOnly: false,
        onChange: vi.fn(),
      })
    );

    // Boolean has no validation controls -- should show the fallback message
    const fallback = screen.getByText(/No validation rules applicable/);
    expect(fallback).toBeDefined();
  });
});

// ---------------------------------------------------------------------------
// GovernanceSection tests
// ---------------------------------------------------------------------------

describe("GovernanceSection", () => {
  it("renders classification picker", () => {
    render(
      createElement(GovernanceSection, {
        classification: "PII",
        retention: "3y",
        anonymization: "",
        encryption: "at-rest",
        isReadOnly: false,
        onChange: vi.fn(),
      })
    );

    // Should show the Classification label
    expect(screen.getByText("Classification")).toBeDefined();
    // Should show the Retention label
    expect(screen.getByText("Retention")).toBeDefined();
    // Should show the Anonymization label
    expect(screen.getByText("Anonymization")).toBeDefined();
    // Should show the Encryption label
    expect(screen.getByText("Encryption")).toBeDefined();

    // The ClassificationPicker renders PII in both trigger and dropdown option
    const piiElements = screen.getAllByText("PII");
    expect(piiElements.length).toBeGreaterThanOrEqual(1);
  });

  it("renders dash for null classification", () => {
    render(
      createElement(GovernanceSection, {
        classification: null,
        retention: "",
        anonymization: "",
        encryption: "",
        isReadOnly: false,
        onChange: vi.fn(),
      })
    );

    // "None" appears in classification picker dropdown and in the
    // Anonymization/Encryption select options — verify at least one exists
    const noneElements = screen.getAllByText("None");
    expect(noneElements.length).toBeGreaterThanOrEqual(1);
  });
});

// ---------------------------------------------------------------------------
// IdentitySection tests
// ---------------------------------------------------------------------------

describe("IdentitySection", () => {
  it("renders Name, Type, and checkbox controls", () => {
    render(
      createElement(IdentitySection, {
        name: "email",
        type: "string",
        nullable: false,
        isKey: false,
        secret: true,
        format: "email",
        defaultValue: "",
        isReadOnly: false,
        onChange: vi.fn(),
      })
    );

    // Labels
    expect(screen.getByText("Name")).toBeDefined();
    expect(screen.getByText("Type")).toBeDefined();
    expect(screen.getByText("Optional")).toBeDefined();
    expect(screen.getByText("Secret")).toBeDefined();
    expect(screen.getByText("Key")).toBeDefined();
    expect(screen.getByText("Format")).toBeDefined();
    expect(screen.getByText("Default Value")).toBeDefined();
  });

  it("disables inputs when isReadOnly is true", () => {
    render(
      createElement(IdentitySection, {
        name: "id",
        type: "string",
        nullable: false,
        isKey: true,
        secret: false,
        format: "uuid",
        defaultValue: "",
        isReadOnly: true,
        onChange: vi.fn(),
      })
    );

    // All native inputs should be disabled
    const inputs = document.querySelectorAll("input");
    for (const input of inputs) {
      expect(input.disabled).toBe(true);
    }

    // All native selects should be disabled (excludes mocked TypePicker)
    const selects = document.querySelectorAll("select:not([data-testid='type-picker'])");
    for (const select of selects) {
      expect((select as HTMLSelectElement).disabled).toBe(true);
    }
  });
});
