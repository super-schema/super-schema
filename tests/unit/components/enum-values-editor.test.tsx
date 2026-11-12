/** @vitest-environment jsdom */
import { afterEach, describe, it, expect } from "vitest";
import { useState } from "react";
import { cleanup, fireEvent, render, screen } from "@testing-library/react";
import { EnumValuesEditor } from "@/components/custom/FieldAttributes/EnumValuesEditor";

afterEach(cleanup);

function Harness({ initial = [] as string[] }) {
  const [values, setValues] = useState(initial);
  return (
    <>
      <EnumValuesEditor label="Enum values" values={values} onChange={setValues} />
      <output data-testid="stored">{JSON.stringify(values)}</output>
    </>
  );
}

const stored = () => JSON.parse(screen.getByTestId("stored").textContent!) as string[];
const typeInto = (value: string) =>
  fireEvent.change(screen.getByLabelText("New value"), { target: { value } });
const pressEnter = (element: HTMLElement) =>
  fireEvent.keyDown(element, { key: "Enter" });

describe("EnumValuesEditor adding values", () => {
  it("adds a trimmed value on Enter and clears the draft", () => {
    render(<Harness />);
    typeInto("  ACTIVE  ");
    pressEnter(screen.getByLabelText("New value"));
    expect(stored()).toEqual(["ACTIVE"]);
    expect((screen.getByLabelText("New value") as HTMLInputElement).value).toBe("");
    expect(screen.getByText("1 value")).toBeDefined();
  });

  it("adds a value on a comma and keeps the text after it in the draft", () => {
    render(<Harness />);
    typeInto("PENDING,CLOS");
    expect(stored()).toEqual(["PENDING"]);
    expect((screen.getByLabelText("New value") as HTMLInputElement).value).toBe("CLOS");
  });

  it("adds every entry of a pasted comma or line separated list in order", () => {
    render(<Harness initial={["ZERO"]} />);
    fireEvent.paste(screen.getByLabelText("New value"), {
      clipboardData: { getData: () => "ONE, TWO\nTHREE,\n" },
    });
    expect(stored()).toEqual(["ZERO", "ONE", "TWO", "THREE"]);
    expect((screen.getByLabelText("New value") as HTMLInputElement).value).toBe("");
    expect(screen.getByText("4 values")).toBeDefined();
  });

  it("refuses an empty value with an inline message", () => {
    render(<Harness />);
    pressEnter(screen.getByLabelText("New value"));
    expect(stored()).toEqual([]);
    expect(screen.getByRole("alert").textContent).toContain("Type a value");
  });

  it("refuses a duplicate, reports it, and keeps the typed text so it can be corrected", () => {
    render(<Harness initial={["ACTIVE"]} />);
    typeInto("ACTIVE");
    pressEnter(screen.getByLabelText("New value"));
    expect(stored()).toEqual(["ACTIVE"]);
    expect(screen.getByRole("alert").textContent).toContain("“ACTIVE” is already in the list.");
    expect((screen.getByLabelText("New value") as HTMLInputElement).value).toBe("ACTIVE");
  });

  it("skips duplicates inside a pasted list, reports them, and adds the rest", () => {
    render(<Harness initial={["A"]} />);
    fireEvent.paste(screen.getByLabelText("New value"), {
      clipboardData: { getData: () => "A,B\n" },
    });
    expect(stored()).toEqual(["A", "B"]);
    expect(screen.getByRole("alert").textContent).toContain("“A” is already in the list.");
  });

  it("adds through the Add button", () => {
    render(<Harness />);
    typeInto("NEW");
    fireEvent.click(screen.getByRole("button", { name: "Add" }));
    expect(stored()).toEqual(["NEW"]);
  });
});

describe("EnumValuesEditor managing values", () => {
  it("removes a value through its labelled remove control", () => {
    render(<Harness initial={["A", "B", "C"]} />);
    fireEvent.click(screen.getByRole("button", { name: "Remove B" }));
    expect(stored()).toEqual(["A", "C"]);
    expect(screen.getByText("Removed “B”.")).toBeDefined();
  });

  it("edits a value inline on click and commits on Enter", () => {
    render(<Harness initial={["A", "B"]} />);
    fireEvent.click(screen.getByRole("button", { name: "Edit value A" }));
    const input = screen.getByRole("textbox", { name: "Edit value A" });
    fireEvent.change(input, { target: { value: "Z" } });
    pressEnter(input);
    expect(stored()).toEqual(["Z", "B"]);
  });

  it("keeps the edit open for an empty or duplicate replacement", () => {
    render(<Harness initial={["A", "B"]} />);
    fireEvent.click(screen.getByRole("button", { name: "Edit value A" }));
    fireEvent.change(screen.getByRole("textbox", { name: "Edit value A" }), { target: { value: "  " } });
    pressEnter(screen.getByRole("textbox", { name: "Edit value A" }));
    expect(screen.getByRole("alert").textContent).toContain("cannot be empty");
    fireEvent.change(screen.getByRole("textbox", { name: "Edit value A" }), { target: { value: "B" } });
    pressEnter(screen.getByRole("textbox", { name: "Edit value A" }));
    expect(screen.getByRole("alert").textContent).toContain("“B” is already in the list.");
    expect(stored()).toEqual(["A", "B"]);
  });

  it("cancels an edit on Escape without changing the value", () => {
    render(<Harness initial={["A"]} />);
    fireEvent.click(screen.getByRole("button", { name: "Edit value A" }));
    const input = screen.getByRole("textbox", { name: "Edit value A" });
    fireEvent.change(input, { target: { value: "Changed" } });
    fireEvent.keyDown(input, { key: "Escape" });
    expect(stored()).toEqual(["A"]);
    expect(screen.getByRole("button", { name: "Edit value A" })).toBeDefined();
  });

  it("moves a value with Alt+ArrowRight and Alt+ArrowLeft and keeps focus on it", () => {
    render(<Harness initial={["A", "B", "C"]} />);
    fireEvent.keyDown(screen.getByRole("button", { name: "Edit value A" }), {
      key: "ArrowRight",
      altKey: true,
    });
    expect(stored()).toEqual(["B", "A", "C"]);
    expect(document.activeElement?.getAttribute("aria-label")).toBe("Edit value A");
    fireEvent.keyDown(document.activeElement!, { key: "ArrowLeft", altKey: true });
    expect(stored()).toEqual(["A", "B", "C"]);
  });

  it("does not move the first value left or the last value right", () => {
    render(<Harness initial={["A", "B"]} />);
    fireEvent.keyDown(screen.getByRole("button", { name: "Edit value A" }), { key: "ArrowLeft", altKey: true });
    fireEvent.keyDown(screen.getByRole("button", { name: "Edit value B" }), { key: "ArrowRight", altKey: true });
    expect(stored()).toEqual(["A", "B"]);
  });

  it("disables every control when the parent fieldset is disabled (read-only mode)", () => {
    render(
      <fieldset disabled>
        <EnumValuesEditor label="Enum values" values={["A"]} onChange={() => undefined} />
      </fieldset>,
    );
    expect(screen.getByRole("button", { name: "Remove A" }).matches(":disabled")).toBe(true);
    expect(screen.getByRole("button", { name: "Edit value A" }).matches(":disabled")).toBe(true);
    expect(screen.getByLabelText("New value").matches(":disabled")).toBe(true);
  });
});
