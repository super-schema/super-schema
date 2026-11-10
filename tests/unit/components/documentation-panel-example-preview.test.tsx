/**
 * The Documentation panel's @example preview says what the generator writes for the field's type. It shows the literal for a scalar or an
 * object, the reason for a value withheld, and, for a type whose literal depends on the field's members (an enum, a list, a union), a
 * no literal when it cannot validate the field's members. It never claims a write it cannot verify.
 *
 * @vitest-environment jsdom
 */

import { describe, it, expect, vi, afterEach } from "vitest";
import { createElement } from "react";
import { render, screen, cleanup, fireEvent } from "@testing-library/react";
import { DocumentationPanel } from "@/app/(dashboard)/schemas/[domainSlug]/[productSlug]/[entityId]/fields/[fieldId]/panels/DocumentationPanel";

afterEach(() => {
  cleanup();
});

function renderPanel(fieldType: string, example: unknown) {
  render(
    createElement(DocumentationPanel, {
      documentation: { example } as never,
      fieldType,
      onChange: vi.fn(),
    }),
  );
}

describe("DocumentationPanel example preview", () => {
  it("shows the literal the generator writes for a text field", () => {
    renderPanel("string", "Dr. Smith");
    expect(screen.getByText('"Dr. Smith"', { selector: "code" })).toBeTruthy();
  });

  it("shows the reason an example is withheld for a numeric field", () => {
    renderPanel("int32", "abc");
    expect(screen.getByRole("alert").textContent).toMatch(/"abc" is not a number/);
  });

  it("shows the constructor a date example is written as, and says why a date text is not written", () => {
    renderPanel("utcDateTime", 'utcDateTime.fromISO("2024-05-06T12:20:00Z")');
    expect(screen.getByText('utcDateTime.fromISO("2024-05-06T12:20:00Z")', { selector: "code" })).toBeTruthy();
    cleanup();
    renderPanel("utcDateTime", "2024-05-06T12:20:00Z");
    expect(screen.getByRole("alert").textContent).toMatch(/utcDateTime value/);
  });

  it("keeps the example of a text field as typed, and parses the example of a numeric field", () => {
    const onChange = vi.fn();
    render(createElement(DocumentationPanel, { documentation: {} as never, fieldType: "string", onChange }));
    fireEvent.change(screen.getByLabelText("Example"), { target: { value: "1.50" } });
    expect(onChange).toHaveBeenLastCalledWith({ example: "1.50" });
    cleanup();
    const numeric = vi.fn();
    render(createElement(DocumentationPanel, { documentation: {} as never, fieldType: "int32", onChange: numeric }));
    fireEvent.change(screen.getByLabelText("Example"), { target: { value: "42" } });
    expect(numeric).toHaveBeenLastCalledWith({ example: 42 });
  });

  it("does not claim a write for an enum example it cannot check", () => {
    renderPanel("enum", "GONE");
    expect(screen.queryByText("Written as a value of the field's type.")).toBeNull();
    expect(document.querySelector("code")).toBeNull();
  });
});
