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
  it("opens the add row once and commits through the row action", () => {
    render(<FieldPreviewHarness />);

    fireEvent.click(screen.getByRole("button", { name: /^Add Field$/i }));

    expect(screen.getByPlaceholderText("field_name")).toBeDefined();
    expect(screen.queryByRole("button", { name: /^Add Field$/i })).toBeNull();

    fireEvent.change(screen.getByPlaceholderText("field_name"), {
      target: { value: "customer_id" },
    });
    fireEvent.click(screen.getByRole("button", { name: /Save Field/i }));

    expect(screen.getByDisplayValue("customer_id")).toBeDefined();
    expect(screen.getByText("1 field")).toBeDefined();
  });

  it("add row stays open after saving so user can add another field immediately", () => {
    render(<FieldPreviewHarness />);

    fireEvent.click(screen.getByRole("button", { name: /^Add Field$/i }));
    fireEvent.change(screen.getByPlaceholderText("field_name"), { target: { value: "order_id" } });
    fireEvent.click(screen.getByRole("button", { name: /Save Field/i }));

    // Row must still be open with cleared input
    expect(screen.getByPlaceholderText("field_name")).toBeDefined();
    expect((screen.getByPlaceholderText("field_name") as HTMLInputElement).value).toBe("");
  });

  it("can add multiple fields without re-clicking the Add Field trigger", () => {
    render(<FieldPreviewHarness />);

    fireEvent.click(screen.getByRole("button", { name: /^Add Field$/i }));

    fireEvent.change(screen.getByPlaceholderText("field_name"), { target: { value: "order_id" } });
    fireEvent.click(screen.getByRole("button", { name: /Save Field/i }));

    // Second field — no trigger re-click needed
    fireEvent.change(screen.getByPlaceholderText("field_name"), { target: { value: "customer_id" } });
    fireEvent.click(screen.getByRole("button", { name: /Save Field/i }));

    expect(screen.getByDisplayValue("order_id")).toBeDefined();
    expect(screen.getByDisplayValue("customer_id")).toBeDefined();
    expect(screen.getByText("2 fields")).toBeDefined();
  });
});
