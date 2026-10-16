// @vitest-environment jsdom
import { cleanup, fireEvent, screen } from "@testing-library/react";
import { afterEach, describe, expect, it } from "vitest";
import { field, renderField } from "./harness";

afterEach(cleanup);

const select = () => screen.getByTestId("f-thing") as HTMLSelectElement;
const choose = (value: string) => fireEvent.change(select(), { target: { value } });
const optionValues = () => Array.from(select().options).map((o) => o.value);

const ACTION = field("enum", {
  label: "Action",
  options: [
    { value: "send", label: "Send", help: "The application sends messages to the channel." },
    { value: "receive", label: "Receive", help: "The application receives messages from the channel." },
  ],
});

describe("enum control", () => {
  it("is a native select with a visible label and an empty choice first", () => {
    renderField({ ...ACTION, key: "thing" });
    expect(screen.getByLabelText("Action")).toBe(select());
    expect(select().tagName).toBe("SELECT");
    expect(optionValues()).toEqual(["", "send", "receive"]);
    expect(Array.from(select().options).map((o) => o.textContent)).toEqual(["— none —", "Send", "Receive"]);
    expect(select().value).toBe("");
  });

  it("labels the empty choice 'Select…' when the field is required", () => {
    renderField({ ...ACTION, required: true });
    expect(select().options[0].textContent).toBe("Select…");
  });

  it("writes the chosen value and removes the key when the empty choice is picked again", () => {
    const { probe } = renderField(ACTION);
    choose("receive");
    expect(probe.value).toEqual({ thing: "receive" });
    expect(select().value).toBe("receive");
    choose("");
    expect(probe.value).toEqual({});
  });

  it("shows the current value", () => {
    renderField(ACTION, { value: { thing: "send" } });
    expect(select().value).toBe("send");
  });

  it("explains the selected option with its help text, and each option carries its help as a tooltip", () => {
    renderField(ACTION, { value: { thing: "send" } });
    expect(screen.getByTestId("f-thing-option-help").textContent).toBe("The application sends messages to the channel.");
    expect(select().options[1].title).toBe("The application sends messages to the channel.");
    choose("receive");
    expect(screen.getByTestId("f-thing-option-help").textContent).toBe("The application receives messages from the channel.");
    choose("");
    expect(screen.queryByTestId("f-thing-option-help")).toBeNull();
  });

  it("keeps a value that is not among the options visible and flagged, so it can be changed", () => {
    renderField(ACTION, { value: { thing: "publish" } });
    expect(optionValues()).toEqual(["", "send", "receive", "publish"]);
    expect(select().value).toBe("publish");
    expect(select().options[3].textContent).toBe("publish (not in the list)");
  });

  it("marks required, shows help and the error", () => {
    renderField({ ...ACTION, required: true, help: "Send or receive." }, { errors: [{ pointer: "/thing", message: "Pick one" }] });
    expect(select().getAttribute("aria-required")).toBe("true");
    expect(select().getAttribute("aria-invalid")).toBe("true");
    expect(select().getAttribute("aria-describedby")).toBe("f-thing-error f-thing-hint");
  });

  it("is disabled with the form", () => {
    renderField(ACTION, { disabled: true });
    expect(select().disabled).toBe(true);
  });
});

describe("boolean control", () => {
  const DEPRECATED = field("boolean", { label: "Deprecated", default: false });

  it("offers Not set, Yes and No, and starts on Not set", () => {
    renderField(DEPRECATED);
    expect(screen.getByLabelText("Deprecated")).toBe(select());
    expect(Array.from(select().options).map((o) => o.textContent)).toEqual(["Not set (default: no)", "Yes", "No"]);
    expect(select().value).toBe("");
  });

  it("says nothing about a default the spec does not have", () => {
    renderField(field("boolean"));
    expect(select().options[0].textContent).toBe("Not set");
  });

  it("omits the key until the user sets it; Yes writes true, No writes false (kept, not dropped)", () => {
    const { probe } = renderField(DEPRECATED);
    expect("thing" in probe.value).toBe(false);
    fireEvent.change(select(), { target: { value: "true" } });
    expect(probe.value).toEqual({ thing: true });
    fireEvent.change(select(), { target: { value: "false" } });
    expect(probe.value).toEqual({ thing: false });
    expect(select().value).toBe("false");
  });

  it("choosing Not set again removes the key", () => {
    const { probe } = renderField(DEPRECATED, { value: { thing: true } });
    expect(select().value).toBe("true");
    fireEvent.change(select(), { target: { value: "" } });
    expect(probe.value).toEqual({});
  });

  it("shows false as No, not as unset", () => {
    renderField(DEPRECATED, { value: { thing: false } });
    expect(select().value).toBe("false");
  });

  it("marks required and is disabled with the form", () => {
    renderField(field("boolean", { required: true }), { disabled: true });
    expect(select().getAttribute("aria-required")).toBe("true");
    expect(select().disabled).toBe(true);
  });
});
