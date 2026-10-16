// @vitest-environment jsdom
import { cleanup, fireEvent, screen } from "@testing-library/react";
import { afterEach, describe, expect, it } from "vitest";
import { field, renderField } from "./harness";

afterEach(cleanup);

const box = () => screen.getByTestId("f-thing") as HTMLTextAreaElement;
const type = (text: string) => fireEvent.change(box(), { target: { value: text } });

describe("json control", () => {
  const JSON_FIELD = field("json", { label: "Headers" });

  it("is a textarea with a visible label showing the value as pretty JSON", () => {
    renderField(JSON_FIELD, { value: { thing: { traceId: "abc", n: [1, 2] } } });
    expect(screen.getByLabelText("Headers")).toBe(box());
    expect(box().tagName).toBe("TEXTAREA");
    expect(box().value).toBe(JSON.stringify({ traceId: "abc", n: [1, 2] }, null, 2));
    expect(box().getAttribute("spellcheck")).toBe("false");
  });

  it("writes the parsed value once the text is valid JSON", () => {
    const { probe } = renderField(JSON_FIELD);
    type('{ "orderId": "o-1", "lines": [1, 2] }');
    expect(probe.value).toEqual({ thing: { orderId: "o-1", lines: [1, 2] } });
    expect(screen.queryByTestId("f-thing-validation")).toBeNull();
  });

  it("accepts any JSON value, such as a string, number or array (an example payload can be one)", () => {
    const { probe } = renderField(JSON_FIELD);
    type('"just text"');
    expect(probe.value).toEqual({ thing: "just text" });
    type("42");
    expect(probe.value).toEqual({ thing: 42 });
    type("[1,2]");
    expect(probe.value).toEqual({ thing: [1, 2] });
    type("false");
    expect(probe.value).toEqual({ thing: false });
  });

  it("keeps invalid text in the box, shows the error and writes nothing", () => {
    const { probe } = renderField(JSON_FIELD, { value: { thing: { a: 1 } } });
    type('{ "a": ');
    expect(box().value).toBe('{ "a": ');
    expect(screen.getByTestId("f-thing-validation").textContent).toMatch(/^Not valid JSON: /);
    expect(box().getAttribute("aria-invalid")).toBe("true");
    expect(box().getAttribute("aria-describedby")).toContain("f-thing-validation");
    // the last valid value stands; nothing half-typed was written
    expect(probe.value).toEqual({ thing: { a: 1 } });
    expect(probe.onChange).not.toHaveBeenCalled();
  });

  it("writes again, and drops the error, as soon as the text becomes valid", () => {
    const { probe } = renderField(JSON_FIELD);
    type("{ oops");
    expect(screen.getByTestId("f-thing-validation")).toBeTruthy();
    type('{ "fixed": true }');
    expect(screen.queryByTestId("f-thing-validation")).toBeNull();
    expect(probe.value).toEqual({ thing: { fixed: true } });
    expect(box().value).toBe('{ "fixed": true }');
  });

  it("removes the key when the text is cleared", () => {
    const { probe } = renderField(JSON_FIELD, { value: { thing: { a: 1 } } });
    type("");
    expect(probe.value).toEqual({});
    expect(screen.queryByTestId("f-thing-validation")).toBeNull();
  });

  it("treats {} and [] as nothing: the key is removed but the text stays as typed", () => {
    const { probe } = renderField(JSON_FIELD, { value: { thing: { a: 1 } } });
    type("{}");
    expect(probe.value).toEqual({});
    expect(box().value).toBe("{}");
    type("[]");
    expect(probe.value).toEqual({});
  });

  it("keeps what the user is typing while the value is unchanged, and follows a change from outside", () => {
    const { probe } = renderField(JSON_FIELD, { value: { thing: { a: 1 } } });
    type('{"a":1}');
    probe.set({ thing: { a: 1 } });
    expect(box().value).toBe('{"a":1}');
    probe.set({ thing: { a: 2 } });
    expect(box().value).toBe(JSON.stringify({ a: 2 }, null, 2));
  });

  it("does not reformat the text the user typed once it was accepted", () => {
    renderField(JSON_FIELD);
    type('{"a":   1}');
    expect(box().value).toBe('{"a":   1}');
  });

  it("marks required, shows help and the error, uses a placeholder and is disabled with the form", () => {
    renderField(field("json", { required: true, help: "A JSON object.", placeholder: '{ "traceId": "abc" }' }), {
      errors: [{ pointer: "/thing", message: "Must be an object" }], disabled: true,
    });
    expect(box().getAttribute("aria-required")).toBe("true");
    expect(box().getAttribute("aria-describedby")).toBe("f-thing-error f-thing-hint");
    expect(box().placeholder).toBe('{ "traceId": "abc" }');
    expect(box().disabled).toBe(true);
  });

  it("is the JSON editor: here, without CodeMirror in jsdom, its textarea, named like the field", () => {
    const { container } = renderField(JSON_FIELD, { value: { thing: { a: 1 } } });
    const root = container.querySelector('[data-testid="f-thing-editor"]') as HTMLElement;
    expect(root.getAttribute("data-editor")).toBe("textarea");
    expect(root.getAttribute("data-language")).toBe("json");
    expect(box().getAttribute("aria-label")).toBe("Headers");
  });

  it("says where the problem is: the message names the line and the column", () => {
    renderField(JSON_FIELD);
    type('{\n  "a": 1,\n}');
    const message = screen.getByTestId("f-thing-validation").textContent as string;
    expect(message).toMatch(/^Not valid JSON: /);
    expect(message).toMatch(/line 3/i);
    expect(message).toMatch(/column 1/i);
  });

  it("says the text is incomplete at its end when it stops short", () => {
    renderField(JSON_FIELD);
    type('{ "a": ');
    expect(screen.getByTestId("f-thing-validation").textContent).toMatch(/line 1.*column 8|column 8/i);
  });

  it("keeps the invalid text and writes nothing while it is invalid, however many edits it takes to fix", () => {
    const { probe } = renderField(JSON_FIELD, { value: { thing: { keep: "me" } } });
    for (const step of ["{", '{ "a"', '{ "a":', '{ "a": [', '{ "a": [1']) {
      type(step);
      expect(box().value).toBe(step);
      expect(screen.getByTestId("f-thing-validation")).toBeTruthy();
    }
    expect(probe.onChange).not.toHaveBeenCalled();
    expect(probe.value).toEqual({ thing: { keep: "me" } });
    type('{ "a": [1] }');
    expect(probe.onChange).toHaveBeenCalledTimes(1);
    expect(probe.value).toEqual({ thing: { a: [1] } });
  });

  it("combines the form's own description with the validation message for assistive technology", () => {
    renderField(field("json", { help: "A JSON object." }));
    type("{ oops");
    expect(box().getAttribute("aria-describedby")).toBe("f-thing-hint f-thing-validation");
  });

  it("starts empty for no value and keeps whitespace-only text as 'nothing'", () => {
    const { probe } = renderField(JSON_FIELD);
    expect(box().value).toBe("");
    type("   \n ");
    expect(screen.queryByTestId("f-thing-validation")).toBeNull();
    expect(probe.value).toEqual({});
  });
});
