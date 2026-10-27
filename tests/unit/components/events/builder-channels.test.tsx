// @vitest-environment jsdom
import { act, cleanup, fireEvent, screen, within } from "@testing-library/react";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { SECTION_COMPONENTS } from "@/features/events/builder/EventBuilder";
import { ChannelsSection } from "@/features/events/builder/sections/ChannelsSection";
import type { SaveDocument } from "@/features/events/builder/use-event-draft";
import { parseEventDocument } from "@/lib/events/document/parse";
import { emptyEventDocument, type EventDocument } from "@/lib/events/document/types";
import { KNOWN_PROTOCOLS } from "@/lib/events/inputs";
import { bindingVersion, TEMPLATES } from "@/lib/events/templates";
import { maximalDocument } from "../../lib/events/document/fixtures/maximal-document";
import { PIN, renderBuilder, renderSection, sampleDocument } from "./builder-harness";

// The external-reference card asks the server about the references of a document: keep that action module out of the test process.
vi.mock("@/app/(dashboard)/schemas/[domainSlug]/[productSlug]/event-actions", () => ({
  getExternalRefStatusesAction: () => Promise.resolve({ success: false, error: "unavailable" }),
  getExternalVersionItemsAction: () => Promise.resolve({ success: false, error: "unavailable" }),
}));

beforeEach(() => vi.clearAllMocks());
afterEach(() => {
  cleanup();
  vi.restoreAllMocks();
});

/** A tab shows the item's label; what the list row printed under it (the subtitle) is in the tab's title: "label — subtitle". */
const rowTitle = (testId: string) => screen.getByTestId(testId).getAttribute("title") ?? "";
const type = (el: HTMLElement, value: string) => fireEvent.change(el, { target: { value } });
const click = (testId: string) => fireEvent.click(screen.getByTestId(testId));
const field = (label: string) => screen.getByLabelText(label) as HTMLInputElement;
const box = (testId: string) => screen.getByTestId(testId) as HTMLInputElement;
const select = (testId: string) => screen.getByTestId(testId) as unknown as HTMLSelectElement;
const text = (testId: string) => screen.getByTestId(testId).textContent;
const missing = (testId: string) => screen.queryByTestId(testId) === null;
const optionValues = (el: HTMLElement) => Array.from(el.querySelectorAll("option")).map((o) => o.getAttribute("value"));
const datalistValues = (listId: string) => optionValues(document.getElementById(listId) as HTMLElement);

/** sampleDocument without the explicit `format` its channels carry: a channel that follows its messages (Auto). */
function autoDocument(): EventDocument {
  const doc = sampleDocument();
  for (const c of doc.channels) delete c.format;
  return doc;
}

/** sampleDocument + a second message on `refunds` and an operation that replies on it. */
function docWithReply(): EventDocument {
  const doc = sampleDocument();
  doc.messages.push({ key: "RefundIssued", payload: PIN, traitKeys: [] });
  doc.channels[1].messageKeys = ["RefundIssued"];
  doc.operations.push({
    key: "askRefund", action: "send", channelKey: "orders", messageKeys: ["OrderCreated"], traitKeys: [],
    reply: { channelKey: "refunds", messageKeys: ["RefundIssued"] },
  });
  return doc;
}

/** Two servers speaking different protocols, and a channel on none of them. */
function mixedServersDocument(protocol = "kafka"): EventDocument {
  return {
    ...emptyEventDocument("Orders"),
    servers: [
      { key: "rabbit", protocol: "amqp", host: "mq.internal:5672" },
      { key: "kafka-prod", protocol: "kafka", host: "prod.internal:9092" },
    ],
    channels: [{ key: "orders", address: "orders.v1", protocol, serverKeys: [], messageKeys: [] }],
  };
}

it("the fixtures are valid documents, so any problem below comes from the edit under test", () => {
  for (const doc of [sampleDocument(), autoDocument(), docWithReply(), mixedServersDocument(), maximalDocument()]) {
    expect(parseEventDocument(doc).success).toBe(true);
  }
});

it("is registered as the channels section of the builder", () => {
  expect(SECTION_COMPONENTS.channels).toBe(ChannelsSection);
});

describe("ChannelsSection: list and selection", () => {
  it("lists the channels by what the user would call them: title, else address, else key; the protocol sits under it", () => {
    const doc = sampleDocument();
    doc.channels[0] = { ...doc.channels[0], title: "Order events" };
    doc.channels[1] = { ...doc.channels[1], address: null };
    renderSection(ChannelsSection, { doc });
    const first = rowTitle("channel-row-orders");
    expect(first).toContain("Order events");
    expect(first).toContain("kafka");
    expect(first).not.toContain("orders.v1");
    expect(rowTitle("channel-row-refunds")).toContain("refunds");
    cleanup();
    renderSection(ChannelsSection);
    expect(rowTitle("channel-row-orders")).toContain("orders.v1");
    expect(rowTitle("channel-row-refunds")).toContain("refunds.v1");
  });

  it("shows the first channel's form and selects another on click", () => {
    renderSection(ChannelsSection);
    expect(screen.getByTestId("channel-row-orders").getAttribute("aria-current")).toBe("true");
    expect(field("Address").value).toBe("orders.v1");
    expect(text("channel-key-value")).toBe("orders");
    click("channel-row-refunds");
    expect(screen.getByTestId("channel-row-refunds").getAttribute("aria-current")).toBe("true");
    expect(screen.getByTestId("channel-row-orders").hasAttribute("aria-current")).toBe(false);
    expect(field("Address").value).toBe("refunds.v1");
    expect(text("channel-key-value")).toBe("refunds");
  });

  it("opens the channel named by the selected item and falls back to the first when it is gone", () => {
    renderSection(ChannelsSection, { item: "refunds" });
    expect(text("channel-key-value")).toBe("refunds");
    cleanup();
    renderSection(ChannelsSection, { item: "gone" });
    expect(text("channel-key-value")).toBe("orders");
  });

  it("shows an empty state with the primary action when there are no channels", () => {
    const { probe } = renderSection(ChannelsSection, { doc: emptyEventDocument("Orders") });
    const empty = screen.getByTestId("channel-empty");
    expect(empty.textContent).toContain("No channels yet");
    expect(missing("channel-add")).toBe(true);
    fireEvent.click(within(empty).getByRole("button", { name: "Add channel" }));
    expect(probe.draft.doc.channels).toHaveLength(1);
    expect(missing("channel-empty")).toBe(true);
  });

  it("marks a channel that has problems in the list", () => {
    const doc = sampleDocument();
    doc.channels[1] = { ...doc.channels[1], serverKeys: ["nope"] };
    renderSection(ChannelsSection, { doc });
    expect(text("channel-row-refunds")).toContain("has problems");
    expect(text("channel-row-orders")).not.toContain("has problems");
  });
});

