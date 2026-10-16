// @vitest-environment jsdom
import { useEffect, useState } from "react";
import { act, cleanup, fireEvent, render, screen, within } from "@testing-library/react";
import { afterEach, describe, expect, it, vi } from "vitest";
import { BindingsForm } from "@/features/events/builder/template";
import { bindingVersion } from "@/lib/events/templates";

afterEach(cleanup);

type Target = "server" | "channel" | "operation" | "message";
type Props = Partial<Omit<Parameters<typeof BindingsForm>[0], "value" | "onChange">> & { value?: Record<string, unknown>; target?: Target };

function renderBindings({ value: initial = {}, target = "channel", ...props }: Props = {}) {
  const probe = {
    value: initial as Record<string, unknown>,
    onChange: vi.fn<(next: Record<string, unknown>) => void>(),
    set: (() => {}) as (next: Record<string, unknown>) => void,
  };
  function Harness() {
    const [value, setValue] = useState<Record<string, unknown>>(initial);
    useEffect(() => {
      Object.assign(probe, { value, set: (next: Record<string, unknown>) => act(() => setValue(next)) });
    });
    return (
      <BindingsForm
        target={target}
        idPrefix="b"
        {...props}
        value={value}
        onChange={(next) => {
          probe.onChange(next);
          setValue(next);
        }}
      />
    );
  }
  return { ...render(<Harness />), probe };
}

const select = () => screen.getByTestId("b-protocol") as HTMLSelectElement;
const addButton = () => screen.getByTestId("b-add") as HTMLButtonElement;
const choose = (protocol: string) => fireEvent.change(select(), { target: { value: protocol } });
const add = (protocol: string) => {
  choose(protocol);
  fireEvent.click(addButton());
};
const el = (testId: string) => screen.getByTestId(testId) as HTMLInputElement;
const type = (testId: string, text: string) => fireEvent.change(el(testId), { target: { value: text } });
const optionLabels = () => Array.from(select().options).map((o) => o.textContent);
const optionValues = () => Array.from(select().options).map((o) => o.value);

const V = (protocol: string, target: Target) => bindingVersion(protocol, target)!;

describe("BindingsForm: choosing a protocol", () => {
  it("is a labelled group with a protocol select, an Add binding button and nothing else to start with", () => {
    renderBindings();
    const group = screen.getByRole("group", { name: "Protocol bindings" });
    expect(group.getAttribute("data-testid")).toBe("b");
    expect(screen.getByLabelText("Protocol")).toBe(select());
    expect(addButton().textContent).toBe("Add binding");
    expect(screen.queryByTestId("b-kafka")).toBeNull();
  });

  it("lists the known protocols by their friendly names, and 'Other protocol…' last", () => {
    renderBindings();
    expect(optionValues()[0]).toBe("");
    expect(optionValues()).toContain("kafka");
    expect(optionValues()).toContain("googlepubsub");
    expect(optionValues()).toContain("pulsar");
    expect(optionLabels()).toContain("Kafka");
    expect(optionLabels()).toContain("Google Pub/Sub");
    expect(optionLabels()).toContain("Pulsar");
    expect(optionValues()[optionValues().length - 1]).toBe("__other__");
    expect(optionLabels()[optionLabels().length - 1]).toBe("Other protocol…");
  });

  it("marks protocols that have no binding for this target", () => {
    renderBindings({ target: "server" });
    const pubsub = Array.from(select().options).find((o) => o.value === "googlepubsub")!;
    expect(pubsub.textContent).toBe("Google Pub/Sub (no server binding)");
    const kafka = Array.from(select().options).find((o) => o.value === "kafka")!;
    expect(kafka.textContent).toBe("Kafka");
  });

  it("preselects the suggested protocol when no binding is set yet, and Add is enabled", () => {
    renderBindings({ suggestedProtocol: "kafka" });
    expect(select().value).toBe("kafka");
    expect(addButton().disabled).toBe(false);
  });

  it("does not preselect anything without a suggestion, and Add is disabled until a protocol is chosen", () => {
    renderBindings();
    expect(select().value).toBe("");
    expect(addButton().disabled).toBe(true);
    choose("mqtt");
    expect(addButton().disabled).toBe(false);
  });

  it("ignores a suggestion that is not a known protocol", () => {
    renderBindings({ suggestedProtocol: "carrier-pigeon" });
    expect(select().value).toBe("");
  });

  it("does not preselect once a binding exists", () => {
    renderBindings({ suggestedProtocol: "kafka", value: { amqp: { is: "queue", bindingVersion: V("amqp", "channel") } } });
    expect(select().value).toBe("");
  });

  it("leaves out protocols that are already added", () => {
    renderBindings({ value: { kafka: { topic: "t", bindingVersion: V("kafka", "channel") } } });
    expect(optionValues()).not.toContain("kafka");
    expect(optionValues()).toContain("mqtt");
  });
});

