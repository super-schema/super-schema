/**
 * The quick editor stores a field's default with the type the field gives it: a number stays a number through an unrelated save, a
 * typed default is saved typed, and text that does not fit the field's type is refused with the reason (nothing is saved).
 *
 * @vitest-environment jsdom
 */

import { describe, it, expect, vi, afterEach } from "vitest";
import { createElement } from "react";
import { render, screen, fireEvent, waitFor, cleanup } from "@testing-library/react";

afterEach(() => {
  cleanup();
});

vi.mock("next/link", () => ({
  default: ({ children, href }: { children: React.ReactNode; href: string }) =>
    createElement("a", { href }, children),
}));

vi.mock("@/components/ui/popover", () => ({
  Popover: ({ children }: { children: React.ReactNode }) => createElement("div", null, children),
  PopoverTrigger: ({ children }: { children: React.ReactNode }) => createElement("button", null, children),
  PopoverContent: ({ children }: { children: React.ReactNode }) => createElement("div", null, children),
}));

vi.mock("@/components/custom/TypePicker", () => ({
  TypePicker: ({ value }: { value: string }) => createElement("select", { value, onChange: () => undefined }),
}));

import { FieldQuickEditPanel } from "@/components/custom/FieldQuickEditPanel/FieldQuickEditPanel";

function fieldWith(type: string, defaultValue: unknown) {
  return {
    id: "field-1",
    name: "count",
    type,
    precision: null,
    scale: null,
    nullable: false,
    isKey: false,
    fieldNumber: null,
    description: "How many",
    classification: null,
    aliases: [],
    decorators: { typespec: { identity: { defaultValue } } },
    sortOrder: 1,
  };
}

function renderPanel(field: ReturnType<typeof fieldWith>) {
  const onUpdateField = vi.fn().mockResolvedValue(undefined);
  render(createElement(FieldQuickEditPanel, { field, entityId: "ent-1", domainSlug: "crm", onUpdateField }));
  return onUpdateField;
}

/** The default the save wrote for the field (the decorators it sent). */
function savedDefault(onUpdateField: ReturnType<typeof vi.fn>): unknown {
  const [, data] = onUpdateField.mock.calls[0] as [string, { decorators: { typespec: { identity?: { defaultValue?: unknown } } } }];
  return data.decorators.typespec.identity?.defaultValue;
}

describe("FieldQuickEditPanel default value", () => {
  it("shows a stored whole number past 2^53 on an integer field as the exact digits the generator writes", () => {
    renderPanel(fieldWith("int64", 2 ** 60));
    expect((screen.getByLabelText("Default value") as HTMLInputElement).value).toBe("1152921504606846976");
  });

  it("keeps a stored number a number when an unrelated edit is saved", async () => {
    const onUpdateField = renderPanel(fieldWith("int32", 5));
    fireEvent.click(screen.getByText("How many"));
    fireEvent.change(screen.getByLabelText("Field description"), { target: { value: "How many orders" } });
    fireEvent.click(screen.getByTestId("field-save-btn"));
    await waitFor(() => expect(onUpdateField).toHaveBeenCalledTimes(1));
    expect(savedDefault(onUpdateField)).toBe(5);
  });

  it("saves a typed numeric default as a number", async () => {
    const numeric = renderPanel(fieldWith("int32", 5));
    fireEvent.change(screen.getByLabelText("Default value"), { target: { value: "6" } });
    fireEvent.click(screen.getByTestId("field-save-btn"));
    await waitFor(() => expect(numeric).toHaveBeenCalledTimes(1));
    expect(savedDefault(numeric)).toBe(6);
  });

  it("saves a boolean default as a boolean", async () => {
    const onUpdateField = renderPanel(fieldWith("boolean", true));
    fireEvent.change(screen.getByLabelText("Default value"), { target: { value: "false" } });
    fireEvent.click(screen.getByTestId("field-save-btn"));
    await waitFor(() => expect(onUpdateField).toHaveBeenCalledTimes(1));
    expect(savedDefault(onUpdateField)).toBe(false);
  });

  it("keeps a text default as text", async () => {
    const onUpdateField = renderPanel(fieldWith("string", "old"));
    fireEvent.change(screen.getByLabelText("Default value"), { target: { value: "INV-0" } });
    fireEvent.click(screen.getByTestId("field-save-btn"));
    await waitFor(() => expect(onUpdateField).toHaveBeenCalledTimes(1));
    expect(savedDefault(onUpdateField)).toBe("INV-0");
  });

  it("refuses a default that does not fit the field's type, saves nothing, and says why", async () => {
    const onUpdateField = renderPanel(fieldWith("int32", 5));
    fireEvent.change(screen.getByLabelText("Default value"), { target: { value: "abc" } });
    fireEvent.click(screen.getByTestId("field-save-btn"));
    await waitFor(() => expect(screen.getByRole("alert").textContent).toContain('Default value "abc" is not a number.'));
    expect(onUpdateField).not.toHaveBeenCalled();
  });

  it("removes the default when its input is emptied", async () => {
    const onUpdateField = renderPanel(fieldWith("int32", 5));
    fireEvent.change(screen.getByLabelText("Default value"), { target: { value: "" } });
    fireEvent.click(screen.getByTestId("field-save-btn"));
    await waitFor(() => expect(onUpdateField).toHaveBeenCalledTimes(1));
    expect(savedDefault(onUpdateField)).toBeUndefined();
  });

  it("keeps a stored default that no longer fits its type, unchanged, when an unrelated edit is saved", async () => {
    const onUpdateField = renderPanel(fieldWith("int32", 1.5));
    fireEvent.click(screen.getByText("How many"));
    fireEvent.change(screen.getByLabelText("Field description"), { target: { value: "How many orders" } });
    fireEvent.click(screen.getByTestId("field-save-btn"));
    await waitFor(() => expect(onUpdateField).toHaveBeenCalledTimes(1));
    expect(savedDefault(onUpdateField)).toBe(1.5);
    expect(screen.queryByRole("alert")).toBeNull();
  });

  it("keeps stored text that does not fit a numeric field, unchanged, when an unrelated edit is saved", async () => {
    const onUpdateField = renderPanel(fieldWith("int32", "abc"));
    fireEvent.click(screen.getByText("How many"));
    fireEvent.change(screen.getByLabelText("Field description"), { target: { value: "How many orders" } });
    fireEvent.click(screen.getByTestId("field-save-btn"));
    await waitFor(() => expect(onUpdateField).toHaveBeenCalledTimes(1));
    expect(savedDefault(onUpdateField)).toBe("abc");
  });
});