describe("ChannelsSection: add channel", () => {
  it("creates a minimal channel with a placeholder key, selects it and keeps adding unique placeholders", () => {
    const { probe } = renderSection(ChannelsSection);
    click("channel-add");
    expect(probe.draft.doc.channels.map((c) => c.key)).toEqual(["orders", "refunds", "channel"]);
    // No payload format: a channel follows its messages unless the user overrides it under Advanced.
    expect(probe.draft.doc.channels[2]).toEqual({ key: "channel", address: null, protocol: "kafka", serverKeys: [], messageKeys: [] });
    expect(probe.item).toBe("channel");
    expect(text("channel-key-value")).toBe("channel");
    expect(probe.draft.problems).toEqual([]);
    click("channel-add");
    expect(probe.draft.doc.channels.map((c) => c.key)).toEqual(["orders", "refunds", "channel", "channel-2"]);
    expect(probe.item).toBe("channel-2");
    expect(probe.draft.dirty).toBe(true);
  });

  it("takes the protocol of the first server, and falls back to kafka without servers", () => {
    const doc = sampleDocument();
    doc.servers = [{ key: "rabbit", protocol: "amqp", host: "mq.internal:5672" }];
    doc.channels = doc.channels.map((c) => ({ ...c, serverKeys: [] }));
    const first = renderSection(ChannelsSection, { doc });
    click("channel-add");
    expect(first.probe.draft.doc.channels[2].protocol).toBe("amqp");
    cleanup();
    const second = renderSection(ChannelsSection, { doc: { ...emptyEventDocument("Orders") } });
    click("channel-empty-add");
    expect(second.probe.draft.doc.channels[0].protocol).toBe("kafka");
  });

  it("does not reuse the key of an external channel reference", () => {
    const doc = sampleDocument();
    doc.externalRefs = [{ key: "channel", eventVersionId: "v1", kind: "channel", itemKey: "remote" }];
    const { probe } = renderSection(ChannelsSection, { doc });
    click("channel-add");
    expect(probe.draft.doc.channels[2].key).toBe("channel-2");
  });
});

describe("ChannelsSection: where it lives", () => {
  it("edits the address and the protocol of the selected channel only", () => {
    const { probe } = renderSection(ChannelsSection, { item: "refunds" });
    type(field("Address"), "refunds.v2");
    type(box("channel-protocol"), "amqp");
    expect(probe.draft.doc.channels[1]).toMatchObject({ key: "refunds", address: "refunds.v2", protocol: "amqp" });
    expect(probe.draft.doc.channels[0]).toMatchObject({ key: "orders", address: "orders.v1", protocol: "kafka" });
  });

  it("stores a blank address as null, never as an empty string", () => {
    const { probe } = renderSection(ChannelsSection);
    type(field("Address"), "");
    expect(probe.draft.doc.channels[0].address).toBeNull();
    expect(probe.draft.problems).toEqual([]);
  });

  it("explains the {parameter} syntax of the address next to the field", () => {
    renderSection(ChannelsSection);
    const hint = text("channel-address-hint") ?? "";
    expect(hint).toContain("{name}");
    expect((field("Address").getAttribute("aria-describedby") ?? "").split(" ")).toContain("channel-address-hint");
  });

  it("is a text field with the known protocols as suggestions, and still takes any other", () => {
    const { probe } = renderSection(ChannelsSection);
    expect(datalistValues(box("channel-protocol").getAttribute("list") as string)).toEqual(expect.arrayContaining([...KNOWN_PROTOCOLS]));
    type(box("channel-protocol"), "my-broker");
    expect(probe.draft.doc.channels[0].protocol).toBe("my-broker");
  });

  it("offers every server as a checkbox, labelled by its title or host, and toggles channels[].serverKeys", () => {
    const doc = sampleDocument();
    doc.servers[0] = { ...doc.servers[0], title: "Production" };
    const { probe } = renderSection(ChannelsSection, { doc });
    expect(box("channel-servers-option-kafka-prod").closest("label")?.textContent).toContain("Production");
    expect(box("channel-servers-option-kafka-dev").closest("label")?.textContent).toContain("dev.internal:9092");
    expect(box("channel-servers-option-kafka-prod").checked).toBe(true);
    expect(box("channel-servers-option-kafka-dev").checked).toBe(false);
    fireEvent.click(box("channel-servers-option-kafka-dev"));
    expect(probe.draft.doc.channels[0].serverKeys).toEqual(["kafka-prod", "kafka-dev"]);
    fireEvent.click(box("channel-servers-option-kafka-prod"));
    expect(probe.draft.doc.channels[0].serverKeys).toEqual(["kafka-dev"]);
    expect(probe.draft.doc.channels[1].serverKeys).toEqual(["kafka-prod", "kafka-dev"]);
    expect(probe.draft.problems).toEqual([]);
  });

  it("tells the user when there are no servers instead of rendering an empty group", () => {
    const doc = emptyEventDocument("Orders");
    doc.channels = [{ key: "orders", address: null, protocol: "kafka", serverKeys: [], messageKeys: [] }];
    renderSection(ChannelsSection, { doc });
    expect(text("channel-servers-empty")).toContain("No servers");
  });

  it("shows a server the channel still lists but the document no longer defines, so it can be unchecked", () => {
    const doc = sampleDocument();
    doc.channels[0] = { ...doc.channels[0], serverKeys: ["kafka-prod", "ghost"] };
    const { probe } = renderSection(ChannelsSection, { doc });
    const ghost = box("channel-servers-option-ghost");
    expect(ghost.checked).toBe(true);
    expect(ghost.closest("label")?.textContent).toContain("unavailable");
    expect(text("channel-servers-error")).toBe('Unknown server "ghost"');
    fireEvent.click(ghost);
    expect(probe.draft.doc.channels[0].serverKeys).toEqual(["kafka-prod"]);
    expect(probe.draft.problems).toEqual([]);
  });
});

describe("ChannelsSection: the protocol follows the servers", () => {
  it("a channel still on the default protocol takes the protocol of the first server it is put on", () => {
    const { probe } = renderSection(ChannelsSection, { doc: mixedServersDocument("kafka") });
    fireEvent.click(box("channel-servers-option-rabbit"));
    expect(probe.draft.doc.channels[0]).toMatchObject({ serverKeys: ["rabbit"], protocol: "amqp" });
    expect(box("channel-protocol").value).toBe("amqp");
    expect(probe.draft.problems).toEqual([]);
  });

  it("an empty protocol is filled in from the first server", () => {
    const { probe } = renderSection(ChannelsSection, { doc: mixedServersDocument("") });
    fireEvent.click(box("channel-servers-option-kafka-prod"));
    expect(probe.draft.doc.channels[0].protocol).toBe("kafka");
  });

  it("a protocol the user chose is never replaced by a server's", () => {
    const { probe } = renderSection(ChannelsSection, { doc: mixedServersDocument("mqtt") });
    fireEvent.click(box("channel-servers-option-rabbit"));
    fireEvent.click(box("channel-servers-option-kafka-prod"));
    expect(probe.draft.doc.channels[0]).toMatchObject({ serverKeys: ["rabbit", "kafka-prod"], protocol: "mqtt" });
  });

  it("only the FIRST selected server decides: adding a second one changes nothing", () => {
    const { probe } = renderSection(ChannelsSection, { doc: mixedServersDocument("kafka") });
    fireEvent.click(box("channel-servers-option-rabbit"));
    fireEvent.click(box("channel-servers-option-kafka-prod"));
    expect(probe.draft.doc.channels[0]).toMatchObject({ serverKeys: ["rabbit", "kafka-prod"], protocol: "amqp" });
  });

  it("keeps following while the protocol is still the one it took from the first server", () => {
    const { probe } = renderSection(ChannelsSection, { doc: mixedServersDocument("kafka") });
    fireEvent.click(box("channel-servers-option-rabbit"));
    expect(probe.draft.doc.channels[0].protocol).toBe("amqp");
    fireEvent.click(box("channel-servers-option-rabbit"));
    expect(probe.draft.doc.channels[0]).toMatchObject({ serverKeys: [], protocol: "amqp" });
    fireEvent.click(box("channel-servers-option-kafka-prod"));
    expect(probe.draft.doc.channels[0]).toMatchObject({ serverKeys: ["kafka-prod"], protocol: "kafka" });
  });

  it("clearing every server leaves the protocol alone", () => {
    const doc = mixedServersDocument("amqp");
    doc.channels[0] = { ...doc.channels[0], serverKeys: ["rabbit"] };
    const { probe } = renderSection(ChannelsSection, { doc });
    fireEvent.click(box("channel-servers-option-rabbit"));
    expect(probe.draft.doc.channels[0]).toMatchObject({ serverKeys: [], protocol: "amqp" });
  });

  it("a server with the same protocol changes nothing", () => {
    const { probe } = renderSection(ChannelsSection, { doc: mixedServersDocument("kafka") });
    fireEvent.click(box("channel-servers-option-kafka-prod"));
    expect(probe.draft.doc.channels[0]).toMatchObject({ serverKeys: ["kafka-prod"], protocol: "kafka" });
  });
});

