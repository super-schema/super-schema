// @vitest-environment jsdom
import { cleanup, fireEvent, screen } from "@testing-library/react";
import { afterEach, describe, expect, it } from "vitest";
import { field, renderField } from "./harness";

afterEach(cleanup);

const KV = field("keyValue", { label: "Available scopes" });
const key = (i: number) => screen.getByTestId(`f-thing-${i}-key`) as HTMLInputElement;
const val = (i: number) => screen.getByTestId(`f-thing-${i}-value`) as HTMLInputElement;
const add = () => fireEvent.click(screen.getByRole("button", { name: "Add row" }));
const typeKey = (i: number, text: string) => fireEvent.change(key(i), { target: { value: text } });
const typeVal = (i: number, text: string) => fireEvent.change(val(i), { target: { value: text } });

describe("keyValue control", () => {
  it("is a labelled group with an Add row button and no rows to start with", () => {
    renderField(KV);
    expect(screen.getByRole("group", { name: "Available scopes" })).toBeTruthy();
    expect(screen.getByTestId("f-thing")).toBeTruthy();
    expect(screen.queryByTestId("f-thing-0-key")).toBeNull();
    expect(screen.getByRole("button", { name: "Add row" })).toBeTruthy();
  });

  it("shows one row per entry with the key and the value in labelled inputs", () => {
    renderField(KV, { value: { thing: { "read:orders": "Read orders", "write:orders": "Write orders" } } });
    expect(key(0).value).toBe("read:orders");
    expect(val(0).value).toBe("Read orders");
    expect(key(1).value).toBe("write:orders");
    expect(screen.getByLabelText("Available scopes: name 1")).toBe(key(0));
    expect(screen.getByLabelText("Available scopes: value 2")).toBe(val(1));
  });

  it("adding a row shows empty inputs but writes nothing until it has a name", () => {
    const { probe } = renderField(KV);
    add();
    expect(key(0).value).toBe("");
    expect(probe.value).toEqual({});
    typeVal(0, "orphan value");
    expect(probe.value).toEqual({});
    typeKey(0, "read");
    expect(probe.value).toEqual({ thing: { read: "orphan value" } });
  });

  it("writes entries in row order as the user types", () => {
    const { probe } = renderField(KV);
    add();
    typeKey(0, "read");
    typeVal(0, "Read access");
    add();
    typeKey(1, "write");
    typeVal(1, "Write access");
    expect(probe.value).toEqual({ thing: { read: "Read access", write: "Write access" } });
    expect(Object.keys(probe.value.thing as object)).toEqual(["read", "write"]);
  });

  it("keeps an entry whose value is empty (a scope without a description is still a scope)", () => {
    const { probe } = renderField(KV);
    add();
    typeKey(0, "read");
    expect(probe.value).toEqual({ thing: { read: "" } });
  });

  it("ignores a completely empty row: it adds nothing to the value", () => {
    const { probe } = renderField(KV);
    add();
    add();
    expect(probe.value).toEqual({});
    typeKey(1, "only");
    expect(probe.value).toEqual({ thing: { only: "" } });
  });

  it("renaming a key keeps its value and its position", () => {
    const { probe } = renderField(KV, { value: { thing: { a: "1", b: "2" } } });
    typeKey(0, "alpha");
    expect(probe.value).toEqual({ thing: { alpha: "1", b: "2" } });
    expect(Object.keys(probe.value.thing as object)).toEqual(["alpha", "b"]);
  });

  it("removes a row with its button, and the key when the last row goes", () => {
    const { probe } = renderField(KV, { value: { thing: { a: "1", b: "2" } } });
    fireEvent.click(screen.getByRole("button", { name: "Remove row 1" }));
    expect(probe.value).toEqual({ thing: { b: "2" } });
    expect(key(0).value).toBe("b");
    fireEvent.click(screen.getByRole("button", { name: "Remove row 1" }));
    expect(probe.value).toEqual({});
  });

  it("flags a duplicate name and writes only the first of the two", () => {
    const { probe } = renderField(KV, { value: { thing: { a: "1" } } });
    add();
    typeKey(1, "a");
    typeVal(1, "second");
    expect(probe.value).toEqual({ thing: { a: "1" } });
    expect(screen.getByTestId("f-thing-1-problem").textContent).toBe("Another row already uses this name.");
    expect(key(1).getAttribute("aria-invalid")).toBe("true");
    typeKey(1, "b");
    expect(screen.queryByTestId("f-thing-1-problem")).toBeNull();
    expect(probe.value).toEqual({ thing: { a: "1", b: "second" } });
  });

  it("says a value needs a name when only the value is filled in", () => {
    renderField(KV);
    add();
    typeVal(0, "no name");
    expect(screen.getByTestId("f-thing-0-problem").textContent).toBe("Enter a name for this row, or it is left out.");
  });

  it("trims the names it writes", () => {
    const { probe } = renderField(KV);
    add();
    typeKey(0, "  read  ");
    expect(probe.value).toEqual({ thing: { read: "" } });
  });

  it("shows a non-text value as JSON and leaves it untouched until the row is edited", () => {
    const { probe } = renderField(KV, { value: { thing: { StringEquals: { "aws:SourceArn": "arn" }, count: 3 } } });
    expect(val(0).value).toBe('{"aws:SourceArn":"arn"}');
    expect(val(1).value).toBe("3");
    typeKey(1, "total");
    expect(probe.value).toEqual({ thing: { StringEquals: { "aws:SourceArn": "arn" }, total: 3 } });
    typeVal(1, "many");
    expect(probe.value).toEqual({ thing: { StringEquals: { "aws:SourceArn": "arn" }, total: "many" } });
  });

  it("shows a draft row again after unrelated re-renders, and takes an outside change to the value", () => {
    const { probe } = renderField(KV, { value: { thing: { a: "1" } } });
    add();
    typeKey(1, "");
    probe.set({ thing: { a: "1" }, other: "x" });
    expect(key(1).value).toBe("");
    probe.set({ thing: { z: "26" } });
    expect(key(0).value).toBe("z");
    expect(screen.queryByTestId("f-thing-1-key")).toBeNull();
  });

  it("marks required, shows help and the error, and is disabled with the form", () => {
    renderField({ ...KV, required: true, help: "Name and meaning of each scope." }, { errors: [{ pointer: "/thing", message: "Add at least one" }], disabled: true, value: { thing: { a: "1" } } });
    const group = screen.getByTestId("f-thing");
    expect(group.tagName).toBe("FIELDSET");
    expect(group.getAttribute("aria-describedby")).toBe("f-thing-error f-thing-hint f-thing-required-note");
    expect(screen.getByTestId("f-thing-required").textContent).toBe("*");
    expect(screen.getByTestId("f-thing-required-note").textContent).toBe("Required");
    expect(screen.getByTestId("f-thing-error").textContent).toBe("Add at least one");
    expect(key(0).disabled).toBe(true);
    expect((screen.getByRole("button", { name: "Add row" }) as HTMLButtonElement).disabled).toBe(true);
    expect((screen.getByRole("button", { name: "Remove row 1" }) as HTMLButtonElement).disabled).toBe(true);
  });
});
