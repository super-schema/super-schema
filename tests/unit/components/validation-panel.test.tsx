/** @vitest-environment jsdom */
import { afterEach, describe, it, expect, vi } from "vitest";
import { cleanup, fireEvent, render, screen } from "@testing-library/react";
import { useState } from "react";
import { ValidationPanel } from "@/app/(dashboard)/schemas/[domainSlug]/[productSlug]/[entityId]/fields/[fieldId]/panels/ValidationPanel";
import { FieldAttributeSections } from "@/app/(dashboard)/schemas/[domainSlug]/[productSlug]/[entityId]/fields/[fieldId]/panels/FieldAttributeSections";

afterEach(cleanup);

function panel(fieldType: string, validation: Record<string, unknown>, extra = {}) {
  const onChange = vi.fn();
  render(
    <ValidationPanel
      fieldType={fieldType}
      validation={validation}
      onChange={onChange}
      {...extra}
    />,
  );
  return onChange;
}

describe("validation controls follow the TypeSpec target of the field type", () => {
  it("shows no constraint controls for an enum and explains why", () => {
    panel("enum", {});
    expect(screen.getByText(/Enum fields have no TypeSpec validators/)).toBeDefined();
    expect(screen.queryByLabelText("Pattern")).toBeNull();
    expect(screen.queryByLabelText("Minimum length")).toBeNull();
  });

  it("writes the decorator hint next to each numeric control", () => {
    panel("int32", {});
    expect(screen.getByLabelText("Minimum value")).toBeDefined();
    expect(screen.getByText("@minValue")).toBeDefined();
    expect(screen.getByText("@maxValue")).toBeDefined();
  });

  it("switches the boundary decorator to the exclusive form", () => {
    function Harness() {
      const [validation, setValidation] = useState<Record<string, unknown>>({ minValue: 3 });
      return (
        <>
          <ValidationPanel fieldType="int32" validation={validation} onChange={setValidation} />
          <output data-testid="stored">{JSON.stringify(validation)}</output>
        </>
      );
    }
    render(<Harness />);
    fireEvent.change(screen.getByLabelText("Minimum boundary"), { target: { value: "exclusive" } });
    expect(JSON.parse(screen.getByTestId("stored").textContent!)).toEqual({ minValueExclusive: 3, minValue: null });
    expect(screen.getByText("@minValueExclusive")).toBeDefined();
  });

  it("offers length and pattern on a string, with @format left to Properties", () => {
    panel("string", {});
    expect(screen.getByLabelText("Minimum length")).toBeDefined();
    expect(screen.getByText("@minLength")).toBeDefined();
    expect(screen.getByLabelText("Pattern")).toBeDefined();
    expect(screen.getByText("@pattern")).toBeDefined();
    expect(screen.getByText(/format \(@format\) is set under Properties/)).toBeDefined();
    expect(screen.queryByLabelText("Minimum value")).toBeNull();
  });

  it("offers item-count bounds on an array and no element-level validators", () => {
    panel("array", {});
    expect(screen.getByLabelText("Minimum items")).toBeDefined();
    expect(screen.getByText("@maxItems")).toBeDefined();
    expect(screen.queryByLabelText("Minimum length")).toBeNull();
    expect(screen.queryByLabelText("Pattern")).toBeNull();
  });

  it("tells the user a bound that the emitter will not write", () => {
    panel("int8", { minValue: 500 });
    expect(screen.getByText(/Stored, but not written to TypeSpec/)).toBeDefined();
  });
});

describe("stale validation values", () => {
  it("offers Clear for a legacy pattern that holds non-symbol text on an enum", () => {
    const onChange = panel("enum", { pattern: "^[A-Z]+$" });
    fireEvent.click(screen.getByRole("button", { name: "Clear stored @pattern value" }));
    expect(onChange).toHaveBeenCalledWith({ pattern: null });
  });

  it("does not offer Clear for enum symbols that are still the enum's values", () => {
    panel("enum", { pattern: "A|B|C" }, { enumSymbolsInPattern: true });
    expect(screen.queryByRole("button", { name: /Clear stored/ })).toBeNull();
    expect(screen.getByText(/Enum values are still stored in the legacy pattern/)).toBeDefined();
  });

  it("offers Clear for a bound stored on a type that does not take it", () => {
    const onChange = panel("boolean", { minValue: 1 });
    fireEvent.click(screen.getByRole("button", { name: "Clear stored @minValue value" }));
    expect(onChange).toHaveBeenCalledWith({ minValue: null });
  });
});

describe("the Validation summary counts only applicable constraints", () => {
  function sections(fieldType: string, validation: Record<string, unknown>, aliases: string[] = []) {
    render(
      <FieldAttributeSections
        fieldType={fieldType}
        typespec={{ validation }}
        identity={{}}
        optional={false}
        allowNull={false}
        classification={null}
        fieldNumber={null}
        extras={{ precision: null, scale: null, aliases, decorators: {} }}
        expanded={[]}
        onExpandedChange={() => undefined}
        onTypespecChange={() => undefined}
        onIdentityChange={() => undefined}
        onOptionalChange={() => undefined}
        onAllowNullChange={() => undefined}
        onClassificationChange={() => undefined}
        onFieldNumberChange={() => undefined}
        onExtrasChange={() => undefined}
      />,
    );
  }

  it("does not say Configured for an enum whose only validator is a legacy pattern", () => {
    sections("enum", { pattern: "A|B|C" });
    expect(screen.queryByText("Configured")).toBeNull();
  });

  it("says Configured when an applicable constraint is set", () => {
    sections("string", { minLength: 2 });
    expect(screen.getByText("Configured")).toBeDefined();
  });
});