describe("ChannelsSection: address parameters", () => {
  it("adds a parameter card for each {name} in the address, so the document stays valid", () => {
    const { probe } = renderSection(ChannelsSection);
    expect(missing("channel-parameters")).toBe(true);
    type(field("Address"), "orders.{tenantId}");
    expect(probe.draft.doc.channels[0].address).toBe("orders.{tenantId}");
    expect(probe.draft.doc.channels[0].parameters).toEqual({ tenantId: {} });
    expect(probe.draft.problems).toEqual([]);
    expect(parseEventDocument(probe.draft.doc).success).toBe(true);
    expect(text("channel-parameters")).toContain("tenantId");
    expect(text("channel-parameter-0")).toContain("tenantId");
  });

  it("draws each parameter from the channel parameter template: basics up front, the rest under 'More properties'", () => {
    renderSection(ChannelsSection);
    type(field("Address"), "orders.{tenantId}");
    const basics = TEMPLATES.channelParameter.fields.filter((f) => f.group === "basics").map((f) => f.key);
    const more = TEMPLATES.channelParameter.fields.filter((f) => f.group === "more").map((f) => f.key);
    expect(basics).toEqual(["description", "enum", "default"]);
    expect(more).toEqual(["examples", "location"]);
    for (const key of basics) expect(missing(`channel-parameter-0-${key}`), `basics ${key}`).toBe(false);
    for (const key of more) expect(missing(`channel-parameter-0-${key}`), `more ${key} while collapsed`).toBe(true);
    click("channel-parameter-0-more-toggle");
    for (const key of more) expect(missing(`channel-parameter-0-${key}`), `more ${key} once open`).toBe(false);
  });

  it("one card per distinct name, in address order", () => {
    const { probe } = renderSection(ChannelsSection);
    type(field("Address"), "{region}.orders.{tenantId}.{region}");
    expect(Object.keys(probe.draft.doc.channels[0].parameters ?? {})).toEqual(["region", "tenantId"]);
    expect(screen.getAllByTestId(/^channel-parameter-\d+$/)).toHaveLength(2);
    expect(text("channel-parameter-0")).toContain("region");
    expect(text("channel-parameter-1")).toContain("tenantId");
    expect(probe.draft.problems).toEqual([]);
  });

  it("writes description, allowed values, default, examples and location into that parameter's definition", () => {
    const { probe } = renderSection(ChannelsSection);
    type(field("Address"), "orders.{tenantId}");
    type(box("channel-parameter-0-description"), "The tenant");
    type(box("channel-parameter-0-enum"), "acme");
    fireEvent.keyDown(box("channel-parameter-0-enum"), { key: "Enter" });
    type(box("channel-parameter-0-default"), "acme");
    click("channel-parameter-0-more-toggle");
    type(box("channel-parameter-0-examples"), "globex");
    fireEvent.keyDown(box("channel-parameter-0-examples"), { key: "Enter" });
    type(box("channel-parameter-0-location"), "$message.payload#/tenant");
    expect(probe.draft.doc.channels[0].parameters).toEqual({
      tenantId: { description: "The tenant", enum: ["acme"], default: "acme", examples: ["globex"], location: "$message.payload#/tenant" },
    });
    expect(probe.draft.problems).toEqual([]);
  });

  it("clearing every field of a parameter keeps the (empty) definition the address needs", () => {
    const { probe } = renderSection(ChannelsSection);
    type(field("Address"), "orders.{tenantId}");
    type(box("channel-parameter-0-description"), "The tenant");
    type(box("channel-parameter-0-description"), "");
    expect(probe.draft.doc.channels[0].parameters).toEqual({ tenantId: {} });
    expect(probe.draft.problems).toEqual([]);
  });

  it("keeps the definition of a name that is still in the address", () => {
    const { probe } = renderSection(ChannelsSection);
    type(field("Address"), "orders.{tenantId}");
    type(box("channel-parameter-0-description"), "The tenant");
    type(field("Address"), "orders.{tenantId}.v2");
    expect(probe.draft.doc.channels[0].parameters).toEqual({ tenantId: { description: "The tenant" } });
    expect(box("channel-parameter-0-description").value).toBe("The tenant");
  });

  it("removes the definition when its name leaves the address and drops the empty parameters object", () => {
    const { probe } = renderSection(ChannelsSection);
    type(field("Address"), "orders.{tenantId}");
    type(field("Address"), "orders.v1");
    expect("parameters" in probe.draft.doc.channels[0]).toBe(false);
    expect(missing("channel-parameters")).toBe(true);
    expect(probe.draft.problems).toEqual([]);
  });

  it("replaces a renamed expression and leaves definitions the address never mentioned alone", () => {
    const doc = sampleDocument();
    doc.channels[0] = { ...doc.channels[0], address: "orders.{a}", parameters: { a: {}, extra: { description: "unrelated" } } };
    const { probe } = renderSection(ChannelsSection, { doc });
    type(field("Address"), "orders.{b}");
    expect(probe.draft.doc.channels[0].parameters).toEqual({ extra: { description: "unrelated" }, b: {} });
    expect(probe.draft.problems).toEqual([]);
  });

  it("works for names that collide with Object.prototype members", () => {
    const { probe } = renderSection(ChannelsSection);
    type(field("Address"), "orders.{constructor}");
    expect(Object.keys(probe.draft.doc.channels[0].parameters ?? {})).toEqual(["constructor"]);
    expect(probe.draft.problems).toEqual([]);
  });

  it("an empty expression is reported at the address and adds no card", () => {
    const { probe } = renderSection(ChannelsSection);
    type(field("Address"), "orders.{}");
    expect(text("channel-address-error")).toBe('Address contains an empty expression "{}"');
    expect(probe.draft.doc.channels[0].parameters).toBeUndefined();
    expect(missing("channel-parameters")).toBe(true);
  });

  it("shows the parser's problem for a parameter under that parameter's field", () => {
    const doc = sampleDocument();
    doc.channels[0] = { ...doc.channels[0], address: "orders.{tenantId}", parameters: { tenantId: { location: "payload.tenant" } } };
    renderSection(ChannelsSection, { doc });
    const problem = parseEventDocument(doc);
    expect(problem.success).toBe(false);
    expect(text("channel-parameter-0-location-error")).toBeTruthy();
    expect(box("channel-parameter-0-location").getAttribute("aria-invalid")).toBe("true");
  });

  it("a definition the address needs but the document lacks is reported once, at the parameters", () => {
    const doc = sampleDocument();
    doc.channels[0] = { ...doc.channels[0], address: "orders.{tenantId}" };
    renderSection(ChannelsSection, { doc });
    expect(text("channel-parameters-error")).toBe('Address expression "{tenantId}" needs a parameter definition');
  });
});