describe("BindingsForm: a Kafka channel binding", () => {
  it("shows the Kafka channel template as a form once added, without writing anything yet", () => {
    const { probe } = renderBindings({ suggestedProtocol: "kafka" });
    fireEvent.click(addButton());
    const section = screen.getByRole("group", { name: "Kafka binding" });
    expect(section.getAttribute("data-testid")).toBe("b-kafka");
    expect(within(section).getByLabelText("Topic name")).toBe(el("b-kafka-topic"));
    expect(el("b-kafka-partitions")).toBeTruthy();
    expect(el("b-kafka-replicas")).toBeTruthy();
    expect(screen.getByTestId("b-kafka-more-toggle").textContent).toBe("More properties (0 set)");
    expect(probe.onChange).not.toHaveBeenCalled();
    expect(probe.value).toEqual({});
    // the select is free again
    expect(select().value).toBe("");
    expect(optionValues()).not.toContain("kafka");
  });

  it("writes the filled values under the protocol, with bindingVersion set automatically", () => {
    const { probe } = renderBindings();
    add("kafka");
    type("b-kafka-topic", "orders.created");
    expect(probe.value).toEqual({ kafka: { topic: "orders.created", bindingVersion: V("kafka", "channel") } });
    type("b-kafka-partitions", "6");
    expect(probe.value).toEqual({ kafka: { topic: "orders.created", partitions: 6, bindingVersion: V("kafka", "channel") } });
  });

  it("the version is the latest the template was built from (kafka channel is 0.5.0)", () => {
    expect(V("kafka", "channel")).toBe("0.5.0");
  });

  it("does not show bindingVersion as a field or as an 'other property'", () => {
    renderBindings({ value: { kafka: { topic: "t", bindingVersion: "0.4.0" } } });
    expect(screen.queryByTestId("b-kafka-bindingVersion")).toBeNull();
    expect(screen.queryByTestId("b-kafka-other")).toBeNull();
  });

  it("sets the latest bindingVersion when an older binding is edited", () => {
    const { probe } = renderBindings({ value: { kafka: { topic: "t", bindingVersion: "0.3.0" } } });
    type("b-kafka-topic", "t2");
    expect(probe.value).toEqual({ kafka: { topic: "t2", bindingVersion: V("kafka", "channel") } });
  });

  it("drops the protocol when all its fields are cleared, but keeps the form on screen", () => {
    const { probe } = renderBindings({ value: { kafka: { topic: "t", bindingVersion: V("kafka", "channel") } } });
    type("b-kafka-topic", "");
    expect(probe.value).toEqual({});
    expect(screen.getByTestId("b-kafka")).toBeTruthy();
    type("b-kafka-topic", "again");
    expect(probe.value).toEqual({ kafka: { topic: "again", bindingVersion: V("kafka", "channel") } });
  });

  it("keeps extension properties of the binding when a field changes", () => {
    const { probe } = renderBindings({ value: { kafka: { topic: "t", "x-team": "core", bindingVersion: V("kafka", "channel") } } });
    expect(screen.getByTestId("b-kafka-other").textContent).toContain("x-team");
    type("b-kafka-topic", "t2");
    expect(probe.value).toEqual({ kafka: { topic: "t2", "x-team": "core", bindingVersion: V("kafka", "channel") } });
  });

  it("reaches nested template fields, such as the topic configuration", () => {
    const { probe } = renderBindings({ value: { kafka: { topic: "t", bindingVersion: V("kafka", "channel") } } });
    fireEvent.click(screen.getByTestId("b-kafka-more-toggle"));
    type("b-kafka-topicConfiguration-retention.ms", "86400000");
    expect(probe.value).toEqual({
      kafka: { topic: "t", topicConfiguration: { "retention.ms": 86400000 }, bindingVersion: V("kafka", "channel") },
    });
  });
});

