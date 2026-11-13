/**
 * Final UI review fixes on the metadata editors:
 * - U5: the attribute key picker is a combobox (ARIA, arrows, Enter, Escape), opens on focus with every key, and explains a non-x- key;
 * - U6: a freshly picked attribute shows its validation problems only once the user edits it;
 * - U7: the entity Metadata row shows the attribute label once;
 * - U8: a derived `classN` member reads "class2 (Class 2 — PII)".
 *
 * @vitest-environment jsdom
 */
import { afterEach, describe, expect, it, vi } from "vitest";
import { cleanup, fireEvent, render, screen } from "@testing-library/react";
import { AttributeKeyCombobox } from "@/components/custom/metadata/AttributeKeyCombobox";
import { AttributeValueEditor, initialAttributeValue } from "@/components/custom/metadata/AttributeValueEditor";
import { EntityAttributesSection } from "@/app/(dashboard)/schemas/[domainSlug]/[productSlug]/[entityId]/components/EntityAttributesSection";
import type { ValueSchema } from "@/lib/metadata-attributes/value-schema";
import { ENTITY_ONLY, RETENTION, SECURITY } from "./fixtures";

afterEach(cleanup);

describe("AttributeKeyCombobox (U5)", () => {
  it("is a combobox that opens on focus listing every key, without typing", () => {
    render(<AttributeKeyCombobox definitions={[SECURITY, RETENTION]} existingKeys={[]} onPick={() => {}} />);
    const input = screen.getByRole("combobox", { name: "Attribute key" });
    expect(input.getAttribute("aria-expanded")).toBe("false");
    fireEvent.focus(input);
    expect(input.getAttribute("aria-expanded")).toBe("true");
    const list = screen.getByRole("listbox");
    expect(input.getAttribute("aria-controls")).toBe(list.id);
    expect(screen.getAllByRole("option")).toHaveLength(2);
  });

  it("moves with ArrowDown / ArrowUp (aria-activedescendant), picks with Enter and closes with Escape", () => {
    const onPick = vi.fn();
    render(<AttributeKeyCombobox definitions={[SECURITY, RETENTION]} existingKeys={[]} onPick={onPick} />);
    const input = screen.getByRole("combobox", { name: "Attribute key" });
    fireEvent.focus(input);
    fireEvent.keyDown(input, { key: "ArrowDown" });
    const options = screen.getAllByRole("option");
    expect(input.getAttribute("aria-activedescendant")).toBe(options[0].id);
    expect(options[0].getAttribute("aria-selected")).toBe("true");
    fireEvent.keyDown(input, { key: "ArrowDown" });
    expect(input.getAttribute("aria-activedescendant")).toBe(options[1].id);
    fireEvent.keyDown(input, { key: "ArrowUp" });
    expect(input.getAttribute("aria-activedescendant")).toBe(options[0].id);
    fireEvent.keyDown(input, { key: "Escape" });
    expect(input.getAttribute("aria-expanded")).toBe("false");
    expect(screen.queryByRole("listbox")).toBeNull();
    fireEvent.keyDown(input, { key: "ArrowDown" }); // reopens on the first option
    fireEvent.keyDown(input, { key: "ArrowDown" });
    fireEvent.keyDown(input, { key: "Enter" });
    expect(onPick).toHaveBeenCalledWith("x-retentionDays", RETENTION);
  });

  it("says keys must start with x- for an unknown key that does not", () => {
    render(<AttributeKeyCombobox definitions={[SECURITY]} existingKeys={[]} onPick={() => {}} allowFreeKey={false} />);
    const input = screen.getByRole("combobox", { name: "Attribute key" });
    fireEvent.change(input, { target: { value: "owner" } });
    expect(screen.getByText("Keys must start with x-")).toBeTruthy();
    fireEvent.change(input, { target: { value: "x-sec" } });
    expect(screen.queryByText("Keys must start with x-")).toBeNull();
  });
});

describe("AttributeValueEditor validation timing (U6)", () => {
  const REQUIRED_STRING: ValueSchema = { type: "string", enum: ["a", "b"] };

  it("shows no problem for a freshly picked value until the user edits it", () => {
    const onChange = vi.fn();
    const { rerender } = render(<AttributeValueEditor schema={SECURITY.valueSchema} value={initialAttributeValue(SECURITY)} derivedKeys={["data_class"]} onChange={onChange} />);
    expect(screen.queryByRole("alert")).toBeNull();
    fireEvent.change(screen.getByLabelText("data_category"), { target: { value: "Intrinsic" } });
    rerender(<AttributeValueEditor schema={SECURITY.valueSchema} value={{ data_category: "Intrinsic" }} derivedKeys={["data_class"]} onChange={onChange} />);
    // Edited and valid; clearing back to the empty object now reports the missing member.
    rerender(<AttributeValueEditor schema={SECURITY.valueSchema} value={{}} derivedKeys={["data_class"]} onChange={onChange} />);
    expect(screen.getByRole("alert").textContent).toMatch(/required/i);
  });

  it("a fresh enum string shows no 'must be one of' before an edit", () => {
    render(<AttributeValueEditor schema={REQUIRED_STRING} value={initialAttributeValue({ valueSchema: REQUIRED_STRING })} onChange={() => {}} />);
    expect(screen.queryByRole("alert")).toBeNull();
  });

  it("a stored invalid value still shows its problem at once", () => {
    render(<AttributeValueEditor schema={RETENTION.valueSchema} value={0} onChange={() => {}} />);
    expect(screen.getByRole("alert").textContent).toContain("must be >= 1");
  });
});

describe("EntityAttributesSection label (U7)", () => {
  it("shows the attribute label once per row (the control keeps it as its accessible name)", () => {
    render(<EntityAttributesSection metadata={{ custom: { extensions: { "x-owner-team": "a" } } }} definitions={[ENTITY_ONLY]} isReadOnly={false} onSave={vi.fn()} />);
    const visible = screen.getAllByText("Owner team").filter((el) => !el.closest(".sr-only"));
    expect(visible).toHaveLength(1);
    expect(screen.getByLabelText("Owner team")).toBeTruthy();
  });
});

describe("derived class member label (U8)", () => {
  it("reads class2 (Class 2 — PII)", () => {
    render(<AttributeValueEditor schema={SECURITY.valueSchema} value={{ data_class: "class2" }} derivedKeys={["data_class"]} onChange={() => {}} />);
    expect((screen.getByLabelText("data_class") as HTMLInputElement).value).toBe("class2 (Class 2 — PII)");
  });

  it("leaves any other derived value as it is", () => {
    render(<AttributeValueEditor schema={SECURITY.valueSchema} value={{ data_class: "custom" }} derivedKeys={["data_class"]} onChange={() => {}} />);
    expect((screen.getByLabelText("data_class") as HTMLInputElement).value).toBe("custom");
  });
});