describe("ChannelsSection: what it carries", () => {
  it("edits title, summary and description and removes them when blanked", () => {
    const { probe } = renderSection(ChannelsSection);
    type(field("Title"), "Orders");
    type(field("Summary"), "All orders");
    type(box("channel-description"), "Every order event");
    expect(probe.draft.doc.channels[0]).toMatchObject({ title: "Orders", summary: "All orders", description: "Every order event" });
    type(field("Title"), "");
    type(field("Summary"), "");
    type(box("channel-description"), "");
    for (const k of ["title", "summary", "description"]) expect(k in probe.draft.doc.channels[0]).toBe(false);
  });

  it("keeps tags and external documentation under a collapsed 'More properties (0 set)'", () => {
    renderSection(ChannelsSection);
    expect(text("channel-more-toggle")).toBe("More properties (0 set)");
    for (const key of ["tags", "externalDocs"]) expect(missing(`channel-${key}`), key).toBe(true);
  });

  it("writes external documentation and tags, and removes them when emptied", () => {
    const { probe } = renderSection(ChannelsSection);
    click("channel-more-toggle");
    type(box("channel-externalDocs-url"), "https://example.com/orders");
    type(box("channel-tags"), "orders");
    fireEvent.keyDown(box("channel-tags"), { key: "Enter" });
    expect(probe.draft.doc.channels[0]).toMatchObject({ externalDocs: { url: "https://example.com/orders" }, tags: [{ name: "orders" }] });
    expect(probe.draft.problems).toEqual([]);
    type(box("channel-externalDocs-url"), "");
    fireEvent.click(screen.getByTestId("channel-tags-chip-0-remove"));
    expect("externalDocs" in probe.draft.doc.channels[0]).toBe(false);
    expect("tags" in probe.draft.doc.channels[0]).toBe(false);
  });

  it("every property of the channel template is reachable once 'More properties' is open", () => {
    const doc = sampleDocument();
    doc.channels[0] = { ...doc.channels[0], address: "orders.{tenantId}", parameters: { tenantId: {} } };
    renderSection(ChannelsSection, { doc });
    click("channel-more-toggle");
    const keys = TEMPLATES.channel.fields.map((f) => f.key);
    expect(keys).toEqual(["address", "title", "summary", "description", "servers", "parameters", "messages", "tags", "externalDocs", "bindings"]);
    // servers, parameters, messages and bindings are drawn by hand (they follow the document's other parts); the rest by the template form.
    for (const key of keys) expect(missing(`channel-${key}`), `channel.${key}`).toBe(false);
  });

  it("the payload format question is gone from the main form: no Format select, no dialect select", () => {
    renderSection(ChannelsSection, { doc: autoDocument() });
    expect(screen.queryByLabelText("Format")).toBeNull();
    expect(missing("channel-format")).toBe(true);
    expect(missing("channel-format-override")).toBe(true);
    expect(missing("channel-dialect")).toBe(true);
  });

  it("lists the document's messages by name, title or key as checkboxes and toggles channels[].messageKeys", () => {
    const doc = docWithReply();
    doc.messages[1] = { ...doc.messages[1], name: "refund.issued" };
    const { probe } = renderSection(ChannelsSection, { doc, item: "refunds" });
    expect(box("channel-messages-option-RefundIssued").closest("label")?.textContent).toContain("refund.issued");
    expect(box("channel-messages-option-OrderCreated").closest("label")?.textContent).toContain("OrderCreated");
    expect(box("channel-messages-option-RefundIssued").checked).toBe(true);
    expect(box("channel-messages-option-OrderCreated").checked).toBe(false);
    fireEvent.click(box("channel-messages-option-OrderCreated"));
    expect(probe.draft.doc.channels[1].messageKeys).toEqual(["RefundIssued", "OrderCreated"]);
    fireEvent.click(box("channel-messages-option-OrderCreated"));
    expect(probe.draft.doc.channels[1].messageKeys).toEqual(["RefundIssued"]);
    expect(probe.draft.doc.channels[0].messageKeys).toEqual(["OrderCreated"]);
    expect(missing("channel-messages-blocked")).toBe(true);
  });

  it("refuses to uncheck a message that an operation on this channel uses, and names the operation", () => {
    const { probe } = renderSection(ChannelsSection);
    fireEvent.click(box("channel-messages-option-OrderCreated"));
    const notice = text("channel-messages-blocked") ?? "";
    expect(notice).toContain('"publishOrder"');
    expect(notice).toContain('"OrderCreated"');
    expect(notice).toContain('"orders"');
    expect(box("channel-messages-option-OrderCreated").checked).toBe(true);
    expect(probe.draft.doc.channels[0].messageKeys).toEqual(["OrderCreated"]);
    expect(probe.draft.dirty).toBe(false);
    expect(probe.draft.problems).toEqual([]);
  });

  it("also refuses when the message is the reply of an operation that replies on this channel", () => {
    const { probe } = renderSection(ChannelsSection, { doc: docWithReply(), item: "refunds" });
    fireEvent.click(box("channel-messages-option-RefundIssued"));
    expect(text("channel-messages-blocked")).toContain('"askRefund"');
    expect(probe.draft.doc.channels[1].messageKeys).toEqual(["RefundIssued"]);
  });

  it("names every operation that blocks the uncheck", () => {
    const doc = sampleDocument();
    doc.operations.push({ key: "audit", action: "receive", channelKey: "orders", messageKeys: ["OrderCreated"], traitKeys: [] });
    renderSection(ChannelsSection, { doc });
    fireEvent.click(box("channel-messages-option-OrderCreated"));
    const notice = text("channel-messages-blocked") ?? "";
    expect(notice).toContain('"publishOrder"');
    expect(notice).toContain('"audit"');
  });

  it("clears the notice once the user allows or disallows another message successfully", () => {
    const doc = sampleDocument();
    doc.messages.push({ key: "Other", payload: PIN, traitKeys: [] });
    const { probe } = renderSection(ChannelsSection, { doc });
    fireEvent.click(box("channel-messages-option-OrderCreated"));
    expect(missing("channel-messages-blocked")).toBe(false);
    fireEvent.click(box("channel-messages-option-Other"));
    expect(missing("channel-messages-blocked")).toBe(true);
    expect(probe.draft.doc.channels[0].messageKeys).toEqual(["OrderCreated", "Other"]);
  });

  it("allows unchecking a message that no operation on this channel uses, even if another channel's operation does", () => {
    const doc = sampleDocument();
    doc.channels[1] = { ...doc.channels[1], messageKeys: ["OrderCreated"] };
    const { probe } = renderSection(ChannelsSection, { doc, item: "refunds" });
    fireEvent.click(box("channel-messages-option-OrderCreated"));
    expect(missing("channel-messages-blocked")).toBe(true);
    expect(probe.draft.doc.channels[1].messageKeys).toEqual([]);
    expect(probe.draft.problems).toEqual([]);
  });

  it("tells the user there are no messages instead of rendering an empty group", () => {
    const doc = sampleDocument();
    doc.messages = [];
    doc.operations = [];
    doc.channels = doc.channels.map((c) => ({ ...c, messageKeys: [] }));
    renderSection(ChannelsSection, { doc });
    expect(text("channel-messages-empty")).toContain("No messages");
  });
});