describe("BindingsForm: Google Pub/Sub channel (required keys)", () => {
  it("marks the required schema settings, down to the keys inside", () => {
    renderBindings();
    add("googlepubsub");
    expect(screen.getByTestId("b-googlepubsub-schemaSettings-required")).toBeTruthy();
    expect(screen.getByTestId("b-googlepubsub-schemaSettings-encoding-required")).toBeTruthy();
    expect(screen.getByTestId("b-googlepubsub-schemaSettings-name-required")).toBeTruthy();
    expect(el("b-googlepubsub-schemaSettings-encoding").getAttribute("aria-required")).toBe("true");
    expect(screen.queryByTestId("b-googlepubsub-schemaSettings-firstRevisionId-required")).toBeNull();
  });

  it("writes the nested required values under schemaSettings", () => {
    const { probe } = renderBindings();
    add("googlepubsub");
    type("b-googlepubsub-schemaSettings-encoding", "json");
    type("b-googlepubsub-schemaSettings-name", "projects/p/schemas/s");
    expect(probe.value).toEqual({
      googlepubsub: { schemaSettings: { encoding: "json", name: "projects/p/schemas/s" }, bindingVersion: V("googlepubsub", "channel") },
    });
  });

  it("shows a required-key problem at that key", () => {
    renderBindings({
      value: { googlepubsub: { schemaSettings: { encoding: "json" }, bindingVersion: V("googlepubsub", "channel") } },
      errorPrefix: "/channels/orders/bindings",
      errors: [{ pointer: "/channels/orders/bindings/googlepubsub/schemaSettings/name", message: "Schema name is required" }],
    });
    expect(screen.getByTestId("b-googlepubsub-schemaSettings-name-error").textContent).toBe("Schema name is required");
  });
});

describe("BindingsForm: servers, operations and messages", () => {
  it("renders a Pulsar server binding with the server template and its version", () => {
    const { probe } = renderBindings({ target: "server" });
    add("pulsar");
    type("b-pulsar-tenant", "my-tenant");
    expect(probe.value).toEqual({ pulsar: { tenant: "my-tenant", bindingVersion: V("pulsar", "server") } });
    expect(V("pulsar", "server")).toBe("0.1.0");
  });

  it("uses the template of the target it is given", () => {
    renderBindings({ target: "operation", value: { kafka: { groupId: { type: "string" }, bindingVersion: V("kafka", "operation") } } });
    expect(el("b-kafka-groupId")).toBeTruthy();
    expect(screen.queryByTestId("b-kafka-topic")).toBeNull();
  });

  it("a message binding", () => {
    const { probe } = renderBindings({ target: "message" });
    add("kafka");
    fireEvent.change(el("b-kafka-schemaIdLocation"), { target: { value: "payload" } });
    expect(probe.value).toEqual({ kafka: { schemaIdLocation: "payload", bindingVersion: V("kafka", "message") } });
  });

  it("supports several protocols at once, each with its own version, edited independently", () => {
    const { probe } = renderBindings({ target: "server" });
    add("kafka");
    type("b-kafka-schemaRegistryUrl", "https://registry.example.com");
    add("mqtt");
    type("b-mqtt-clientId", "client-1");
    expect(probe.value).toEqual({
      kafka: { schemaRegistryUrl: "https://registry.example.com", bindingVersion: V("kafka", "server") },
      mqtt: { clientId: "client-1", bindingVersion: V("mqtt", "server") },
    });
    type("b-kafka-schemaRegistryUrl", "");
    expect(probe.value).toEqual({ mqtt: { clientId: "client-1", bindingVersion: V("mqtt", "server") } });
    expect(screen.getByTestId("b-kafka")).toBeTruthy();
    expect(screen.getByTestId("b-mqtt")).toBeTruthy();
  });

  it("shows the protocols already in the value first, in their order, then new ones", () => {
    renderBindings({
      target: "server",
      value: { mqtt: { clientId: "c", bindingVersion: V("mqtt", "server") }, kafka: { schemaRegistryUrl: "https://r.example.com", bindingVersion: V("kafka", "server") } },
    });
    add("pulsar");
    const order = Array.from(document.querySelectorAll('fieldset[data-testid^="b-"]'))
      .map((n) => n.getAttribute("data-testid"))
      .filter((id) => ["b-mqtt", "b-kafka", "b-pulsar"].includes(id!));
    expect(order).toEqual(["b-mqtt", "b-kafka", "b-pulsar"]);
  });
});

