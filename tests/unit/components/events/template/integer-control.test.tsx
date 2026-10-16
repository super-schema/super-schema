// @vitest-environment jsdom
import { cleanup, fireEvent, screen } from "@testing-library/react";
import { afterEach, describe, expect, it } from "vitest";
import { INTEGER_PROBLEM } from "@/features/events/builder/template/controls/validate";
import { field, renderField } from "./harness";

afterEach(cleanup);

const input = () => screen.getByTestId("f-thing") as HTMLInputElement;
const type = (text: string) => fireEvent.change(input(), { target: { value: text } });

describe("integer control", () => {
  it("shows the number with a visible label and a numeric keypad hint", () => {
    renderField(field("integer", { label: "Partitions" }), { value: { thing: 12 } });
    expect(screen.getByLabelText("Partitions")).toBe(input());
    expect(input().value).toBe("12");
    expect(input().inputMode).toBe("numeric");
  });

  it("writes a number, not text", () => {
    const { probe } = renderField(field("integer"));
    type("42");
    expect(probe.value).toEqual({ thing: 42 });
    expect(typeof probe.value.thing).toBe("number");
  });

  it("accepts zero and negative numbers", () => {
    const { probe } = renderField(field("integer"));
    type("0");
    expect(probe.value).toEqual({ thing: 0 });
    type("-5");
    expect(probe.value).toEqual({ thing: -5 });
  });

  it("removes the key when cleared", () => {
    const { probe } = renderField(field("integer"), { value: { thing: 7 } });
    type("");
    expect(probe.value).toEqual({});
  });

  it("shows an error for text and never writes NaN", () => {
    const { probe } = renderField(field("integer"), { value: { thing: 3 } });
    type("abc");
    expect(screen.getByTestId("f-thing-validation").textContent).toBe(INTEGER_PROBLEM);
    expect(input().getAttribute("aria-invalid")).toBe("true");
    expect(input().value).toBe("abc");
    // nothing was written for the bad text: the last good value stands
    expect(probe.value).toEqual({ thing: 3 });
    expect(Number.isNaN(probe.value.thing)).toBe(false);
    expect(probe.onChange).not.toHaveBeenCalled();
  });

  it.each(["1.5", "1e3", "12abc", "0x10", "--1", "1 2", "-"])("rejects %s", (bad) => {
    const { probe } = renderField(field("integer"));
    type(bad);
    expect(screen.getByTestId("f-thing-validation")).toBeTruthy();
    expect(probe.onChange).not.toHaveBeenCalled();
  });

  it("clears the error and writes once the text is a whole number again", () => {
    const { probe } = renderField(field("integer"));
    type("12x");
    expect(screen.getByTestId("f-thing-validation")).toBeTruthy();
    type("12");
    expect(screen.queryByTestId("f-thing-validation")).toBeNull();
    expect(probe.value).toEqual({ thing: 12 });
  });

  it("follows the value when it changes from outside", () => {
    const { probe } = renderField(field("integer"), { value: { thing: 1 } });
    expect(input().value).toBe("1");
    probe.set({ thing: 99 });
    expect(input().value).toBe("99");
    probe.set({});
    expect(input().value).toBe("");
  });

  it("keeps the text the user is typing while the value is unchanged", () => {
    const { probe } = renderField(field("integer"), { value: { thing: 3 } });
    type("3x");
    probe.set({ thing: 3 });
    expect(input().value).toBe("3x");
  });

  it("marks required, shows help and the error, and is disabled with the form", () => {
    renderField(field("integer", { required: true, help: "How many." }), { errors: [{ pointer: "/thing", message: "Too many" }], disabled: true });
    expect(input().getAttribute("aria-required")).toBe("true");
    expect(input().getAttribute("aria-describedby")).toBe("f-thing-error f-thing-hint");
    expect(input().disabled).toBe(true);
  });
});
