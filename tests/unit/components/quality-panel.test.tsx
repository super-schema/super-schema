/** @vitest-environment jsdom */
import { afterEach, describe, it, expect } from "vitest";
import { useState } from "react";
import { cleanup, fireEvent, render, screen } from "@testing-library/react";
import { QualityPanel } from "@/app/(dashboard)/schemas/[domainSlug]/[productSlug]/[entityId]/fields/[fieldId]/panels/QualityPanel";
import type { Governance } from "@/types/schemas/typespec-decorator.schema";

afterEach(cleanup);

function Harness({ initial = [] as Governance["qualityRules"] }) {
  const [governance, setGovernance] = useState<Governance>({ qualityRules: initial });
  return (
    <>
      <QualityPanel governance={governance} onChange={setGovernance} />
      <output data-testid="stored">{JSON.stringify(governance.qualityRules)}</output>
    </>
  );
}
const stored = () => JSON.parse(screen.getByTestId("stored").textContent!);
const add = (label: string) => fireEvent.click(screen.getByRole("button", { name: `Add ${label} rule` }));
const type = (name: string, value: string) =>
  fireEvent.change(screen.getByLabelText(name), { target: { value } });

describe("adding and removing quality rules", () => {
  it("adds a rule from a quick-add button with a visible one-line summary", () => {
    render(<Harness />);
    add("Range");
    expect(stored()).toEqual([{ type: "range", params: { severity: "error" } }]);
    expect(screen.getByText("No bounds set")).toBeDefined();
  });

  it("allows only one unique and one not-null rule per field", () => {
    render(<Harness />);
    add("Unique");
    expect((screen.getByRole("button", { name: "Add Unique rule" }) as HTMLButtonElement).disabled).toBe(true);
    add("Not null");
    expect((screen.getByRole("button", { name: "Add Not null rule" }) as HTMLButtonElement).disabled).toBe(true);
    expect(stored()).toHaveLength(2);
  });

  it("removes a rule with its labelled remove control", () => {
    render(<Harness initial={[{ type: "unique", params: {} }, { type: "range", params: { min: 1 } }]} />);
    fireEvent.click(screen.getByRole("button", { name: "Remove Range rule 2" }));
    expect(stored()).toEqual([{ type: "unique", params: {} }]);
  });
});

describe("type-specific inputs", () => {
  it("writes range bounds and summarises them", () => {
    render(<Harness />);
    add("Range");
    type("Range rule 1 minimum", "0");
    type("Range rule 1 maximum", "100");
    expect(stored()[0].params).toEqual({ severity: "error", min: 0, max: 100 });
    expect(screen.getByText("Between 0 and 100")).toBeDefined();
  });

  it("reports an inverted range inline and does not hide the stored value", () => {
    render(<Harness initial={[{ type: "range", params: { min: 10, max: 2 } }]} />);
    expect(screen.getByRole("alert").textContent).toContain("Maximum must be at least the minimum.");
    expect(screen.getByLabelText("Range rule 1 maximum").getAttribute("aria-invalid")).toBe("true");
  });

  it("tests a regex against a sample and rejects an invalid pattern", () => {
    render(<Harness />);
    add("Regex");
    type("Regex rule 1 pattern", "(");
    expect(screen.getByRole("alert").textContent).toContain("valid regular expression");
    type("Regex rule 1 pattern", "^[A-Z]+$");
    type("Regex rule 1 test value", "ABC");
    expect(screen.getByText("Matches the pattern")).toBeDefined();
    expect(screen.getByText("Matches ^[A-Z]+$")).toBeDefined();
  });

  it("collects enum values with the shared chip editor", () => {
    render(<Harness />);
    add("Enum");
    type("Enum rule 1 new value", "OPEN,CLOSED");
    expect(stored()[0].params.values).toEqual(["OPEN"]);
    type("Enum rule 1 new value", "CLOSED");
    fireEvent.keyDown(screen.getByLabelText("Enum rule 1 new value"), { key: "Enter" });
    expect(stored()[0].params.values).toEqual(["OPEN", "CLOSED"]);
    expect(screen.getByText("One of 2 values")).toBeDefined();
  });

  it("requires a threshold between 0 and 100 for not-null when one is given", () => {
    render(<Harness />);
    add("Not null");
    type("Not null rule 1 minimum non-null percent", "120");
    expect(screen.getByRole("alert").textContent).toContain("from 0 to 100");
    type("Not null rule 1 minimum non-null percent", "95");
    expect(stored()[0].params.threshold).toBe(95);
  });

  it("requires a custom expression and stores the name", () => {
    render(<Harness />);
    add("Custom");
    expect(screen.getByRole("alert").textContent).toContain("Enter an expression.");
    type("Custom rule 1 name", "ends-with-dot");
    type("Custom rule 1 expression", "right(value, 1) = '.'");
    expect(stored()[0].params).toEqual({ severity: "error", name: "ends-with-dot", expression: "right(value, 1) = '.'" });
  });
});

describe("parameters are preserved", () => {
  it("keeps unknown parameter keys when a known key is edited", () => {
    render(<Harness initial={[{ type: "range", params: { min: 1, owner: "data-team", severity: "warning" } }]} />);
    type("Range rule 1 maximum", "9");
    expect(stored()[0].params).toEqual({ min: 1, max: 9, owner: "data-team", severity: "warning" });
    expect((screen.getByLabelText("Range rule 1 severity") as HTMLSelectElement).value).toBe("warning");
  });

  it("stores severity as a parameter and changes it on the card", () => {
    render(<Harness initial={[{ type: "unique", params: {} }]} />);
    fireEvent.change(screen.getByLabelText("Unique rule 1 severity"), { target: { value: "warning" } });
    expect(stored()).toEqual([{ type: "unique", params: { severity: "warning" } }]);
  });

  it("flags a rule type it cannot edit but keeps its parameters", () => {
    render(<Harness initial={[{ type: "legacy-check", params: { note: "keep" } }]} />);
    expect(screen.getByText("Unrecognised type")).toBeDefined();
    expect(stored()).toEqual([{ type: "legacy-check", params: { note: "keep" } }]);
  });
});