describe("BindingsForm: removing a protocol", () => {
  const VALUE = {
    kafka: { topic: "t", bindingVersion: V("kafka", "channel") },
    amqp: { is: "queue", bindingVersion: V("amqp", "channel") },
  };

  it("removes one protocol with its labelled button and leaves the other", () => {
    const { probe } = renderBindings({ value: VALUE });
    fireEvent.click(screen.getByRole("button", { name: "Remove Kafka binding" }));
    expect(probe.value).toEqual({ amqp: VALUE.amqp });
    expect(screen.queryByTestId("b-kafka")).toBeNull();
    expect(optionValues()).toContain("kafka");
  });

  it("removing the last protocol leaves an empty value", () => {
    const { probe } = renderBindings({ value: { kafka: VALUE.kafka } });
    fireEvent.click(screen.getByRole("button", { name: "Remove Kafka binding" }));
    expect(probe.value).toEqual({});
  });

  it("removes a protocol that was added but never filled in, without telling the parent", () => {
    const { probe } = renderBindings();
    add("kafka");
    fireEvent.click(screen.getByRole("button", { name: "Remove Kafka binding" }));
    expect(screen.queryByTestId("b-kafka")).toBeNull();
    expect(probe.onChange).not.toHaveBeenCalled();
  });

  it("the remove button is a real button", () => {
    renderBindings({ value: { kafka: VALUE.kafka } });
    const button = screen.getByTestId("b-kafka-remove") as HTMLButtonElement;
    expect(button.tagName).toBe("BUTTON");
    expect(button.type).toBe("button");
  });
});

describe("BindingsForm: protocols without a template", () => {
  it("says so clearly when a known protocol has no binding for this target", () => {
    const { probe } = renderBindings({ target: "server" });
    add("googlepubsub");
    expect(screen.getByTestId("b-googlepubsub-none").textContent).toBe("No server binding for Google Pub/Sub.");
    expect(screen.queryByTestId("b-googlepubsub-more-toggle")).toBeNull();
    expect(probe.onChange).not.toHaveBeenCalled();
    fireEvent.click(screen.getByRole("button", { name: "Remove Google Pub/Sub binding" }));
    expect(screen.queryByTestId("b-googlepubsub")).toBeNull();
  });

  it("the note names the target", () => {
    renderBindings({ target: "operation" });
    add("googlepubsub");
    expect(screen.getByTestId("b-googlepubsub-none").textContent).toBe("No operation binding for Google Pub/Sub.");
  });

  it("an existing value for such a protocol is shown as JSON so it can be seen and removed", () => {
    renderBindings({ target: "server", value: { googlepubsub: { legacy: true } } });
    expect(screen.getByTestId("b-googlepubsub-none")).toBeTruthy();
    expect((el("b-googlepubsub-json") as unknown as HTMLTextAreaElement).value).toBe(JSON.stringify({ legacy: true }, null, 2));
  });
});