describe("ChannelsSection: Advanced: override the payload format", () => {
  const OVERRIDE_LABEL = "Override the payload format for every message on this channel";

  it("is collapsed behind 'Advanced' for a channel that follows its messages", () => {
    renderSection(ChannelsSection, { doc: autoDocument() });
    expect(text("channel-advanced-toggle")).toContain("Advanced");
    expect(screen.getByTestId("channel-advanced-toggle").getAttribute("aria-expanded")).toBe("false");
    expect(missing("channel-advanced")).toBe(true);
    expect(missing("channel-format-override")).toBe(true);
  });

  it("opens to one select, Auto / Avro / JSON Schema / Protobuf, with Auto chosen when there is no format", () => {
    renderSection(ChannelsSection, { doc: autoDocument() });
    click("channel-advanced-toggle");
    expect(screen.getByTestId("channel-advanced-toggle").getAttribute("aria-expanded")).toBe("true");
    const override = field(OVERRIDE_LABEL) as unknown as HTMLSelectElement;
    expect(override).toBe(select("channel-format-override"));
    expect(optionValues(override)).toEqual(["", "avro", "json-schema", "protobuf"]);
    expect(Array.from(override.querySelectorAll("option")).map((o) => o.textContent)).toEqual(["Auto (follow the messages)", "Avro", "JSON Schema", "Protobuf"]);
    expect(override.value).toBe("");
    expect(missing("channel-dialect")).toBe(true);
  });

  it("writes `format` for Avro and Protobuf, and no dialect", () => {
    const { probe } = renderSection(ChannelsSection, { doc: autoDocument() });
    click("channel-advanced-toggle");
    type(select("channel-format-override"), "avro");
    expect(probe.draft.doc.channels[0].format).toBe("avro");
    expect("formatDialect" in probe.draft.doc.channels[0]).toBe(false);
    type(select("channel-format-override"), "protobuf");
    expect(probe.draft.doc.channels[0].format).toBe("protobuf");
    expect("formatDialect" in probe.draft.doc.channels[0]).toBe(false);
    expect(probe.draft.problems).toEqual([]);
  });

  it("JSON Schema stores the default dialect and lets the user pick the other one", () => {
    const { probe } = renderSection(ChannelsSection, { doc: autoDocument() });
    click("channel-advanced-toggle");
    type(select("channel-format-override"), "json-schema");
    expect(probe.draft.doc.channels[0]).toMatchObject({ format: "json-schema", formatDialect: "draft-07" });
    expect(select("channel-dialect").value).toBe("draft-07");
    expect(optionValues(select("channel-dialect"))).toEqual(["draft-07", "2020-12"]);
    type(select("channel-dialect"), "2020-12");
    expect(probe.draft.doc.channels[0]).toMatchObject({ format: "json-schema", formatDialect: "2020-12" });
    expect(probe.draft.problems).toEqual([]);
  });

  it("switching away from JSON Schema clears the dialect; starting again begins at the default dialect", () => {
    const doc = autoDocument();
    doc.channels[0] = { ...doc.channels[0], format: "json-schema", formatDialect: "2020-12" };
    const { probe } = renderSection(ChannelsSection, { doc });
    expect(select("channel-dialect").value).toBe("2020-12");
    type(select("channel-format-override"), "protobuf");
    expect(probe.draft.doc.channels[0].format).toBe("protobuf");
    expect("formatDialect" in probe.draft.doc.channels[0]).toBe(false);
    expect(missing("channel-dialect")).toBe(true);
    expect(probe.draft.problems).toEqual([]);
    type(select("channel-format-override"), "json-schema");
    expect(probe.draft.doc.channels[0].formatDialect).toBe("draft-07");
  });

  it("choosing Auto removes both `format` and `formatDialect`: the channel follows its messages again", () => {
    const doc = autoDocument();
    doc.channels[0] = { ...doc.channels[0], format: "json-schema", formatDialect: "2020-12" };
    const { probe } = renderSection(ChannelsSection, { doc });
    type(select("channel-format-override"), "");
    expect("format" in probe.draft.doc.channels[0]).toBe(false);
    expect("formatDialect" in probe.draft.doc.channels[0]).toBe(false);
    expect(select("channel-format-override").value).toBe("");
    expect(missing("channel-dialect")).toBe(true);
    expect(probe.draft.problems).toEqual([]);
  });

  it("starts open for a channel that already overrides the format, showing it", () => {
    renderSection(ChannelsSection);
    expect(screen.getByTestId("channel-advanced-toggle").getAttribute("aria-expanded")).toBe("true");
    expect(select("channel-format-override").value).toBe("avro");
  });

  it("stays open after the user chooses Auto, so the select does not vanish under their hands", () => {
    renderSection(ChannelsSection);
    type(select("channel-format-override"), "");
    expect(missing("channel-format-override")).toBe(false);
    expect(screen.getByTestId("channel-advanced-toggle").getAttribute("aria-expanded")).toBe("true");
  });

  it("the user can close it again", () => {
    renderSection(ChannelsSection);
    click("channel-advanced-toggle");
    expect(missing("channel-advanced")).toBe(true);
    expect(screen.getByTestId("channel-advanced-toggle").getAttribute("aria-expanded")).toBe("false");
  });

  it("edits unrelated to the format never add a `format` to a channel that follows its messages", () => {
    const { probe } = renderSection(ChannelsSection, { doc: autoDocument() });
    type(field("Title"), "Orders");
    type(box("channel-protocol"), "amqp");
    type(field("Address"), "orders.v2");
    expect("format" in probe.draft.doc.channels[0]).toBe(false);
    expect("formatDialect" in probe.draft.doc.channels[0]).toBe(false);
  });

  it("opens by itself to show a format problem from a failed save, under the select", async () => {
    const saveDocument = vi.fn<SaveDocument>().mockResolvedValue({
      success: false, error: "1 problem(s) in the event document", code: "VALIDATION_ERROR",
      details: { problems: [{ pointer: "/channels/0/format", message: "format must be one of avro, json-schema, protobuf" }] },
    });
    renderBuilder({ saveDocument, doc: autoDocument(), section: "channels" });
    expect(missing("channel-format-override")).toBe(true);
    type(field("Title"), "Orders");
    await act(async () => { click("builder-save"); });
    expect(text("channel-format-override-error")).toBe("format must be one of avro, json-schema, protobuf");
    expect(select("channel-format-override").getAttribute("aria-invalid")).toBe("true");
  });
});

