/** @vitest-environment jsdom */
import { afterEach, describe, expect, it, vi } from "vitest";
import { cleanup, fireEvent, render, screen } from "@testing-library/react";
import { AttributeValueEditor } from "@/components/custom/metadata/AttributeValueEditor";
import { AttributeKeyCombobox } from "@/components/custom/metadata/AttributeKeyCombobox";
import { ENTITY_ONLY, RETENTION, SECURITY } from "./fixtures";

afterEach(cleanup);

describe("AttributeValueEditor", () => {
  it("renders an enum property as a select and a derived member read-only with the note", () => {
    render(<AttributeValueEditor schema={SECURITY.valueSchema} value={{}} derivedKeys={["data_class"]} onChange={() => {}} />);
    const select = screen.getByLabelText("data_category") as HTMLSelectElement;
    expect(screen.getAllByRole("option")).toHaveLength(6);
    expect(select.tagName).toBe("SELECT");
    const derived = screen.getByLabelText("data_class") as HTMLInputElement;
    expect(derived.readOnly).toBe(true);
    expect(screen.getByText("Follows the field's classification")).toBeTruthy();
  });

  it("emits object values per property", () => {
    const onChange = vi.fn();
    render(<AttributeValueEditor schema={SECURITY.valueSchema} value={{}} derivedKeys={["data_class"]} onChange={onChange} />);
    fireEvent.change(screen.getByLabelText("data_category"), { target: { value: "Intrinsic" } });
    expect(onChange).toHaveBeenCalledWith({ data_category: "Intrinsic" });
  });

  it("shows the validateValue error inline and still emits the invalid value", () => {
    const onChange = vi.fn();
    render(<AttributeValueEditor schema={RETENTION.valueSchema} value={0} onChange={onChange} />);
    expect(screen.getByRole("alert").textContent).toContain("must be >= 1");
    fireEvent.change(screen.getByRole("spinbutton"), { target: { value: "-4" } });
    expect(onChange).toHaveBeenCalledWith(-4);
  });

  it("edits a string[] as a tag list", () => {
    const onChange = vi.fn();
    render(<AttributeValueEditor schema={{ type: "array", items: { type: "string" } }} value={["a"]} onChange={onChange} />);
    fireEvent.change(screen.getByLabelText("New value"), { target: { value: "b" } });
    fireEvent.click(screen.getByRole("button", { name: "Add value" }));
    expect(onChange).toHaveBeenCalledWith(["a", "b"]);
    fireEvent.click(screen.getByRole("button", { name: "Remove a" }));
    expect(onChange).toHaveBeenCalledWith([]);
  });

  it("renders a boolean as a checkbox", () => {
    const onChange = vi.fn();
    render(<AttributeValueEditor schema={{ type: "boolean" }} value={false} onChange={onChange} />);
    fireEvent.click(screen.getByRole("checkbox"));
    expect(onChange).toHaveBeenCalledWith(true);
  });
});

describe("AttributeKeyCombobox", () => {
  it("lists dictionary keys matching the typed text, with label and key", () => {
    render(<AttributeKeyCombobox definitions={[SECURITY, RETENTION]} existingKeys={[]} onPick={() => {}} />);
    fireEvent.change(screen.getByLabelText("Attribute key"), { target: { value: "x-sec" } });
    expect(screen.getByRole("option", { name: /Security classification \(x-securityClassification\)/ })).toBeTruthy();
    expect(screen.queryByRole("option", { name: /Retention/ })).toBeNull();
  });

  it("omits keys already set, and picks with the definition", () => {
    const onPick = vi.fn();
    const { rerender } = render(<AttributeKeyCombobox definitions={[SECURITY, ENTITY_ONLY]} existingKeys={[]} onPick={onPick} />);
    fireEvent.change(screen.getByLabelText("Attribute key"), { target: { value: "x-" } });
    fireEvent.click(screen.getByRole("option", { name: /Security classification/ }));
    expect(onPick).toHaveBeenCalledWith("x-securityClassification", SECURITY);
    rerender(<AttributeKeyCombobox definitions={[SECURITY]} existingKeys={["x-securityClassification"]} onPick={onPick} />);
    fireEvent.change(screen.getByLabelText("Attribute key"), { target: { value: "x-" } });
    expect(screen.queryByRole("option")).toBeNull();
  });

  it("still allows a free-typed x- key", () => {
    const onPick = vi.fn();
    render(<AttributeKeyCombobox definitions={[SECURITY]} existingKeys={[]} onPick={onPick} />);
    fireEvent.change(screen.getByLabelText("Attribute key"), { target: { value: "x-custom-thing" } });
    fireEvent.click(screen.getByRole("button", { name: "Use x-custom-thing" }));
    expect(onPick).toHaveBeenCalledWith("x-custom-thing", undefined);
  });
});
