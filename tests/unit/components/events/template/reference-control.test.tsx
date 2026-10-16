// @vitest-environment jsdom
import { cleanup, fireEvent, screen, within } from "@testing-library/react";
import { afterEach, describe, expect, it } from "vitest";
import type { TemplateFormContext } from "@/features/events/builder/template";
import { field, renderField } from "./harness";

afterEach(cleanup);

const CONTEXT: TemplateFormContext = {
  references: {
    server: [
      { value: "kafka-prod", label: "Production Kafka", hint: "kafka.prod:9092" },
      { value: "kafka-dev", label: "Dev Kafka" },
    ],
    message: [{ value: "OrderCreated", label: "OrderCreated" }, { value: "OrderCancelled", label: "OrderCancelled" }],
  },
};

describe("reference control (one)", () => {
  const ONE = field("reference", { key: "channel", label: "Channel", refersTo: "server" });
  const select = () => screen.getByTestId("f-channel") as HTMLSelectElement;

  it("is a select with a visible label over the options for what it refers to", () => {
    renderField(ONE, { context: CONTEXT });
    expect(screen.getByLabelText("Channel")).toBe(select());
    expect(Array.from(select().options).map((o) => o.value)).toEqual(["", "kafka-prod", "kafka-dev"]);
    expect(Array.from(select().options).map((o) => o.textContent)).toEqual(["— none —", "Production Kafka", "Dev Kafka"]);
  });

  it("shows an option's hint as its tooltip", () => {
    renderField(ONE, { context: CONTEXT });
    expect(select().options[1].title).toBe("kafka.prod:9092");
  });

  it("writes the chosen option's value, a string, and removes the key for the empty choice", () => {
    const { probe } = renderField(ONE, { context: CONTEXT });
    fireEvent.change(select(), { target: { value: "kafka-dev" } });
    expect(probe.value).toEqual({ channel: "kafka-dev" });
    fireEvent.change(select(), { target: { value: "" } });
    expect(probe.value).toEqual({});
  });

  it("keeps a value that is no longer offered visible and marked unavailable, so it can be changed", () => {
    renderField(ONE, { context: CONTEXT, value: { channel: "kafka-gone" } });
    expect(select().value).toBe("kafka-gone");
    const option = Array.from(select().options).find((o) => o.value === "kafka-gone")!;
    expect(option.textContent).toBe("kafka-gone (unavailable)");
    expect(screen.getByTestId("f-channel-unavailable").textContent).toContain("kafka-gone");
  });

  it("can switch away from an unavailable value, after which the warning is gone", () => {
    const { probe } = renderField(ONE, { context: CONTEXT, value: { channel: "kafka-gone" } });
    fireEvent.change(select(), { target: { value: "kafka-prod" } });
    expect(probe.value).toEqual({ channel: "kafka-prod" });
    expect(screen.queryByTestId("f-channel-unavailable")).toBeNull();
  });

  it("says there is nothing to pick yet when no options exist for what it refers to", () => {
    renderField(ONE, { context: { references: { server: [] } } });
    expect(screen.getByTestId("f-channel-empty").textContent).toBe("No servers are defined yet.");
  });

  it("copes with no context at all", () => {
    renderField(ONE);
    expect(screen.getByTestId("f-channel-empty")).toBeTruthy();
    expect(Array.from(select().options).map((o) => o.value)).toEqual([""]);
  });

  it("marks required and is disabled with the form; shows help and errors", () => {
    renderField({ ...ONE, required: true, help: "The channel to use." }, { context: CONTEXT, disabled: true, errors: [{ pointer: "/channel", message: "Pick a channel" }] });
    expect(select().getAttribute("aria-required")).toBe("true");
    expect(select().getAttribute("aria-invalid")).toBe("true");
    expect(select().getAttribute("aria-describedby")).toBe("f-channel-error f-channel-hint");
    expect(select().disabled).toBe(true);
  });
});

describe("reference control (several)", () => {
  const MANY = field("reference", { key: "servers", label: "Servers", refersTo: "server", multiple: true });
  const box = (value: string) => screen.getByTestId(`f-servers-option-${value}`) as HTMLInputElement;

  it("is a labelled group with one checkbox per option, each with its own label", () => {
    renderField(MANY, { context: CONTEXT });
    const group = screen.getByRole("group", { name: "Servers" });
    expect(group.tagName).toBe("FIELDSET");
    expect(group.getAttribute("data-testid")).toBe("f-servers");
    expect(within(group).getByLabelText("Production Kafka")).toBe(box("kafka-prod"));
    expect(within(group).getByLabelText("Dev Kafka")).toBe(box("kafka-dev"));
    expect(box("kafka-prod").checked).toBe(false);
  });

  it("checking writes an array of values in the order they were chosen; unchecking removes one", () => {
    const { probe } = renderField(MANY, { context: CONTEXT });
    fireEvent.click(box("kafka-dev"));
    expect(probe.value).toEqual({ servers: ["kafka-dev"] });
    fireEvent.click(box("kafka-prod"));
    expect(probe.value).toEqual({ servers: ["kafka-dev", "kafka-prod"] });
    fireEvent.click(box("kafka-dev"));
    expect(probe.value).toEqual({ servers: ["kafka-prod"] });
    fireEvent.click(box("kafka-prod"));
    expect(probe.value).toEqual({});
  });

  it("checks the boxes of the current values", () => {
    renderField(MANY, { context: CONTEXT, value: { servers: ["kafka-prod"] } });
    expect(box("kafka-prod").checked).toBe(true);
    expect(box("kafka-dev").checked).toBe(false);
  });

  it("keeps values that are no longer offered as checked, flagged unavailable, and removable", () => {
    const { probe } = renderField(MANY, { context: CONTEXT, value: { servers: ["kafka-prod", "retired"] } });
    expect(box("retired").checked).toBe(true);
    expect(screen.getByLabelText("retired (unavailable)")).toBe(box("retired"));
    expect(screen.getByTestId("f-servers-unavailable").textContent).toContain("retired");
    fireEvent.click(box("retired"));
    expect(probe.value).toEqual({ servers: ["kafka-prod"] });
    expect(screen.queryByTestId("f-servers-option-retired")).toBeNull();
    expect(screen.queryByTestId("f-servers-unavailable")).toBeNull();
  });

  it("says there is nothing to pick yet when no options exist", () => {
    renderField(MANY, { context: { references: {} } });
    expect(screen.getByTestId("f-servers-empty").textContent).toBe("No servers are defined yet.");
  });

  it("uses the target's own noun in that message", () => {
    renderField(field("reference", { key: "messages", label: "Messages", refersTo: "message", multiple: true }), { context: { references: { message: [] } } });
    expect(screen.getByTestId("f-messages-empty").textContent).toBe("No messages are defined yet.");
  });

  it("marks required, shows help and the error, and is disabled with the form", () => {
    renderField({ ...MANY, required: true, help: "Where it is offered." }, { context: CONTEXT, disabled: true, errors: [{ pointer: "/servers/0", message: "Unknown server" }] });
    const group = screen.getByTestId("f-servers");
    expect(group.getAttribute("aria-describedby")).toBe("f-servers-error f-servers-hint f-servers-required-note");
    expect(screen.getByTestId("f-servers-error").textContent).toBe("Unknown server");
    expect(box("kafka-prod").disabled).toBe(true);
  });
});