describe("BindingsForm: protocols the catalog does not know (a JSON editor)", () => {
  it("shows an unknown protocol already in the value as a JSON editor with a note", () => {
    renderBindings({ value: { "x-acme": { region: "eu", retries: 3 } } });
    expect(screen.getByRole("group", { name: "x-acme binding" })).toBeTruthy();
    expect(screen.getByTestId("b-x-acme-none").textContent).toBe("No template for x-acme. Edit its settings as JSON.");
    const json = el("b-x-acme-json") as unknown as HTMLTextAreaElement;
    expect(JSON.parse(json.value)).toEqual({ region: "eu", retries: 3 });
  });

  it("writes valid JSON for it, and nothing while the JSON is invalid", () => {
    const { probe } = renderBindings({ value: { "x-acme": { region: "eu" } } });
    type("b-x-acme-json", "{ broken");
    expect(probe.value).toEqual({ "x-acme": { region: "eu" } });
    expect(screen.getByTestId("b-x-acme-json-validation")).toBeTruthy();
    type("b-x-acme-json", '{ "region": "us" }');
    expect(probe.value).toEqual({ "x-acme": { region: "us" } });
  });

  it("does not invent a bindingVersion for a protocol without one", () => {
    const { probe } = renderBindings({ value: { "x-acme": { a: 1 } } });
    type("b-x-acme-json", '{ "a": 2 }');
    expect(Object.keys(probe.value["x-acme"] as object)).toEqual(["a"]);
  });

  it("clearing the JSON drops the protocol", () => {
    const { probe } = renderBindings({ value: { "x-acme": { a: 1 } } });
    type("b-x-acme-json", "");
    expect(probe.value).toEqual({});
  });

  it("'Other protocol…' asks for a name, which must be a plain token, and then adds the JSON editor", () => {
    const { probe } = renderBindings();
    choose("__other__");
    expect(screen.getByLabelText("Protocol name")).toBe(el("b-custom-protocol"));
    expect(addButton().disabled).toBe(true);
    type("b-custom-protocol", "has space");
    expect(addButton().disabled).toBe(true);
    expect(screen.getByTestId("b-custom-protocol-validation").textContent).toBe("Use letters, digits, dots, dashes and underscores, starting with a letter or digit.");
    type("b-custom-protocol", "acme");
    expect(addButton().disabled).toBe(false);
    fireEvent.click(addButton());
    expect(screen.getByRole("group", { name: "acme binding" })).toBeTruthy();
    type("b-acme-json", '{ "a": 1 }');
    expect(probe.value).toEqual({ acme: { a: 1 } });
    expect(screen.queryByTestId("b-custom-protocol")).toBeNull();
  });

  it("a custom name that is a known protocol is added as that protocol's form instead", () => {
    renderBindings();
    choose("__other__");
    type("b-custom-protocol", "kafka");
    fireEvent.click(addButton());
    expect(el("b-kafka-topic")).toBeTruthy();
    expect(screen.queryByTestId("b-kafka-json")).toBeNull();
  });

  it("will not add a protocol that is already there", () => {
    renderBindings({ value: { acme: { a: 1 } } });
    choose("__other__");
    type("b-custom-protocol", "acme");
    expect(addButton().disabled).toBe(true);
    expect(screen.getByTestId("b-custom-protocol-validation").textContent).toBe("This protocol is already added.");
  });
});

describe("BindingsForm: errors, disabled", () => {
  it("shows a field problem under the field, found through errorPrefix/protocol/key", () => {
    renderBindings({
      errorPrefix: "/channels/orders/bindings",
      value: { kafka: { topic: "bad topic!", bindingVersion: V("kafka", "channel") } },
      errors: [{ pointer: "/channels/orders/bindings/kafka/topic", message: "Topic has invalid characters" }],
    });
    expect(screen.getByTestId("b-kafka-topic-error").textContent).toBe("Topic has invalid characters");
    expect(el("b-kafka-topic").getAttribute("aria-invalid")).toBe("true");
  });

  it("shows a problem about a whole protocol entry on that entry", () => {
    renderBindings({
      errorPrefix: "/servers/prod/bindings",
      value: { kafka: { schemaRegistryUrl: "https://r.example.com", bindingVersion: V("kafka", "server") } },
      target: "server",
      errors: [{ pointer: "/servers/prod/bindings/kafka", message: "Unsupported binding version" }],
    });
    expect(screen.getByTestId("b-kafka-error").textContent).toBe("Unsupported binding version");
  });

  it("disables the protocol select, Add, Remove and every field", () => {
    renderBindings({ disabled: true, value: { kafka: { topic: "t", bindingVersion: V("kafka", "channel") } } });
    expect(select().disabled).toBe(true);
    expect(addButton().disabled).toBe(true);
    expect((screen.getByTestId("b-kafka-remove") as HTMLButtonElement).disabled).toBe(true);
    expect(el("b-kafka-topic").disabled).toBe(true);
  });

  it("follows a change of the value from outside", () => {
    const { probe } = renderBindings({ value: { kafka: { topic: "t", bindingVersion: V("kafka", "channel") } } });
    probe.set({ kafka: { topic: "changed", bindingVersion: V("kafka", "channel") }, amqp: { is: "queue", bindingVersion: V("amqp", "channel") } });
    expect(el("b-kafka-topic").value).toBe("changed");
    expect(screen.getByTestId("b-amqp")).toBeTruthy();
  });
});
