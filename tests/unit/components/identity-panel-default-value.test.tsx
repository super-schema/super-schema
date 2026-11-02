/**
 * The Field Studio's Default Value input stores a number for a numeric field and text otherwise, and keeps what is being typed readable.
 *
 * @vitest-environment jsdom
 */

import { describe, it, expect, vi, afterEach } from "vitest";
import { createElement, useState } from "react";
import { render, screen, fireEvent, cleanup } from "@testing-library/react";
import { IdentityPanel } from "@/app/(dashboard)/schemas/[domainSlug]/[productSlug]/[entityId]/fields/[fieldId]/panels/IdentityPanel";
import type { Identity } from "@/types/schemas/typespec-decorator.schema";

afterEach(() => {
  cleanup();
});

/** The panel under a parent that keeps the identity it is given back, as the Field Studio does. */
function renderPanel(fieldType: string, defaultValue: unknown) {
  const onIdentityChange = vi.fn();
  function Parent() {
    const [identity, setIdentity] = useState<Identity>({ defaultValue } as Identity);
    return createElement(IdentityPanel, {
      identity,
      fieldType,
      isOptional: false,
      onIdentityChange: (next: Identity) => {
        onIdentityChange(next);
        setIdentity(next);
      },
      onOptionalChange: vi.fn(),
    });
  }
  render(createElement(Parent));
  return { onIdentityChange, input: screen.getByTestId("field-default-value") as HTMLInputElement };
}

describe("IdentityPanel default value", () => {
  it("shows a stored whole number past 2^53 on an integer field as the exact digits the generator writes", () => {
    const { input } = renderPanel("int64", 2 ** 60);
    expect(input.value).toBe("1152921504606846976");
  });

  it("stores a number for a numeric field", () => {
    const { onIdentityChange, input } = renderPanel("int32", 5);
    fireEvent.change(input, { target: { value: "7" } });
    expect(onIdentityChange).toHaveBeenLastCalledWith(expect.objectContaining({ defaultValue: 7 }));
  });

  it("stores the value the quick editor stores for the same text, and keeps the text typed on screen", () => {
    const { onIdentityChange, input } = renderPanel("float64", 1);
    fireEvent.change(input, { target: { value: "1." } });
    expect(onIdentityChange).toHaveBeenLastCalledWith(expect.objectContaining({ defaultValue: 1 }));
    expect(input.value).toBe("1.");
    fireEvent.change(input, { target: { value: "19.990" } });
    expect(onIdentityChange).toHaveBeenLastCalledWith(expect.objectContaining({ defaultValue: 19.99 }));
    expect(input.value).toBe("19.990");
  });

  it("stores a whole number text reads as as that number, and an exact integer text past 2^53 as its digits", () => {
    const { onIdentityChange, input } = renderPanel("int64", 1);
    fireEvent.change(input, { target: { value: "5.0" } });
    expect(onIdentityChange).toHaveBeenLastCalledWith(expect.objectContaining({ defaultValue: 5 }));
    expect(input.value).toBe("5.0");
    fireEvent.change(input, { target: { value: "9223372036854775807" } });
    expect(onIdentityChange).toHaveBeenLastCalledWith(expect.objectContaining({ defaultValue: "9223372036854775807" }));
  });

  it("shows the stored value once it changes outside the input", () => {
    const onIdentityChange = vi.fn();
    const props = (defaultValue: unknown) => ({
      identity: { defaultValue },
      fieldType: "int32",
      isOptional: false,
      onIdentityChange,
      onOptionalChange: vi.fn(),
    });
    const { rerender } = render(createElement(IdentityPanel, props(5)));
    const input = screen.getByTestId("field-default-value") as HTMLInputElement;
    fireEvent.change(input, { target: { value: "5.0" } });
    expect(input.value).toBe("5.0");
    rerender(createElement(IdentityPanel, props(7)));
    expect(input.value).toBe("7");
  });

  it("says why text that does not fit the field's type is not written", () => {
    const { input } = renderPanel("int32", 5);
    fireEvent.change(input, { target: { value: "abc" } });
    expect(screen.getByText('Default value "abc" is not a number.')).toBeTruthy();
    fireEvent.change(input, { target: { value: "" } });
    expect(screen.queryByText(/Default value/)).toBeNull();
  });

  it("stores text as text, and an emptied input as null", () => {
    const { onIdentityChange, input } = renderPanel("string", "old");
    fireEvent.change(input, { target: { value: "INV-0" } });
    expect(onIdentityChange).toHaveBeenLastCalledWith(expect.objectContaining({ defaultValue: "INV-0" }));
    fireEvent.change(input, { target: { value: "" } });
    expect(onIdentityChange).toHaveBeenLastCalledWith(expect.objectContaining({ defaultValue: null }));
  });

  it("keeps text that does not fit a numeric field, for the generator to withhold with a warning", () => {
    const { onIdentityChange, input } = renderPanel("int32", 5);
    fireEvent.change(input, { target: { value: "abc" } });
    expect(onIdentityChange).toHaveBeenLastCalledWith(expect.objectContaining({ defaultValue: "abc" }));
  });

  it("says why an ISO timestamp is not written as a date default, and stores the constructor TypeSpec writes", () => {
    const { onIdentityChange, input } = renderPanel("utcDateTime", null);
    fireEvent.change(input, { target: { value: "2024-05-06T12:20:00Z" } });
    expect(screen.getByText(/Default value "2024-05-06T12:20:00Z" is not a utcDateTime value/)).toBeTruthy();
    fireEvent.change(input, { target: { value: "utcDateTime.now()" } });
    expect(onIdentityChange).toHaveBeenLastCalledWith(expect.objectContaining({ defaultValue: "utcDateTime.now()" }));
    expect(screen.queryByText(/Default value/)).toBeNull();
  });
});