describe("ChannelsSection: protocol bindings", () => {
  it("preselects the channel's own protocol, writes the template's fields with bindingVersion and drops `bindings` when cleared", () => {
    const { probe } = renderSection(ChannelsSection);
    expect(select("channel-bindings-protocol").value).toBe("kafka");
    click("channel-bindings-add");
    type(box("channel-bindings-kafka-partitions"), "12");
    expect(probe.draft.doc.channels[0].bindings).toEqual({ kafka: { partitions: 12, bindingVersion: bindingVersion("kafka", "channel") } });
    expect(probe.draft.problems).toEqual([]);
    type(box("channel-bindings-kafka-partitions"), "");
    expect("bindings" in probe.draft.doc.channels[0]).toBe(false);
  });

  it("follows the channel's protocol for the suggestion", () => {
    const doc = sampleDocument();
    doc.channels[0] = { ...doc.channels[0], protocol: "amqp" };
    renderSection(ChannelsSection, { doc });
    expect(select("channel-bindings-protocol").value).toBe("amqp");
  });

  it("keeps the bindings a channel already has when something else is edited", () => {
    const doc = sampleDocument();
    doc.channels[0] = { ...doc.channels[0], bindings: { kafka: { topic: "orders.v1", partitions: 3, bindingVersion: "0.5.0" } } };
    const { probe } = renderSection(ChannelsSection, { doc });
    type(field("Title"), "Orders");
    expect(probe.draft.doc.channels[0].bindings).toEqual({ kafka: { topic: "orders.v1", partitions: 3, bindingVersion: "0.5.0" } });
    expect(box("channel-bindings-kafka-topic").value).toBe("orders.v1");
  });

  it("edits only the selected channel's bindings", () => {
    const { probe } = renderSection(ChannelsSection, { item: "refunds" });
    click("channel-bindings-add");
    type(box("channel-bindings-kafka-replicas"), "3");
    expect(probe.draft.doc.channels[1].bindings).toMatchObject({ kafka: { replicas: 3 } });
    expect("bindings" in probe.draft.doc.channels[0]).toBe(false);
  });
});

describe("ChannelsSection: generated key", () => {
  it("starts with a placeholder, names the key from the title once the user leaves the form, and keeps the channel selected", () => {
    const { probe } = renderSection(ChannelsSection);
    click("channel-add");
    type(field("Title"), "Order events");
    expect(probe.draft.doc.channels[2].key).toBe("channel");
    fireEvent.blur(field("Title"));
    expect(probe.draft.doc.channels[2].key).toBe("Order-events");
    expect(probe.item).toBe("Order-events");
    expect(screen.getByTestId("channel-row-Order-events").getAttribute("aria-current")).toBe("true");
    expect(text("channel-key-value")).toBe("Order-events");
    expect(probe.draft.problems).toEqual([]);
  });

  it("without a title it names the key from the address", () => {
    const { probe } = renderSection(ChannelsSection);
    click("channel-add");
    type(field("Address"), "payments.refunded");
    fireEvent.blur(field("Address"));
    expect(probe.draft.doc.channels[2].key).toBe("payments.refunded");
    expect(probe.item).toBe("payments.refunded");
  });

  it("a title typed after the address still names the key, because the key waits while focus moves inside the form", () => {
    const { probe } = renderSection(ChannelsSection);
    click("channel-add");
    type(field("Address"), "payments.refunded");
    fireEvent.blur(field("Address"), { relatedTarget: field("Title") });
    expect(probe.draft.doc.channels[2].key).toBe("channel");
    type(field("Title"), "Refunds");
    fireEvent.blur(field("Title"));
    expect(probe.draft.doc.channels[2].key).toBe("Refunds");
  });

  it("keeps the placeholder while there is nothing to name it by", () => {
    const { probe } = renderSection(ChannelsSection);
    click("channel-add");
    fireEvent.blur(field("Summary"));
    expect(probe.draft.doc.channels[2].key).toBe("channel");
    expect(probe.item).toBe("channel");
  });

  it("renames only once: later edits of the title or address do not change the generated key", () => {
    const { probe } = renderSection(ChannelsSection);
    click("channel-add");
    type(field("Title"), "Order events");
    fireEvent.blur(field("Title"));
    type(field("Title"), "Order lifecycle events");
    fireEvent.blur(field("Title"));
    type(field("Address"), "orders.v9");
    fireEvent.blur(field("Address"));
    expect(probe.draft.doc.channels[2].key).toBe("Order-events");
    expect(probe.item).toBe("Order-events");
  });

  it("a channel of the document with a real key is never renamed by what is typed", () => {
    const { probe } = renderSection(ChannelsSection);
    type(field("Title"), "Something else");
    fireEvent.blur(field("Title"));
    expect(probe.draft.doc.channels[0].key).toBe("orders");
    expect(probe.draft.doc.operations[0].channelKey).toBe("orders");
  });

  it("two channels with the same title get distinct keys", () => {
    const { probe } = renderSection(ChannelsSection);
    click("channel-add");
    type(field("Title"), "Order events");
    fireEvent.blur(field("Title"));
    click("channel-add");
    type(field("Title"), "Order events");
    fireEvent.blur(field("Title"));
    expect(probe.draft.doc.channels.map((c) => c.key)).toEqual(["orders", "refunds", "Order-events", "Order-events-2"]);
    expect(probe.draft.problems).toEqual([]);
  });

  it("the automatic rename rewrites every reference to the channel, including an operation's reply", () => {
    const doc = docWithReply();
    doc.channels.push({ key: "channel", address: null, protocol: "kafka", serverKeys: [], messageKeys: [] });
    doc.operations.push({ key: "audit", action: "receive", channelKey: "channel", messageKeys: [], traitKeys: [] });
    doc.operations[1] = { ...doc.operations[1], reply: { channelKey: "channel", messageKeys: [] } };
    const { probe } = renderSection(ChannelsSection, { doc, item: "channel" });
    type(field("Title"), "Audit log");
    fireEvent.blur(field("Title"));
    expect(probe.draft.doc.channels[2].key).toBe("Audit-log");
    expect(probe.draft.doc.operations[2].channelKey).toBe("Audit-log");
    expect(probe.draft.doc.operations[1].reply?.channelKey).toBe("Audit-log");
    expect(probe.draft.problems).toEqual([]);
  });

  it("the Identifier shows the key, collapsed", () => {
    renderSection(ChannelsSection);
    expect((screen.getByTestId("channel-key-disclosure") as HTMLDetailsElement).open).toBe(false);
    expect(text("channel-key-value")).toBe("orders");
    expect(box("channel-key").value).toBe("orders");
  });

  it("renaming through the Identifier rewrites every operation reference, keeps the channel selected and the document valid", () => {
    const { probe } = renderSection(ChannelsSection, { doc: docWithReply(), item: "orders" });
    type(box("channel-key"), "orders-v1");
    fireEvent.blur(box("channel-key"));
    expect(probe.draft.doc.channels[0].key).toBe("orders-v1");
    expect(probe.draft.doc.operations.map((o) => o.channelKey)).toEqual(["orders-v1", "orders-v1"]);
    expect(probe.item).toBe("orders-v1");
    expect(screen.getByTestId("channel-row-orders-v1").getAttribute("aria-current")).toBe("true");
    expect(probe.draft.problems).toEqual([]);
  });

  it("renaming through the Identifier rewrites the reply channel of an operation too", () => {
    const { probe } = renderSection(ChannelsSection, { doc: docWithReply(), item: "refunds" });
    type(box("channel-key"), "refunds-v1");
    fireEvent.blur(box("channel-key"));
    expect(probe.draft.doc.operations[1].reply?.channelKey).toBe("refunds-v1");
    expect(probe.draft.problems).toEqual([]);
  });

  it("a manually chosen key is never replaced by a generated one", () => {
    const { probe } = renderSection(ChannelsSection);
    click("channel-add");
    type(box("channel-key"), "my-channel");
    fireEvent.blur(box("channel-key"));
    expect(probe.draft.doc.channels[2].key).toBe("my-channel");
    type(field("Title"), "Order events");
    fireEvent.blur(field("Title"));
    expect(probe.draft.doc.channels[2].key).toBe("my-channel");
  });

  it("rejects a key that another channel already uses, and one with a space", () => {
    const { probe } = renderSection(ChannelsSection, { item: "orders" });
    type(box("channel-key"), "refunds");
    fireEvent.blur(box("channel-key"));
    expect(text("channel-key-error")).toBe('The key "refunds" is already used.');
    type(box("channel-key"), "has space");
    expect(text("channel-key-error")).toContain("no spaces");
    expect(probe.draft.doc.channels[0].key).toBe("orders");
    expect(probe.draft.dirty).toBe(false);
  });

  it("editing address, protocol or format never rewrites the key", () => {
    const { probe } = renderSection(ChannelsSection);
    type(field("Address"), "something.else");
    type(box("channel-protocol"), "amqp");
    type(select("channel-format-override"), "protobuf");
    expect(probe.draft.doc.channels[0].key).toBe("orders");
    expect(probe.draft.doc.operations[0].channelKey).toBe("orders");
  });
});

