// @vitest-environment jsdom
import { cleanup, render, screen } from "@testing-library/react";
import { afterEach, expect, it } from "vitest";
import { AsyncApiVisual } from "@/features/events/event-page/AsyncApiVisual";

afterEach(cleanup);
const DOC = {
  asyncapi: "3.0.0",
  info: { title: "Accounts", version: "1.2.0", "x-cloudevents-source": "urn:app:accounts" },
  defaultContentType: "application/json",
  servers: { prod: { host: "kafka:9092", protocol: "kafka" } },
  channels: { decisions: { address: "accounts.decisions.v1", messages: { Decision: { $ref: "#/components/messages/Decision" } } } },
  operations: { publishDecision: { action: "send", channel: { $ref: "#/channels/decisions" }, messages: [{ $ref: "#/channels/decisions/messages/Decision" }] } },
  components: {
    messages: {
      Decision: {
        name: "Decision", contentType: "application/json", traits: [{ $ref: "#/components/messageTraits/CloudEvents" }],
        payload: { type: "object", required: ["id"], properties: { id: { type: "string" }, reasons: { type: "array", items: { type: "string" } }, actor: { type: "object", properties: { name: { type: "string" } } } } },
      },
    },
    messageTraits: { CloudEvents: { headers: { type: "object" } } },
  },
};

it("shows the flow, the channel, the message with its payload tree and traits, and the event's facts", () => {
  render(<AsyncApiVisual document={DOC} />);
  expect(screen.getByTestId("visual-flow-publishDecision").textContent).toMatch(/send.*publishDecision.*accounts\.decisions\.v1.*Decision/);
  expect(screen.getByTestId("visual-channel-decisions").textContent).toContain("accounts.decisions.v1");
  const message = screen.getByTestId("visual-message-Decision");
  expect(message.textContent).toContain("CloudEvents");
  expect(message.textContent).toMatch(/idstringrequired/);
  expect(message.textContent).toContain("string[]");
  expect(message.textContent).toMatch(/actor.*name/);
  expect(screen.getByTestId("asyncapi-visual").textContent).toContain("urn:app:accounts");
  expect(screen.getByTestId("visual-servers")).toBeTruthy();
  expect(screen.queryByTestId("visual-security")).toBeNull();
});
it("says nothing is defined for an empty document", () => {
  render(<AsyncApiVisual document={{ asyncapi: "3.0.0", info: { title: "Empty", version: "draft" } }} />);
  expect(screen.getByTestId("visual-empty")).toBeTruthy();
  expect(screen.queryByTestId("visual-channels")).toBeNull();
});
it("lists Avro record fields with optional ones not required", () => {
  const avro = { ...DOC, components: { messages: { Decision: { name: "Decision", payload: { schemaFormat: "application/vnd.apache.avro+json;version=1.9.0", schema: { type: "record", name: "D", fields: [{ name: "id", type: "string" }, { name: "note", type: ["null", "string"] }] } } } } } };
  render(<AsyncApiVisual document={avro} />);
  const text = screen.getByTestId("visual-message-Decision").textContent ?? "";
  expect(text).toMatch(/idstringrequired/);
  expect(text).toMatch(/notestring(?!required)/);
});
