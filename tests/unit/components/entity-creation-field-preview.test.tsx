/**
 * @vitest-environment jsdom
 */

import { useState } from "react";
import { afterEach, describe, expect, it, vi } from "vitest";
import { cleanup, fireEvent, render, screen } from "@testing-library/react";
import {
  FieldPreview,
  type PreviewField,
} from "@/components/custom/EntityCreationWizard/FieldPreview";

vi.mock("@/components/custom/TypePicker", () => ({
  TypePicker: ({
    value,
    onChange,
  }: {
    value: string;
    onChange: (value: string) => void;
  }) => (
    <select
      aria-label="Type"
      value={value}
      onChange={(event) => onChange(event.target.value)}
    >
      <option value="string">string</option>
      <option value="int32">int32</option>
    </select>
  ),
}));

vi.mock("@/components/custom/ClassificationPicker", () => ({
  ClassificationPicker: ({
    value,
    onChange,
  }: {
    value: string | null;
    onChange: (value: string | null) => void;
  }) => (
    <button type="button" onClick={() => onChange(value ?? "SENSITIVE")}>
      Classification
    </button>
  ),
}));

afterEach(cleanup);

function FieldPreviewHarness() {
  const [fields, setFields] = useState<PreviewField[]>([]);
  return (
    <FieldPreview
      entityName="Customer"
      entityDescription=""
      fields={fields}
      onFieldsChange={setFields}
      onEntityNameChange={vi.fn()}
      onEntityDescriptionChange={vi.fn()}
      onBack={vi.fn()}
      onConfirm={vi.fn()}
    />
  );
}

describe("FieldPreview", () => {
  it("Add Field button is always visible — not hidden when add row is open", () => {
    render(<FieldPreviewHarness />);

    // Button visible initially
    expect(screen.getByRole("button", { name: /^Add Field$/i })).toBeDefined();

    // Click it to open the row
    fireEvent.click(screen.getByRole("button", { name: /^Add Field$/i }));

    // Button is STILL visible (no longer hidden by showAddRow)
    expect(screen.getByRole("button", { name: /^Add Field$/i })).toBeDefined();
    // Row is now open
    expect(screen.getByPlaceholderText("field_name")).toBeDefined();
  });

  it("clicking Add Field with empty name is disabled while row open", () => {
    render(<FieldPreviewHarness />);

    fireEvent.click(screen.getByRole("button", { name: /^Add Field$/i }));

    // Button disabled when row is open and name is empty
    const btn = screen.getByRole("button", { name: /^Add Field$/i }) as HTMLButtonElement;
    expect(btn.disabled).toBe(true);
  });

  it("clicking Add Field with a name filled saves and keeps row open", () => {
    render(<FieldPreviewHarness />);

    fireEvent.click(screen.getByRole("button", { name: /^Add Field$/i }));
    fireEvent.change(screen.getByPlaceholderText("field_name"), { target: { value: "order_id" } });

    // Button enabled when name is filled
    expect((screen.getByRole("button", { name: /^Add Field$/i }) as HTMLButtonElement).disabled).toBe(false);

    // Click Add Field = saves the field
    fireEvent.click(screen.getByRole("button", { name: /^Add Field$/i }));

    expect(screen.getByDisplayValue("order_id")).toBeDefined();
    expect(screen.getByText("1 field")).toBeDefined();

    // Row still open, input cleared
    expect((screen.getByPlaceholderText("field_name") as HTMLInputElement).value).toBe("");
  });

  it("can add multiple fields by typing and clicking Add Field each time", () => {
    render(<FieldPreviewHarness />);

    fireEvent.click(screen.getByRole("button", { name: /^Add Field$/i }));

    fireEvent.change(screen.getByPlaceholderText("field_name"), { target: { value: "order_id" } });
    fireEvent.click(screen.getByRole("button", { name: /^Add Field$/i }));

    fireEvent.change(screen.getByPlaceholderText("field_name"), { target: { value: "customer_id" } });
    fireEvent.click(screen.getByRole("button", { name: /^Add Field$/i }));

    expect(screen.getByDisplayValue("order_id")).toBeDefined();
    expect(screen.getByDisplayValue("customer_id")).toBeDefined();
    expect(screen.getByText("2 fields")).toBeDefined();
  });

  it("labels the entity name and description inputs (reachable by label)", () => {
    render(<FieldPreviewHarness />);
    expect((screen.getByLabelText("Entity Name") as HTMLInputElement).value).toBe("Customer");
    expect(screen.getByLabelText("Description")).toBeDefined();
  });

  describe("imported details", () => {
    const parsed = (name: string) => ({ name, type: "string", originalType: "string", nullable: true, confidence: "high" as const, constraints: [{ type: "maxLength" as const, value: 300 }] });
    const imported = (count: number): PreviewField[] =>
      Array.from({ length: count }, (_, i) => ({ tempId: `t${i}`, name: `f${i}`, type: "string", classification: null, description: "", parsed: parsed(`f${i}`) }));
    const renderWith = (fields: PreviewField[]) =>
      render(
        <FieldPreview entityName="E" entityDescription="" fields={fields} onFieldsChange={vi.fn()} onEntityNameChange={vi.fn()} onEntityDescriptionChange={vi.fn()} onBack={vi.fn()} onConfirm={vi.fn()} />
      );

    it("a small import opens with every field's details showing, its facts as chips on the row, and one toggle to collapse them all", () => {
      renderWith(imported(2));
      expect(screen.getAllByText("max length 300")).toHaveLength(2); // the chips
      for (const toggle of screen.getAllByRole("button", { name: /import details of/ })) expect(toggle.getAttribute("aria-expanded")).toBe("true");
      expect(document.querySelectorAll('[data-testid^="parsed-field-details-"]:not([hidden])')).toHaveLength(2);
      fireEvent.click(screen.getByTestId("wizard-toggle-details"));
      for (const toggle of screen.getAllByRole("button", { name: /import details of/ })) expect(toggle.getAttribute("aria-expanded")).toBe("false");
      expect(screen.getByTestId("wizard-toggle-details").textContent).toBe("Expand all imported details");
      fireEvent.click(screen.getByTestId("wizard-toggle-details"));
      expect(document.querySelectorAll('[data-testid^="parsed-field-details-"]:not([hidden])')).toHaveLength(2);
    });

    it("a large import opens collapsed (chips still show) and Expand all opens every field", () => {
      renderWith(imported(13));
      for (const toggle of screen.getAllByRole("button", { name: /import details of/ })) expect(toggle.getAttribute("aria-expanded")).toBe("false");
      expect(screen.getAllByText("max length 300")).toHaveLength(13);
      fireEvent.click(screen.getByTestId("wizard-toggle-details"));
      for (const toggle of screen.getAllByRole("button", { name: /import details of/ })) expect(toggle.getAttribute("aria-expanded")).toBe("true");
    });

    it("has no toggle when nothing was imported (fields added by hand)", () => {
      render(<FieldPreviewHarness />);
      expect(screen.queryByTestId("wizard-toggle-details")).toBeNull();
    });
  });
});