describe("ChannelsSection: remove channel", () => {
  it("removes a channel nothing refers to without asking", () => {
    const confirm = vi.spyOn(window, "confirm").mockReturnValue(true);
    const { probe } = renderSection(ChannelsSection, { item: "refunds" });
    click("channel-remove");
    expect(confirm).not.toHaveBeenCalled();
    expect(probe.draft.doc.channels.map((c) => c.key)).toEqual(["orders"]);
    expect(probe.item).toBeNull();
    expect(text("channel-key-value")).toBe("orders");
    expect(probe.draft.problems).toEqual([]);
  });

  it("asks first when operations use the channel, then removes the channel and those operations", () => {
    const confirm = vi.spyOn(window, "confirm").mockReturnValue(true);
    const { probe } = renderSection(ChannelsSection, { item: "orders" });
    click("channel-remove");
    expect(confirm).toHaveBeenCalledTimes(1);
    expect(confirm.mock.calls[0][0]).toContain('"orders"');
    expect(confirm.mock.calls[0][0]).toContain("publishOrder");
    expect(probe.draft.doc.channels.map((c) => c.key)).toEqual(["refunds"]);
    expect(probe.draft.doc.operations).toEqual([]);
    expect(probe.draft.problems).toEqual([]);
  });

  it("changes nothing when the confirmation is declined", () => {
    vi.spyOn(window, "confirm").mockReturnValue(false);
    const { probe } = renderSection(ChannelsSection, { item: "orders" });
    click("channel-remove");
    expect(probe.draft.doc).toEqual(sampleDocument());
    expect(probe.draft.dirty).toBe(false);
  });

  it("never leaves a dangling reply channel: an operation that only replies on the removed channel loses its reply", () => {
    const confirm = vi.spyOn(window, "confirm").mockReturnValue(true);
    const { probe } = renderSection(ChannelsSection, { doc: docWithReply(), item: "refunds" });
    click("channel-remove");
    expect(confirm).toHaveBeenCalledTimes(1);
    expect(confirm.mock.calls[0][0]).toContain("askRefund");
    expect(probe.draft.doc.channels.map((c) => c.key)).toEqual(["orders"]);
    expect(probe.draft.doc.operations.map((o) => o.key)).toEqual(["publishOrder", "askRefund"]);
    expect("reply" in probe.draft.doc.operations[1]).toBe(false);
    expect(probe.draft.doc.operations[1].messageKeys).toEqual(["OrderCreated"]);
    expect(probe.draft.problems).toEqual([]);
  });

  it("deletes every operation that sits on the removed channel", () => {
    vi.spyOn(window, "confirm").mockReturnValue(true);
    const { probe } = renderSection(ChannelsSection, { doc: docWithReply(), item: "orders" });
    click("channel-remove");
    expect(probe.draft.doc.channels.map((c) => c.key)).toEqual(["refunds"]);
    expect(probe.draft.doc.operations).toEqual([]);
    expect(probe.draft.problems).toEqual([]);
    expect(JSON.stringify(probe.draft.doc)).not.toContain('"orders"');
  });

  it("keeps the messages of the removed channel in the document", () => {
    vi.spyOn(window, "confirm").mockReturnValue(true);
    const { probe } = renderSection(ChannelsSection, { item: "orders" });
    click("channel-remove");
    expect(probe.draft.doc.messages.map((m) => m.key)).toEqual(["OrderCreated"]);
  });
});

describe("ChannelsSection: field errors", () => {
  it("shows parser problems under the right field, linked with aria-describedby and aria-invalid", () => {
    renderSection(ChannelsSection, { item: "refunds" });
    type(field("Address"), "bad.{}");
    const error = screen.getByTestId("channel-address-error");
    expect(error.textContent).toBe('Address contains an empty expression "{}"');
    expect(field("Address").getAttribute("aria-invalid")).toBe("true");
    expect((field("Address").getAttribute("aria-describedby") ?? "").split(" ")).toContain(error.id);
    expect(error.hasAttribute("role")).toBe(false);
    expect(missing("channel-protocol-error")).toBe(true);
    type(field("Address"), "refunds.v1");
    expect(missing("channel-address-error")).toBe(true);
    expect(field("Address").hasAttribute("aria-invalid")).toBe(false);
  });

  it("links the group error of the servers and messages checkboxes to their fieldsets", () => {
    const doc = sampleDocument();
    doc.channels[0] = { ...doc.channels[0], serverKeys: ["ghost"], messageKeys: ["OrderCreated", "Missing"] };
    renderSection(ChannelsSection, { doc });
    const servers = screen.getByTestId("channel-servers");
    expect(servers.tagName).toBe("FIELDSET");
    expect((servers.getAttribute("aria-describedby") ?? "").split(" ")).toContain("channel-servers-error");
    expect(text("channel-servers-error")).toBe('Unknown server "ghost"');
    expect(text("channel-messages-error")).toBe('Unknown message "Missing"');
    expect((screen.getByTestId("channel-messages").getAttribute("aria-describedby") ?? "").split(" ")).toContain("channel-messages-error");
  });

  it("shows the errors of the channel at the selected index and not those of another channel", () => {
    const doc = sampleDocument();
    doc.channels[1] = { ...doc.channels[1], serverKeys: ["ghost"] };
    renderSection(ChannelsSection, { doc });
    expect(missing("channel-servers-error")).toBe(true);
    click("channel-row-refunds");
    expect(text("channel-servers-error")).toBe('Unknown server "ghost"');
  });

  it("shows the problems of a failed save (server problems) next to the field and keeps the edit", async () => {
    const saveDocument = vi.fn<SaveDocument>().mockResolvedValue({
      success: false, error: "1 problem(s) in the event document", code: "VALIDATION_ERROR",
      details: { problems: [{ pointer: "/channels/0/protocol", message: "protocol is required" }] },
    });
    const { probe } = renderBuilder({ saveDocument, section: "channels" });
    type(field("Address"), "orders.v2");
    await act(async () => { click("builder-save"); });
    expect(text("channel-protocol-error")).toBe("protocol is required");
    expect(box("channel-protocol").getAttribute("aria-invalid")).toBe("true");
    expect(field("Address").value).toBe("orders.v2");
    expect(probe.draft.dirty).toBe(true);
  });

  it("shows a problem of a failed save under a property in 'More properties', opening the group", async () => {
    const saveDocument = vi.fn<SaveDocument>().mockResolvedValue({
      success: false, error: "1 problem(s) in the event document", code: "VALIDATION_ERROR",
      details: { problems: [{ pointer: "/channels/0/externalDocs/url", message: "url must be an absolute URL" }] },
    });
    renderBuilder({ saveDocument, section: "channels" });
    type(field("Title"), "Orders");
    await act(async () => { click("builder-save"); });
    expect(text("channel-externalDocs-url-error")).toBe("url must be an absolute URL");
    expect(box("channel-externalDocs-url").getAttribute("aria-invalid")).toBe("true");
  });

  it("an empty draft channel saves: the section never blocks Save", async () => {
    const { probe } = renderBuilder({ doc: emptyEventDocument("Orders"), section: "channels" });
    click("channel-empty-add");
    expect(probe.draft.problems).toEqual([]);
    await act(async () => { click("builder-save"); });
    expect(probe.saveDocument).toHaveBeenCalledTimes(1);
    expect(probe.saveDocument.mock.calls[0][2]).toMatchObject({ channels: [{ key: "channel", address: null }] });
  });
});

