// @vitest-environment jsdom
import { cleanup, fireEvent, screen, within } from "@testing-library/react";
import { afterEach, describe, expect, it } from "vitest";
import { field, renderField } from "./harness";

afterEach(cleanup);

const EXAMPLES = field("list", {
  key: "examples", label: "Examples",
  fields: [
    field("text", { key: "name", label: "Name" }),
    field("text", { key: "summary", label: "Summary" }),
    field("text", { key: "extra", label: "Extra", group: "more" }),
  ],
});
const PARAMETERS = field("list", {
  key: "parameters", label: "Parameters", mapKeyLabel: "Parameter name",
  fields: [field("text", { key: "description", label: "Description" }), field("text", { key: "default", label: "Default value" })],
});

const names = () => screen.queryAllByTestId(/^f-examples-\d+-name$/).map((el) => (el as HTMLInputElement).value);
const addExample = () => fireEvent.click(screen.getByRole("button", { name: "Add example" }));
const typeName = (i: number, text: string) => fireEvent.change(screen.getByTestId(`f-examples-${i}-name`), { target: { value: text } });

describe("list control (items in an array)", () => {
  it("is a labelled group with no cards and an Add button to start with", () => {
    renderField(EXAMPLES);
    const group = screen.getByRole("group", { name: "Examples" });
    expect(group.tagName).toBe("FIELDSET");
    expect(screen.getByTestId("f-examples")).toBe(group);
    expect(names()).toEqual([]);
    expect(screen.getByRole("button", { name: "Add example" })).toBeTruthy();
  });

  it("shows one card per item, each a labelled group rendering the item's fields", () => {
    renderField(EXAMPLES, { value: { examples: [{ name: "first" }, { name: "second", summary: "s" }] } });
    expect(names()).toEqual(["first", "second"]);
    const card = screen.getByRole("group", { name: "Example 2" });
    expect(card.getAttribute("data-testid")).toBe("f-examples-1");
    expect((within(card).getByLabelText("Summary") as HTMLInputElement).value).toBe("s");
  });

  it("Add appends an empty card and keeps it in the value as an empty item", () => {
    const { probe } = renderField(EXAMPLES);
    addExample();
    expect(names()).toEqual([""]);
    expect(probe.value).toEqual({ examples: [{}] });
    addExample();
    expect(names()).toEqual(["", ""]);
    expect(probe.value).toEqual({ examples: [{}, {}] });
  });

  it("edits an item and keeps the others", () => {
    const { probe } = renderField(EXAMPLES, { value: { examples: [{ name: "a" }, { name: "b" }] } });
    typeName(1, "bee");
    expect(probe.value).toEqual({ examples: [{ name: "a" }, { name: "bee" }] });
  });

  it("clearing every field of an item leaves an empty item, not a vanished card", () => {
    const { probe } = renderField(EXAMPLES, { value: { examples: [{ name: "a" }] } });
    typeName(0, "");
    expect(probe.value).toEqual({ examples: [{}] });
    expect(names()).toEqual([""]);
  });

  it("removes an item with its numbered button, and the key when the last one goes", () => {
    const { probe } = renderField(EXAMPLES, { value: { examples: [{ name: "a" }, { name: "b" }, { name: "c" }] } });
    fireEvent.click(screen.getByRole("button", { name: "Remove item 2" }));
    expect(probe.value).toEqual({ examples: [{ name: "a" }, { name: "c" }] });
    expect(names()).toEqual(["a", "c"]);
    fireEvent.click(screen.getByRole("button", { name: "Remove item 1" }));
    fireEvent.click(screen.getByRole("button", { name: "Remove item 1" }));
    expect(probe.value).toEqual({});
    expect(names()).toEqual([]);
  });

  it("moves an item up and down", () => {
    const { probe } = renderField(EXAMPLES, { value: { examples: [{ name: "a" }, { name: "b" }, { name: "c" }] } });
    fireEvent.click(screen.getByRole("button", { name: "Move item 3 up" }));
    expect(probe.value).toEqual({ examples: [{ name: "a" }, { name: "c" }, { name: "b" }] });
    expect(names()).toEqual(["a", "c", "b"]);
    fireEvent.click(screen.getByRole("button", { name: "Move item 1 down" }));
    expect(probe.value).toEqual({ examples: [{ name: "c" }, { name: "a" }, { name: "b" }] });
    expect(names()).toEqual(["c", "a", "b"]);
  });

  it("disables Move up on the first item and Move down on the last", () => {
    renderField(EXAMPLES, { value: { examples: [{ name: "a" }, { name: "b" }] } });
    expect((screen.getByRole("button", { name: "Move item 1 up" }) as HTMLButtonElement).disabled).toBe(true);
    expect((screen.getByRole("button", { name: "Move item 2 down" }) as HTMLButtonElement).disabled).toBe(true);
    expect((screen.getByRole("button", { name: "Move item 1 down" }) as HTMLButtonElement).disabled).toBe(false);
    expect((screen.getByRole("button", { name: "Move item 2 up" }) as HTMLButtonElement).disabled).toBe(false);
  });

  it("all item buttons are real buttons", () => {
    renderField(EXAMPLES, { value: { examples: [{ name: "a" }] } });
    for (const name of ["Move item 1 up", "Move item 1 down", "Remove item 1", "Add example"]) {
      const button = screen.getByRole("button", { name }) as HTMLButtonElement;
      expect(button.tagName).toBe("BUTTON");
      expect(button.type).toBe("button");
    }
  });

  it("moving an item takes its in-progress state along (it is the same card, not the same position)", () => {
    const { probe } = renderField(EXAMPLES, { value: { examples: [{ name: "a" }, { name: "b" }] } });
    // a More-properties group opened in card 1 follows card 1 to the bottom
    fireEvent.click(within(screen.getByTestId("f-examples-0")).getByTestId("f-examples-0-more-toggle"));
    expect(screen.getByTestId("f-examples-0-extra")).toBeTruthy();
    fireEvent.click(screen.getByRole("button", { name: "Move item 1 down" }));
    expect(probe.value).toEqual({ examples: [{ name: "b" }, { name: "a" }] });
    expect(within(screen.getByTestId("f-examples-1")).queryByTestId("f-examples-1-extra")).toBeTruthy();
    expect(within(screen.getByTestId("f-examples-0")).queryByTestId("f-examples-0-extra")).toBeNull();
  });

  it("names item field ids with the item's position", () => {
    renderField(EXAMPLES, { value: { examples: [{ name: "a" }, { name: "b" }] } });
    expect(screen.getByTestId("f-examples-0-summary")).toBeTruthy();
    expect(screen.getByTestId("f-examples-1-summary")).toBeTruthy();
  });

  it("shows an error on an item at its card and a field's error at the field", () => {
    renderField(EXAMPLES, {
      value: { examples: [{ name: "a" }, { name: "b" }] },
      errors: [{ pointer: "/examples/1", message: "Example 2 is not valid" }, { pointer: "/examples/0/name", message: "Name taken" }],
    });
    expect(screen.getByTestId("f-examples-1-error").textContent).toBe("Example 2 is not valid");
    expect(screen.getByTestId("f-examples-0-name-error").textContent).toBe("Name taken");
  });

  it("disables everything with the form", () => {
    renderField(EXAMPLES, { value: { examples: [{ name: "a" }, { name: "b" }] }, disabled: true });
    expect((screen.getByRole("button", { name: "Add example" }) as HTMLButtonElement).disabled).toBe(true);
    expect((screen.getByRole("button", { name: "Remove item 1" }) as HTMLButtonElement).disabled).toBe(true);
    expect((screen.getByTestId("f-examples-0-name") as HTMLInputElement).disabled).toBe(true);
  });

  it("follows an outside change to the items", () => {
    const { probe } = renderField(EXAMPLES, { value: { examples: [{ name: "a" }] } });
    probe.set({ examples: [{ name: "x" }, { name: "y" }] });
    expect(names()).toEqual(["x", "y"]);
  });
});

describe("list control (items in a map keyed by a name the user chooses)", () => {
  const nameInput = (i: number) => screen.getByTestId(`f-parameters-${i}-key`) as HTMLInputElement;
  const addParameter = () => fireEvent.click(screen.getByRole("button", { name: "Add parameter" }));

  it("shows a name input per entry, labelled with the template's mapKeyLabel", () => {
    renderField(PARAMETERS, { value: { parameters: { userId: { description: "The user" }, region: {} } } });
    expect(nameInput(0).value).toBe("userId");
    expect(nameInput(1).value).toBe("region");
    expect(screen.getByLabelText("Parameter name", { selector: '[data-testid="f-parameters-0-key"]' })).toBe(nameInput(0));
    expect((screen.getByTestId("f-parameters-0-description") as HTMLInputElement).value).toBe("The user");
  });

  it("writes the entries as a map, keeping an entry that has no properties (a declared parameter)", () => {
    const { probe } = renderField(PARAMETERS);
    addParameter();
    expect(probe.value).toEqual({});
    fireEvent.change(nameInput(0), { target: { value: "userId" } });
    expect(probe.value).toEqual({ parameters: { userId: {} } });
    fireEvent.change(screen.getByTestId("f-parameters-0-description"), { target: { value: "The user" } });
    expect(probe.value).toEqual({ parameters: { userId: { description: "The user" } } });
    fireEvent.change(screen.getByTestId("f-parameters-0-description"), { target: { value: "" } });
    expect(probe.value).toEqual({ parameters: { userId: {} } });
  });

  it("renaming an entry keeps its content and position", () => {
    const { probe } = renderField(PARAMETERS, { value: { parameters: { a: { default: "1" }, b: { default: "2" } } } });
    fireEvent.change(nameInput(0), { target: { value: "alpha" } });
    expect(probe.value).toEqual({ parameters: { alpha: { default: "1" }, b: { default: "2" } } });
    expect(Object.keys(probe.value.parameters as object)).toEqual(["alpha", "b"]);
  });

  it("holds an entry without a name locally and says it needs one once it has content", () => {
    const { probe } = renderField(PARAMETERS);
    addParameter();
    fireEvent.change(screen.getByTestId("f-parameters-0-default"), { target: { value: "x" } });
    expect(probe.value).toEqual({});
    expect(screen.getByTestId("f-parameters-0-problem").textContent).toBe("Enter a parameter name to save this entry.");
    fireEvent.change(nameInput(0), { target: { value: "p" } });
    expect(probe.value).toEqual({ parameters: { p: { default: "x" } } });
    expect(screen.queryByTestId("f-parameters-0-problem")).toBeNull();
  });

  it("flags a name that another entry already uses and does not write the second", () => {
    const { probe } = renderField(PARAMETERS, { value: { parameters: { a: {} } } });
    addParameter();
    fireEvent.change(nameInput(1), { target: { value: "a" } });
    expect(screen.getByTestId("f-parameters-1-problem").textContent).toBe("Another parameter already uses this name.");
    expect(nameInput(1).getAttribute("aria-invalid")).toBe("true");
    expect(probe.value).toEqual({ parameters: { a: {} } });
  });

  it("removes and reorders entries like array items, keeping the map order", () => {
    const { probe } = renderField(PARAMETERS, { value: { parameters: { a: {}, b: {}, c: {} } } });
    fireEvent.click(screen.getByRole("button", { name: "Move item 3 up" }));
    expect(Object.keys(probe.value.parameters as object)).toEqual(["a", "c", "b"]);
    fireEvent.click(screen.getByRole("button", { name: "Remove item 1" }));
    expect(probe.value).toEqual({ parameters: { c: {}, b: {} } });
    fireEvent.click(screen.getByRole("button", { name: "Remove item 1" }));
    fireEvent.click(screen.getByRole("button", { name: "Remove item 1" }));
    expect(probe.value).toEqual({});
  });

  it("an error on a map entry shows on its card, a field's error on the field", () => {
    renderField(PARAMETERS, {
      value: { parameters: { userId: {} } },
      errors: [{ pointer: "/parameters/userId", message: "Not used in the address" }, { pointer: "/parameters/userId/default", message: "Bad default" }],
    });
    expect(screen.getByTestId("f-parameters-0-error").textContent).toBe("Not used in the address");
    expect(screen.getByTestId("f-parameters-0-default-error").textContent).toBe("Bad default");
  });
});