describe("ChannelsSection: nothing is lost, nothing empty is added", () => {
  it("a channel that uses every property keeps all of them when one is edited", () => {
    const doc = maximalDocument();
    const before = structuredClone(doc.channels[0]);
    const { probe } = renderSection(ChannelsSection, { doc });
    expect(probe.draft.problems).toEqual([]);
    type(field("Title"), "Order lifecycle");
    expect(probe.draft.doc.channels[0]).toEqual({ ...before, title: "Order lifecycle" });
    expect(probe.draft.problems).toEqual([]);
  });

  it("the parameters of that channel are drawn from its definitions", () => {
    renderSection(ChannelsSection, { doc: maximalDocument() });
    expect(box("channel-parameter-0-description").value).toBe("Region of the order");
    expect(box("channel-parameter-0-default").value).toBe("eu");
    expect(screen.getByTestId("channel-parameter-0-enum").closest("[data-testid='channel-parameter-0-enum-field']")?.textContent).toContain("eu");
  });

  it("a new channel with only the basics gives a valid document with no empty extras", () => {
    const { probe } = renderSection(ChannelsSection);
    click("channel-add");
    type(field("Address"), "audit.v1");
    expect(probe.draft.doc.channels[2]).toEqual({ key: "channel", address: "audit.v1", protocol: "kafka", serverKeys: [], messageKeys: [] });
    expect(parseEventDocument(probe.draft.doc).success).toBe(true);
    expect(probe.draft.problems).toEqual([]);
  });
});

describe("ChannelsSection: external references", () => {
  it("shows the card of external channels under the list, and also while there are no local channels", () => {
    renderSection(ChannelsSection);
    expect(text("external-refs-channel")).toContain("Channels from other events");
    expect(missing("external-refs-message")).toBe(true);
    cleanup();
    renderSection(ChannelsSection, { doc: emptyEventDocument("Empty") });
    expect(screen.getByTestId("channel-empty")).toBeDefined();
    expect(text("external-refs-empty")).toContain("Channels from other events");
  });

  it("lists the references of the document in the card and counts them with the channels in the outline", () => {
    const doc = sampleDocument();
    doc.externalRefs = [{ key: "billing-topic", eventVersionId: "vv1", kind: "channel", itemKey: "billing" }];
    renderBuilder({ doc, section: "channels" });
    expect(screen.getByTestId("external-ref-row-billing-topic")).toBeDefined();
    expect(text("outline-count-channels")).toBe("3");
  });

  it("offers the external messages among the messages a channel allows, marked, so an operation on the channel can use them", () => {
    const doc = sampleDocument();
    doc.externalRefs = [
      { key: "Order-placed", eventVersionId: "vv1", kind: "message", itemKey: "OrderPlaced" },
      { key: "billing-topic", eventVersionId: "vv1", kind: "channel", itemKey: "billing" },
    ];
    const { probe } = renderSection(ChannelsSection, { doc });
    const labelOf = (key: string) => box(`channel-messages-option-${key}`).closest("label")?.textContent;
    expect(labelOf("OrderCreated")).toBe("OrderCreated");
    expect(labelOf("Order-placed")).toBe("Order-placed (external)");
    expect(missing("channel-messages-option-billing-topic")).toBe(true);
    click("channel-messages-option-Order-placed");
    expect(probe.draft.doc.channels[0].messageKeys).toEqual(["OrderCreated", "Order-placed"]);
    expect(probe.draft.problems).toEqual([]);
    // An operation that uses it on this channel keeps it there, as for a local message.
    act(() => probe.draft.update((d) => ({ ...d, operations: [...d.operations, { key: "receivePlaced", action: "receive", channelKey: "orders", messageKeys: ["Order-placed"], traitKeys: [] }] })));
    click("channel-messages-option-Order-placed");
    expect(probe.draft.doc.channels[0].messageKeys).toEqual(["OrderCreated", "Order-placed"]);
    expect(text("channel-messages-blocked")).toContain('"receivePlaced"');
  });
});

describe("ChannelsSection: a new channel starts focused", () => {
  it("puts the cursor in the first field after Add", () => {
    renderSection(ChannelsSection, { doc: sampleDocument() });
    fireEvent.click(screen.getByTestId("channel-add"));
    expect(document.activeElement).toBe(field("Address"));
  });
});

describe("ChannelsSection: the item tab strip", () => {
  it("picks items from a tab strip with the add button pinned beside it, not in the header", () => {
    const { probe } = renderSection(ChannelsSection, { doc: sampleDocument() });
    const strip = screen.getByRole("tablist", { name: "Channels" });
    expect(within(strip).getAllByRole("tab").map((t) => t.getAttribute("data-testid"))).toEqual(["channel-row-orders", "channel-row-refunds"]);
    expect(screen.getByTestId("channel-row-orders").getAttribute("aria-current")).toBe("true");
    const add = screen.getByTestId("channel-add");
    expect(strip.contains(add)).toBe(false);
    expect(screen.getAllByRole("button", { name: "Add channel" })).toHaveLength(1);
    const before = probe.draft.doc.channels.length;
    fireEvent.click(add);
    expect(probe.draft.doc.channels).toHaveLength(before + 1);
    expect(probe.item).toBe(probe.draft.doc.channels[before].key);
  });

  it("keeps the section description in an info tip beside the heading", () => {
    renderSection(ChannelsSection, { doc: sampleDocument() });
    const tip = screen.getByTestId("channels-help");
    expect(tip.hasAttribute("hidden")).toBe(true);
    expect(tip.textContent).toContain("Topics and queues");
    expect(screen.getByTestId("channels-help-button").getAttribute("aria-label")).toBe("About channels");
  });

  it("puts what the list row used to show under its name in the tab's title", () => {
    renderSection(ChannelsSection, { doc: sampleDocument() });
    expect(screen.getByTestId("channel-row-orders").getAttribute("title")).toContain("kafka");
  });
});
