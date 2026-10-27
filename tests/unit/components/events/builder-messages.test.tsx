// @vitest-environment jsdom
import { act, cleanup, fireEvent, screen, within } from "@testing-library/react";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { SECTION_COMPONENTS } from "@/features/events/builder/EventBuilder";
import { MessagesSection } from "@/features/events/builder/sections/MessagesSection";
import type { SaveDocument } from "@/features/events/builder/use-event-draft";
import { resetPinSchemaCache } from "@/features/events/builder/use-pin-json-schema";
import type { EntityOption } from "@/features/events/shared/EntityPinPicker";
import { parseEventDocument } from "@/lib/events/document/parse";
import { emptyEventDocument, type EventDocument } from "@/lib/events/document/types";
import { bindingVersion, TEMPLATES } from "@/lib/events/templates";
import { maximalDocument } from "../../lib/events/document/fixtures/maximal-document";
import { ENTITY_OPTIONS, PIN, renderBuilder, renderSection, sampleDocument } from "./builder-harness";

// The picker's default version loader is a server action: keep it out of the test process.
const h = vi.hoisted(() => ({ listPinnableVersionsAction: vi.fn(), pinJsonSchemaAction: vi.fn(), toast: vi.fn(), toastDismiss: vi.fn() }));
// The undo toast of "Remove message": the tests read what it offers and press its action themselves.
vi.mock("sonner", () => ({ toast: Object.assign(h.toast, { dismiss: h.toastDismiss }) }));
vi.mock("@/features/events/pin-actions", () => ({ listPinnableVersionsAction: h.listPinnableVersionsAction }));
// So are the actions the external-reference card uses, and the one that renders an entity's schema (the payload preview asks for it).
vi.mock("@/app/(dashboard)/schemas/[domainSlug]/[productSlug]/event-actions", () => ({
  getExternalRefStatusesAction: () => Promise.resolve({ success: false, error: "unavailable" }),
  getExternalVersionItemsAction: () => Promise.resolve({ success: false, error: "unavailable" }),
  pinJsonSchemaAction: h.pinJsonSchemaAction,
}));

beforeEach(() => {
  vi.clearAllMocks();
  resetPinSchemaCache();
  h.listPinnableVersionsAction.mockResolvedValue({ success: true, data: [{ id: "ver-1", label: "1.0" }, { id: "ver-0", label: "0.9" }] });
  h.pinJsonSchemaAction.mockResolvedValue({ success: false, error: "unavailable", code: "UNAVAILABLE" });
  h.toast.mockImplementation(() => `toast-${h.toast.mock.calls.length}`);
});
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

/** The panes of the message form (a rail of tabs, one pane showing). */
const CARDS = ["payload", "properties", "details", "channels", "examples", "bindings", "docs", "correlation", "more"] as const;
type Card = (typeof CARDS)[number];
/** Is this the pane that is showing? */
const isOpen = (card: Card) => screen.getByTestId(`message-card-${card}-toggle`).getAttribute("aria-selected") === "true";
/** Show a pane, leaving it alone when it shows already. A pane, once shown, stays in the DOM (hidden) when another one shows. */
const openCard = (card: Card) => {
  if (!isOpen(card)) fireEvent.click(screen.getByTestId(`message-card-${card}-toggle`));
};
/** Show every pane in turn, so that all their fields are in the DOM. */
const openAllCards = () => CARDS.forEach(openCard);

/** The pickers are loaded lazily and fetch versions on mount: wait for both to settle before the test acts. */
async function settle() {
  await screen.findByLabelText("Payload entity");
  await act(async () => {});
}
/** Headers and Message key are `+ Add` links until set: show their pickers (a picker that is on screen already is left alone). */
const showOptionalPins = () => {
  for (const id of ["headers-add", "key-pin-add"]) if (screen.queryByTestId(id)) click(id);
};
async function renderMessages(opts: Parameters<typeof renderSection>[1] = {}) {
  const rendered = renderSection(MessagesSection, opts);
  await settle();
  return rendered;
}

/** sampleDocument without the explicit `format` its channels carry: a channel that follows its messages (Auto). */
function autoDocument(protocol = "kafka"): EventDocument {
  const doc = sampleDocument();
  for (const c of doc.channels) {
    delete c.format;
    c.protocol = protocol;
  }
  return doc;
}

/** The two sample entities, with the source formats the importers recorded for them. */
const entitiesWith = (formats: Record<string, EntityOption["sourceFormat"]>): EntityOption[] =>
  ENTITY_OPTIONS.map((e) => (formats[e.id] ? { ...e, sourceFormat: formats[e.id] } : e));

/** sampleDocument + a second message on `refunds` and an operation that replies on it. */
function docWithReply(): EventDocument {
  const doc = sampleDocument();
  doc.messages.push({ key: "RefundIssued", payload: { entityId: "ent-2", entityVersionId: "ver-2" }, traitKeys: [] });
  doc.channels[1].messageKeys = ["RefundIssued"];
  doc.operations.push({
    key: "askRefund", action: "send", channelKey: "orders", messageKeys: ["OrderCreated"], traitKeys: [],
    reply: { channelKey: "refunds", messageKeys: ["RefundIssued"] },
  });
  return doc;
}

/** autoDocument + one message trait, one operation trait and one library trait. */
function docWithTraits(): EventDocument {
  const doc = autoDocument();
  doc.traits = [
    { key: "Envelope", kind: "MESSAGE", spec: { title: "Envelope" } },
    { key: "Retry", kind: "OPERATION", spec: { title: "Retry" } },
    { key: "Standard", kind: "MESSAGE", libraryTraitId: "lib-1" },
  ];
  return doc;
}

it("the fixtures are valid documents, so any problem below comes from the edit under test", () => {
  for (const doc of [docWithReply(), autoDocument(), docWithTraits(), maximalDocument()]) expect(parseEventDocument(doc).success).toBe(true);
});

it("is registered as the messages section of the builder", () => {
  expect(SECTION_COMPONENTS.messages).toBe(MessagesSection);
});

describe("MessagesSection: list and selection", () => {
  it("lists messages by name, else title, else key, with the payload entity under it", async () => {
    const doc = docWithReply();
    doc.messages[0] = { ...doc.messages[0], name: "order.created", title: "Order created" };
    doc.messages[1] = { ...doc.messages[1], title: "Refund issued" };
    await renderMessages({ doc });
    const first = rowTitle("message-row-OrderCreated");
    expect(first).toContain("order.created");
    expect(first).not.toContain("Order created");
    expect(first).toContain("OrderCreated");
    const second = rowTitle("message-row-RefundIssued");
    expect(second).toContain("Refund issued");
    expect(second).toContain("OrderCancelled");
  });

  it("falls back to the key when a message has neither name nor title", async () => {
    await renderMessages({ doc: docWithReply() });
    expect(rowTitle("message-row-RefundIssued")).toContain("RefundIssued");
  });

  it("shows the first message's form and selects another on click", async () => {
    await renderMessages({ doc: docWithReply() });
    expect(screen.getByTestId("message-row-OrderCreated").getAttribute("aria-current")).toBe("true");
    expect(text("message-key-value")).toBe("OrderCreated");
    click("message-row-RefundIssued");
    expect(screen.getByTestId("message-row-RefundIssued").getAttribute("aria-current")).toBe("true");
    expect(screen.getByTestId("message-row-OrderCreated").hasAttribute("aria-current")).toBe(false);
    expect(text("message-key-value")).toBe("RefundIssued");
    expect((field("Payload entity") as unknown as HTMLSelectElement).value).toBe("ent-2");
  });

  it("opens the message named by the selected item and falls back to the first when it is gone", async () => {
    await renderMessages({ doc: docWithReply(), item: "RefundIssued" });
    expect(text("message-key-value")).toBe("RefundIssued");
    cleanup();
    await renderMessages({ doc: docWithReply(), item: "gone" });
    expect(text("message-key-value")).toBe("OrderCreated");
  });

  it("shows an empty state with the primary action when there are no messages", () => {
    const { probe } = renderSection(MessagesSection, { doc: emptyEventDocument("Orders") });
    const empty = screen.getByTestId("message-empty");
    expect(empty.textContent).toContain("No messages yet");
    expect(missing("message-add")).toBe(true);
    fireEvent.click(within(empty).getByRole("button", { name: "Add message" }));
    expect(probe.draft.doc.messages).toHaveLength(1);
    expect(missing("message-empty")).toBe(true);
  });
});

describe("MessagesSection: add message", () => {
  it("creates a message with a placeholder key, selects it and keeps adding unique placeholders", async () => {
    const { probe } = await renderMessages();
    click("message-add");
    expect(probe.draft.doc.messages.map((m) => m.key)).toEqual(["OrderCreated", "message"]);
    expect(probe.draft.doc.messages[1]).toEqual({ key: "message", payload: { entityId: "", entityVersionId: null }, traitKeys: [] });
    expect(probe.item).toBe("message");
    expect(text("message-key-value")).toBe("message");
    expect(probe.draft.dirty).toBe(true);
    click("message-add");
    expect(probe.draft.doc.messages.map((m) => m.key)).toEqual(["OrderCreated", "message", "message-2"]);
    expect(probe.item).toBe("message-2");
  });

  it("does not reuse the key of an external message reference", async () => {
    const doc = sampleDocument();
    doc.externalRefs = [{ key: "message", eventVersionId: "v1", kind: "message", itemKey: "remote" }];
    const { probe } = await renderMessages({ doc });
    click("message-add");
    expect(probe.draft.doc.messages[1].key).toBe("message-2");
  });

  it("asks for the payload entity: the new message has no payload yet and the picker shows why", async () => {
    await renderMessages();
    click("message-add");
    expect((field("Payload entity") as unknown as HTMLSelectElement).value).toBe("");
    expect(rowTitle("message-row-message")).toContain("No payload");
    const error = screen.getByTestId("payload-error");
    expect(error.textContent).toBe("entityId is required");
    expect(error.hasAttribute("role")).toBe(false);
    expect((screen.getByTestId("payload-group").getAttribute("aria-describedby") ?? "").split(" ")).toContain("payload-error");
  });

  it("a new message without a payload carries the required problem (the server rejects Save) until an entity is chosen", async () => {
    const { probe } = renderBuilder({ section: "messages" });
    await settle();
    click("message-add");
    expect(probe.draft.problems.map((p) => p.pointer)).toContain("/messages/1/payload/entityId");
    type(field("Payload entity"), "ent-1");
    expect(probe.draft.problems).toEqual([]);
    await act(async () => { click("builder-save"); });
    expect(probe.saveDocument).toHaveBeenCalledTimes(1);
  });
});

describe("MessagesSection: payload, headers and key pins", () => {
  it("picking another payload entity pins its latest version", async () => {
    const { probe } = await renderMessages();
    type(field("Payload entity"), "ent-2");
    expect(probe.draft.doc.messages[0].payload).toEqual({ entityId: "ent-2", entityVersionId: "ver-2" });
    expect(probe.draft.problems).toEqual([]);
  });

  it("choosing a first payload entity on a new message clears the payload error", async () => {
    const { probe } = await renderMessages();
    click("message-add");
    type(field("Payload entity"), "ent-1");
    expect(probe.draft.doc.messages[1].payload).toEqual({ entityId: "ent-1", entityVersionId: "ver-1" });
    expect(missing("payload-error")).toBe(true);
    expect(probe.draft.problems).toEqual([]);
  });

  it("an unpinned payload version is allowed: the entity stays, there is no problem, and Save works", async () => {
    const { probe } = renderBuilder({ section: "messages" });
    await settle();
    await screen.findByRole("option", { name: "v0.9" });
    type(field("Payload version"), "");
    expect(probe.draft.doc.messages[0].payload).toEqual({ entityId: "ent-1", entityVersionId: null });
    expect(probe.draft.problems).toEqual([]);
    expect(screen.getByText(/publishing is blocked/)).toBeDefined();
    await act(async () => { click("builder-save"); });
    expect(probe.saveDocument).toHaveBeenCalledTimes(1);
    expect(probe.saveDocument.mock.calls[0][2]).toMatchObject({ messages: [{ key: "OrderCreated", payload: { entityId: "ent-1", entityVersionId: null } }] });
  });

  it("keeps the picker's own newer-version hint", async () => {
    const doc = sampleDocument();
    doc.messages[0] = { ...doc.messages[0], payload: { entityId: "ent-1", entityVersionId: "ver-0" } };
    await renderMessages({ doc });
    expect(text("payload-newer")).toContain("Newer version available");
  });

  it("headers and key are optional pins: pick one, clear it, the property is removed", async () => {
    const { probe } = await renderMessages();
    expect("headers" in probe.draft.doc.messages[0]).toBe(false);
    showOptionalPins();
    type(field("Headers entity"), "ent-2");
    expect(probe.draft.doc.messages[0].headers).toEqual({ entityId: "ent-2", entityVersionId: "ver-2" });
    type(field("Message key entity"), "ent-1");
    expect(probe.draft.doc.messages[0].keyPin).toEqual({ entityId: "ent-1", entityVersionId: "ver-1" });
    expect(probe.draft.problems).toEqual([]);
    type(field("Headers entity"), "");
    type(field("Message key entity"), "");
    expect("headers" in probe.draft.doc.messages[0]).toBe(false);
    expect("keyPin" in probe.draft.doc.messages[0]).toBe(false);
    expect(probe.draft.doc.messages[0].payload).toEqual(PIN);
  });

  it("each pin edits only the selected message", async () => {
    const { probe } = await renderMessages({ doc: docWithReply(), item: "RefundIssued" });
    showOptionalPins();
    type(field("Headers entity"), "ent-1");
    expect(probe.draft.doc.messages[1].headers).toEqual({ entityId: "ent-1", entityVersionId: "ver-1" });
    expect("headers" in probe.draft.doc.messages[0]).toBe(false);
  });

  it("shows a server-side pin problem under the picker and keeps the edit", async () => {
    const saveDocument = vi.fn<SaveDocument>().mockResolvedValue({
      success: false, error: "1 unknown or invalid item", code: "VALIDATION_ERROR",
      details: { problems: [{ pointer: "/messages/0/payload/entityVersionId", message: '"ver-9" is not a published version of OrderCreated' }] },
    });
    const { probe } = renderBuilder({ saveDocument, section: "messages" });
    await settle();
    type(field("Title"), "Changed");
    await act(async () => { click("builder-save"); });
    expect(text("payload-error")).toBe('"ver-9" is not a published version of OrderCreated');
    expect(field("Title").value).toBe("Changed");
    expect(probe.draft.dirty).toBe(true);
  });
});

describe("MessagesSection: a new message starts focused", () => {
  it("puts the cursor in the Payload entity select after Add, even from another pane", async () => {
    await renderMessages();
    openCard("examples");
    click("message-add");
    expect(isOpen("payload")).toBe(true);
    await screen.findByLabelText("Payload entity");
    expect(document.activeElement).toBe(field("Payload entity"));
  });

  it("does not take the cursor back when the user returns to a message that was added earlier", async () => {
    await renderMessages();
    click("message-add");
    await screen.findByLabelText("Payload entity");
    click("message-row-OrderCreated");
    (document.activeElement as HTMLElement | null)?.blur();
    click("message-row-message");
    await screen.findByLabelText("Payload entity");
    expect(document.activeElement).not.toBe(field("Payload entity"));
  });
});

describe("MessagesSection: the payload request while passing over messages", () => {
  const sleep = (ms: number) => new Promise<void>((resolve) => { setTimeout(resolve, ms); });

  it("sends nothing while the user is only passing over a message, and asks once for the one they stop on", async () => {
    h.pinJsonSchemaAction.mockResolvedValue({ success: true, data: { schema: { properties: { id: { type: "string" } } } } });
    await renderMessages({ doc: docWithReply() });
    click("message-row-RefundIssued");
    click("message-row-OrderCreated");
    click("message-row-RefundIssued");
    await act(async () => { await sleep(100); });
    expect(h.pinJsonSchemaAction).not.toHaveBeenCalled();
    await act(async () => { await sleep(600); });
    expect(h.pinJsonSchemaAction).toHaveBeenCalledTimes(1);
    expect(h.pinJsonSchemaAction).toHaveBeenCalledWith("p1", { entityId: "ent-2", entityVersionId: "ver-2" });
  });

  it("still asks at once for the examples, which the user asked for by opening them", async () => {
    const doc = sampleDocument();
    doc.messages[0] = { ...doc.messages[0], examples: [{ payload: { id: 1 } }] };
    await renderMessages({ doc });
    openCard("examples");
    await act(async () => { await sleep(50); });
    expect(h.pinJsonSchemaAction).toHaveBeenCalledWith("p1", PIN);
  });
});

describe("MessagesSection: payload preview", () => {
  const ORDER_SCHEMA = { type: "object", properties: { orderId: { type: "string" }, quantity: { type: "integer" } }, required: ["orderId"] };

  it("shows the fields of the chosen payload entity under the picker, with a link to the entity", async () => {
    h.pinJsonSchemaAction.mockResolvedValue({ success: true, data: { schema: ORDER_SCHEMA } });
    await renderMessages();
    await screen.findByTestId("payload-preview-required-orderId");
    const preview = screen.getByTestId("payload-preview");
    expect(within(preview).getByText("quantity")).toBeDefined();
    expect(within(preview).getByRole("link", { name: /open entity/i }).getAttribute("href")).toBe("/schemas/payments/checkout/ordercreated");
    expect(h.pinJsonSchemaAction).toHaveBeenCalledWith("p1", PIN);
  });

  it("follows the entity: choosing another payload shows that entity's fields", async () => {
    h.pinJsonSchemaAction.mockImplementation((_product: string, pin: { entityId: string }) =>
      Promise.resolve({ success: true, data: { schema: { properties: pin.entityId === "ent-1" ? { orderId: { type: "string" } } : { reason: { type: "string" } } } } }));
    await renderMessages();
    await screen.findByText("orderId");
    type(field("Payload entity"), "ent-2");
    await screen.findByText("reason");
    expect(screen.queryByText("orderId")).toBeNull();
  });

  it("asks for the schema only once the Payload pane shows", async () => {
    const doc = sampleDocument();
    doc.messages[0] = { ...doc.messages[0], externalDocs: { url: "not a url" } };
    await renderMessages({ doc });
    expect(isOpen("docs")).toBe(true);
    expect(h.pinJsonSchemaAction).not.toHaveBeenCalled();
    openCard("payload");
    await act(async () => { await new Promise<void>((resolve) => { setTimeout(resolve, 500); }); });
    expect(h.pinJsonSchemaAction).toHaveBeenCalledWith("p1", PIN);
  });

  it("shows no preview for a message that has no payload entity yet", async () => {
    await renderMessages();
    click("message-add");
    expect(missing("payload-preview")).toBe(true);
  });
});

describe("MessagesSection: optional pins", () => {
  it("shows Headers and Message key as add links until they are set", async () => {
    await renderMessages();
    expect(text("headers-add")).toBe("+ Add headers");
    expect(text("key-pin-add")).toBe("+ Add message key");
    expect(missing("headers-picker")).toBe(true);
    expect(missing("key-pin-picker")).toBe(true);
    expect(screen.queryByLabelText("Headers entity")).toBeNull();
  });

  it("shows the picker when its link is clicked, and the link is gone", async () => {
    await renderMessages();
    click("headers-add");
    expect(screen.getByLabelText("Headers entity")).toBeDefined();
    expect(missing("headers-add")).toBe(true);
    expect(missing("key-pin-picker")).toBe(true);
  });

  it("shows the picker at once for a message that has headers or a key", async () => {
    const doc = sampleDocument();
    doc.messages[0] = { ...doc.messages[0], headers: { entityId: "ent-2", entityVersionId: "ver-2" } };
    await renderMessages({ doc });
    expect(screen.getByLabelText("Headers entity")).toBeDefined();
    expect(missing("headers-add")).toBe(true);
    expect(text("key-pin-add")).toBe("+ Add message key");
  });

  it("shows a pin that holds a problem without a click", async () => {
    const saveDocument = vi.fn<SaveDocument>().mockResolvedValue({
      success: false, error: "1 unknown or invalid item", code: "VALIDATION_ERROR",
      details: { problems: [{ pointer: "/messages/0/keyPin/entityVersionId", message: '"ver-9" is not a published version of OrderCreated' }] },
    });
    const { probe } = renderBuilder({ saveDocument, section: "messages" });
    await settle();
    type(field("Title"), "Changed");
    await act(async () => { click("builder-save"); });
    expect(text("key-pin-error")).toBe('"ver-9" is not a published version of OrderCreated');
    expect(screen.getByLabelText("Message key entity")).toBeDefined();
    expect(probe.draft.dirty).toBe(true);
  });

  it("keeps the picker on screen after the entity is cleared again, until the message changes", async () => {
    await renderMessages();
    click("headers-add");
    type(field("Headers entity"), "ent-2");
    type(field("Headers entity"), "");
    expect(screen.getByLabelText("Headers entity")).toBeDefined();
  });

  it("puts the representation select in one row with the payload picker", async () => {
    await renderMessages();
    const row = screen.getByTestId("payload-row");
    expect(within(row).getByTestId("payload-picker")).toBeDefined();
    expect(within(row).getByTestId("message-representation")).toBeDefined();
    expect(within(row).queryByTestId("headers-add")).toBeNull();
  });
});

describe("MessagesSection: payload representation", () => {
  it("is one select: Auto (recommended), Avro, JSON Schema, Protobuf, with Auto chosen when nothing is set", async () => {
    await renderMessages();
    const representation = field("Payload representation") as unknown as HTMLSelectElement;
    expect(representation).toBe(select("message-representation"));
    expect(optionValues(representation)).toEqual(["", "avro", "json-schema", "protobuf"]);
    expect(Array.from(representation.querySelectorAll("option")).map((o) => o.textContent)).toEqual(["Auto (recommended)", "Avro", "JSON Schema", "Protobuf"]);
    expect(representation.value).toBe("");
  });

  it("choosing a representation writes `representation`; Auto removes it", async () => {
    const { probe } = await renderMessages();
    for (const format of ["avro", "json-schema", "protobuf"] as const) {
      type(select("message-representation"), format);
      expect(probe.draft.doc.messages[0].representation).toBe(format);
      expect(select("message-representation").value).toBe(format);
    }
    expect(probe.draft.problems).toEqual([]);
    type(select("message-representation"), "");
    expect("representation" in probe.draft.doc.messages[0]).toBe(false);
    expect(select("message-representation").value).toBe("");
  });

  it("shows what the message already has, and edits only the selected message", async () => {
    const doc = docWithReply();
    doc.messages[1] = { ...doc.messages[1], representation: "protobuf" };
    const { probe } = await renderMessages({ doc, item: "RefundIssued" });
    expect(select("message-representation").value).toBe("protobuf");
    type(select("message-representation"), "avro");
    expect(probe.draft.doc.messages[1].representation).toBe("avro");
    expect("representation" in probe.draft.doc.messages[0]).toBe(false);
  });

  it("never touches the channels' formats, and a message that stays on Auto never gains the property", async () => {
    const { probe } = await renderMessages();
    type(select("message-representation"), "protobuf");
    expect(probe.draft.doc.channels.map((c) => c.format)).toEqual(["avro", "avro"]);
    cleanup();
    const second = await renderMessages();
    type(field("Title"), "Order created");
    type(box("message-name"), "order.created");
    expect("representation" in second.probe.draft.doc.messages[0]).toBe(false);
  });

  describe("the explanation under the select", () => {
    it("is always visible and linked to the select", async () => {
      await renderMessages({ doc: autoDocument() });
      const note = screen.getByTestId("message-representation-explanation");
      expect(note.textContent).toBeTruthy();
      expect((select("message-representation").getAttribute("aria-describedby") ?? "").split(" ")).toContain(note.id);
    });

    it("Auto, entity imported from Avro, on a Pub/Sub channel: Auto → Avro, because of the entity", async () => {
      await renderMessages({ doc: autoDocument("googlepubsub"), options: { entityOptions: entitiesWith({ "ent-1": "avro" }), libraryTraits: [] } });
      expect(text("message-representation-explanation")).toBe("Auto → Avro — the entity OrderCreated was imported from Avro");
    });

    it("Auto, no recorded source format, on a Kafka channel: Auto → Avro, because Kafka defaults to Avro", async () => {
      await renderMessages({ doc: autoDocument("kafka") });
      const note = text("message-representation-explanation") ?? "";
      expect(note).toBe("Auto → Avro — Kafka channels default to Avro");
      expect(note).toMatch(/^Auto → Avro — Kafka/);
    });

    it("Auto, no recorded source format, on any other protocol: Auto → JSON Schema", async () => {
      await renderMessages({ doc: autoDocument("amqp") });
      const note = text("message-representation-explanation") ?? "";
      expect(note).toContain("Auto → JSON Schema");
      expect(note).toBe("Auto → JSON Schema (draft-07) — AMQP channels default to JSON Schema");
    });

    it("an explicit choice is stated as chosen on the message", async () => {
      await renderMessages({ doc: autoDocument("kafka") });
      type(select("message-representation"), "json-schema");
      expect(text("message-representation-explanation")).toBe("Chosen on this message: JSON Schema (draft-07)");
      type(select("message-representation"), "protobuf");
      expect(text("message-representation-explanation")).toBe("Chosen on this message: Protobuf");
      type(select("message-representation"), "");
      expect(text("message-representation-explanation")).toBe("Auto → Avro — Kafka channels default to Avro");
    });

    it("a message that already has an explicit representation shows it on first render", async () => {
      const doc = autoDocument();
      doc.messages[0] = { ...doc.messages[0], representation: "avro" };
      await renderMessages({ doc });
      expect(text("message-representation-explanation")).toBe("Chosen on this message: Avro");
    });

    it("no payload entity yet: a neutral hint, no guess", async () => {
      await renderMessages({ doc: autoDocument() });
      click("message-add");
      const note = text("message-representation-explanation") ?? "";
      expect(note).toMatch(/payload entity/i);
      expect(note).not.toContain("→");
    });

    it("follows the payload entity as soon as another one is chosen (never a stale answer)", async () => {
      await renderMessages({ doc: autoDocument("googlepubsub"), options: { entityOptions: entitiesWith({ "ent-2": "protobuf" }), libraryTraits: [] } });
      expect(text("message-representation-explanation")).toBe("Auto → JSON Schema (draft-07) — Google Pub/Sub channels default to JSON Schema");
      type(field("Payload entity"), "ent-2");
      expect(text("message-representation-explanation")).toBe("Auto → Protobuf — the entity OrderCancelled was imported from Protobuf");
      type(field("Payload entity"), "ent-1");
      expect(text("message-representation-explanation")).toBe("Auto → JSON Schema (draft-07) — Google Pub/Sub channels default to JSON Schema");
    });

    it("follows the channels the message is sent on", async () => {
      const doc = autoDocument("kafka");
      doc.channels[1] = { ...doc.channels[1], protocol: "amqp" };
      doc.messages.push({ key: "Loose", payload: PIN, traitKeys: [] });
      await renderMessages({ doc, item: "Loose" });
      expect(text("message-representation-explanation")).toContain("no channel carries this message yet");
      fireEvent.click(box("message-channels-option-refunds"));
      expect(text("message-representation-explanation")).toBe("Auto → JSON Schema (draft-07) — AMQP channels default to JSON Schema");
    });

    it("says so when the channel overrides the format for every message", async () => {
      const doc = autoDocument();
      doc.channels[0] = { ...doc.channels[0], format: "protobuf" };
      await renderMessages({ doc });
      expect(text("message-representation-explanation")).toBe("Auto → Protobuf — set by channel orders");
    });

    it("shows a server problem at the representation under the select", async () => {
      const saveDocument = vi.fn<SaveDocument>().mockResolvedValue({
        success: false, error: "1 problem(s) in the event document", code: "VALIDATION_ERROR",
        details: { problems: [{ pointer: "/messages/0/representation", message: "representation must be one of avro, json-schema, protobuf" }] },
      });
      renderBuilder({ saveDocument, section: "messages" });
      await settle();
      type(field("Title"), "Changed");
      await act(async () => { click("builder-save"); });
      expect(text("message-representation-error")).toBe("representation must be one of avro, json-schema, protobuf");
      expect(select("message-representation").getAttribute("aria-invalid")).toBe("true");
    });
  });
});

describe("MessagesSection: AsyncAPI message properties", () => {
  it("edits name, title, summary, description and content type and removes them when blanked", async () => {
    const { probe } = await renderMessages();
    type(box("message-name"), "order.created");
    type(box("message-title"), "Order created");
    type(box("message-summary"), "Fired when an order is placed");
    type(box("message-description"), "Longer text");
    type(box("message-contentType"), "application/avro");
    expect(probe.draft.doc.messages[0]).toMatchObject({
      name: "order.created", title: "Order created", summary: "Fired when an order is placed", description: "Longer text", contentType: "application/avro",
    });
    for (const id of ["name", "title", "summary", "description", "contentType"]) type(box(`message-${id}`), "");
    for (const k of ["name", "title", "summary", "description", "contentType"]) expect(k in probe.draft.doc.messages[0]).toBe(false);
    expect(probe.draft.problems).toEqual([]);
  });

  it("hints the inherited default content type, and suggests the usual ones", async () => {
    await renderMessages({ doc: { ...sampleDocument(), defaultContentType: "application/json" } });
    expect(box("message-contentType").getAttribute("placeholder")).toContain("application/json");
    const options = Array.from(document.getElementById(box("message-contentType").getAttribute("list") as string)?.querySelectorAll("option") ?? []).map((o) => o.getAttribute("value"));
    expect(options).toContain("application/json");
  });

  it("editing the title never rewrites a key that is no placeholder", async () => {
    const { probe } = await renderMessages();
    type(field("Title"), "An order was created");
    fireEvent.blur(field("Title"));
    expect(probe.draft.doc.messages[0].title).toBe("An order was created");
    expect(probe.draft.doc.messages[0].key).toBe("OrderCreated");
    expect(probe.draft.doc.channels[0].messageKeys).toEqual(["OrderCreated"]);
    expect(probe.draft.doc.operations[0].messageKeys).toEqual(["OrderCreated"]);
  });

  it("writes a correlation id (where to find it, and a description) and removes it when emptied", async () => {
    const { probe } = await renderMessages();
    openCard("correlation");
    type(box("message-correlationId-location"), "$message.header#/correlationId");
    expect(probe.draft.doc.messages[0].correlationId).toEqual({ location: "$message.header#/correlationId" });
    type(box("message-correlationId-description"), "Ties a reply to its request");
    expect(probe.draft.doc.messages[0].correlationId).toEqual({ location: "$message.header#/correlationId", description: "Ties a reply to its request" });
    expect(probe.draft.problems).toEqual([]);
    type(box("message-correlationId-location"), "");
    type(box("message-correlationId-description"), "");
    expect("correlationId" in probe.draft.doc.messages[0]).toBe(false);
  });

  it("an invalid correlation id location is reported under its field", async () => {
    await renderMessages();
    openCard("correlation");
    type(box("message-correlationId-location"), "correlationId");
    expect(text("message-correlationId-location-error")).toBeTruthy();
    expect(box("message-correlationId-location").getAttribute("aria-invalid")).toBe("true");
  });

  it("adds, edits and removes examples", async () => {
    const { probe } = await renderMessages();
    openCard("examples");
    click("message-examples-add");
    type(box("message-examples-0-name"), "small");
    type(box("message-examples-0-payload"), '{"id":"o-1"}');
    expect(probe.draft.doc.messages[0].examples).toEqual([{ name: "small", payload: { id: "o-1" } }]);
    expect(probe.draft.problems).toEqual([]);
    click("message-examples-add");
    expect(screen.getAllByTestId(/^message-examples-\d+$/)).toHaveLength(2);
    fireEvent.click(screen.getByTestId("message-examples-1-remove"));
    fireEvent.click(screen.getByTestId("message-examples-0-remove"));
    expect("examples" in probe.draft.doc.messages[0]).toBe(false);
  });

  it("starts on the Payload pane, and holds examples, bindings, docs & tags, the correlation id and 'More' back until they are shown", async () => {
    await renderMessages({ doc: docWithTraits() });
    expect(isOpen("payload")).toBe(true);
    for (const card of ["properties", "details", "channels", "examples", "bindings", "docs", "correlation", "more"] as const) expect(isOpen(card), card).toBe(false);
    for (const card of ["examples", "bindings", "docs", "correlation", "more"] as const) expect(missing(`message-card-${card}-body`), card).toBe(true);
    for (const key of ["examples", "tags", "externalDocs", "deprecated", "correlationId"]) expect(missing(`message-${key}`) && missing(`message-${key}-location`), key).toBe(true);
    expect(missing("message-bindings")).toBe(true);
    // The old 'More properties' toggle of the template form is gone: the cards are the grouping.
    expect(missing("message-more-toggle")).toBe(true);
  });

  it("writes tags and external documentation, and removes them when emptied", async () => {
    const { probe } = await renderMessages();
    openCard("docs");
    type(box("message-externalDocs-url"), "https://example.com/order-created");
    type(box("message-tags"), "orders");
    fireEvent.keyDown(box("message-tags"), { key: "Enter" });
    expect(probe.draft.doc.messages[0]).toMatchObject({ externalDocs: { url: "https://example.com/order-created" }, tags: [{ name: "orders" }] });
    expect(probe.draft.problems).toEqual([]);
    type(box("message-externalDocs-url"), "");
    fireEvent.click(screen.getByTestId("message-tags-chip-0-remove"));
    expect("externalDocs" in probe.draft.doc.messages[0]).toBe(false);
    expect("tags" in probe.draft.doc.messages[0]).toBe(false);
  });

  it("deprecated is Not set / Yes / No: Yes and No are values, Not set removes the property", async () => {
    const { probe } = await renderMessages();
    openCard("more");
    type(select("message-deprecated"), "true");
    expect(probe.draft.doc.messages[0].deprecated).toBe(true);
    type(select("message-deprecated"), "false");
    expect(probe.draft.doc.messages[0].deprecated).toBe(false);
    type(select("message-deprecated"), "");
    expect("deprecated" in probe.draft.doc.messages[0]).toBe(false);
  });

  it("the traits multi-reference is gone: the Message properties card draws them instead, and keeps the message's traitKeys", async () => {
    const doc = docWithTraits();
    doc.messages[0] = { ...doc.messages[0], traitKeys: ["Envelope"] };
    const { probe } = await renderMessages({ doc });
    expect(missing("message-traits")).toBe(true);
    expect(screen.queryAllByTestId(/^message-traits-option-/)).toHaveLength(0);
    expect(screen.getByTestId("message-prop-row-Envelope")).toBeDefined();
    // Editing another field never loses or reorders the applied sets.
    type(field("Title"), "Order created");
    expect(probe.draft.doc.messages[0].traitKeys).toEqual(["Envelope"]);
  });

  it("every property of the message template is reachable, including inside the collapsed cards", async () => {
    await renderMessages({ doc: docWithTraits() });
    openAllCards();
    showOptionalPins();
    const keys = TEMPLATES.message.fields.map((f) => f.key);
    expect(keys).toEqual([
      "name", "title", "summary", "description", "contentType", "payload", "headers", "keyPin", "correlationId", "examples", "tags", "externalDocs",
      "deprecated", "bindings", "traits",
    ]);
    // The entity pins, the bindings and the traits are drawn by hand; everything else comes from the template form.
    const testIdOf: Record<string, string> = {
      payload: "payload-group", headers: "headers-group", keyPin: "key-pin-group", bindings: "message-bindings", traits: "message-props",
      correlationId: "message-correlationId",
    };
    for (const key of keys) expect(missing(testIdOf[key] ?? `message-${key}`), `message.${key}`).toBe(false);
  });
});

describe("MessagesSection: pane rail", () => {
  it("lists the panes in the order Payload, Message properties (Trait), Details, Sent on channels, Examples, Bindings, Docs & tags, Correlation id, More", async () => {
    await renderMessages();
    const titles = within(screen.getByRole("tablist", { name: "Message parts" })).getAllByRole("tab").map((t) => t.textContent?.replace(/\d+\s*set$/, "").trim());
    expect(titles).toEqual([
      "Payload", "Message properties (Trait)", "Details", "Sent on channels", "Examples", "Bindings", "Docs & tags", "Correlation id", "More",
    ]);
  });

  it("shows a pane from its tab, with aria-selected and aria-controls, and hides the one it replaces", async () => {
    await renderMessages();
    const toggle = screen.getByTestId("message-card-examples-toggle");
    expect(toggle.getAttribute("aria-selected")).toBe("false");
    expect(missing("message-card-examples-body")).toBe(true);
    fireEvent.click(toggle);
    expect(toggle.getAttribute("aria-selected")).toBe("true");
    expect(toggle.getAttribute("aria-controls")).toBe(screen.getByTestId("message-card-examples-body").id);
    expect(screen.getByTestId("message-card-examples-body").hasAttribute("hidden")).toBe(false);
    expect(screen.getByTestId("message-card-payload-body").hasAttribute("hidden")).toBe(true);
  });

  it("counts the fields set in each card: examples, bindings (protocols), docs & tags, correlation id, deprecated, details and channels", async () => {
    await renderMessages({ doc: maximalDocument() });
    const count = (card: Card) => screen.queryByTestId(`message-card-${card}-count`)?.textContent ?? null;
    const m = maximalDocument().messages[0];
    expect(count("examples")).toBe(String(m.examples?.length));
    expect(count("bindings")).toBe(String(Object.keys(m.bindings ?? {}).length));
    expect(count("docs")).toBe(String((m.tags?.length ?? 0) + (m.externalDocs ? 1 : 0)));
    expect(count("correlation")).toBe("1");
    expect(count("more")).toBe(m.deprecated === undefined ? null : "1");
    expect(Number(count("details"))).toBeGreaterThan(0);
    expect(count("properties")).toBe(m.traitKeys.length > 0 ? String(m.traitKeys.length) : null);
  });

  it("shows no count on a card with nothing set", async () => {
    await renderMessages();
    for (const card of ["examples", "bindings", "docs", "correlation", "more"] as const) expect(missing(`message-card-${card}-count`), card).toBe(true);
    expect(text("message-card-channels-count")).toBe("1");
  });

  it("gives the count an accessible name through the heading button", async () => {
    const doc = sampleDocument();
    doc.messages[0] = { ...doc.messages[0], tags: [{ name: "a" }, { name: "b" }] };
    await renderMessages({ doc });
    expect(screen.getByTestId("message-card-docs-toggle").textContent).toContain("2 set");
    expect(screen.getByTestId("message-card-docs-count").textContent).toBe("2");
  });

  it("keeps the pane that shows while switching to another message, and while switching back", async () => {
    await renderMessages({ doc: docWithReply() });
    openCard("examples");
    click("message-row-RefundIssued");
    expect(isOpen("examples")).toBe(true);
    expect(isOpen("details")).toBe(false);
    click("message-row-OrderCreated");
    expect(isOpen("examples")).toBe(true);
    expect(isOpen("details")).toBe(false);
  });

  it("lets the user leave a pane that holds a problem, and does not pull the user back to it", async () => {
    await renderMessages();
    openCard("docs");
    type(box("message-externalDocs-url"), "not a url");
    expect(text("message-externalDocs-url-error")).toBeTruthy();
    openCard("payload");
    expect(isOpen("payload")).toBe(true);
    type(field("Payload version"), "");
    expect(isOpen("payload")).toBe(true);
    expect(screen.getByTestId("message-card-docs-toggle").textContent).toContain("has problems");
  });

  it("shows a pane by itself when a failed save reports a problem inside it", async () => {
    const saveDocument = vi.fn<SaveDocument>().mockResolvedValue({
      success: false, error: "1 problem(s) in the event document", code: "VALIDATION_ERROR",
      details: { problems: [{ pointer: "/messages/0/examples/0/payload", message: "payload is not valid" }] },
    });
    renderBuilder({ saveDocument, section: "messages" });
    await settle();
    expect(isOpen("examples")).toBe(false);
    type(field("Title"), "Changed");
    await act(async () => { click("builder-save"); });
    expect(isOpen("examples")).toBe(true);
  });

  it("opens the Payload card on a problem even after the user collapsed it", async () => {
    const doc = sampleDocument();
    doc.messages[0] = { ...doc.messages[0], payload: { entityId: "", entityVersionId: null } };
    await renderMessages({ doc });
    expect(isOpen("payload")).toBe(true);
    expect(text("payload-error")).toBe("entityId is required");
  });

  it("shows the optional-field help as an info tooltip (a button with an aria-label and aria-describedby) and keeps required-field help inline", async () => {
    await renderMessages();
    const button = screen.getByTestId("message-description-hint-button");
    expect(button.getAttribute("aria-label")).toBe("About Description");
    expect(button.getAttribute("aria-describedby")).toBe("message-description-hint");
    expect(document.getElementById("message-description-hint")?.getAttribute("role")).toBe("tooltip");
    expect(text("message-description-hint")).toContain("What the message means");
    // the required Payload help is a plain line under the picker
    expect(screen.getByText("Required. The entity this message carries.")).toBeDefined();
  });
});

describe("MessagesSection: Sent on channels pane", () => {
  it("lists the channels and counts the ones the message is on", async () => {
    await renderMessages();
    openCard("channels");
    expect(screen.getByTestId("message-channels-option-orders")).toBeDefined();
    expect(text("message-card-channels-count")).toBe("1");
  });
});

describe("MessagesSection: the sent-on summary", () => {
  it("names the channels the message is on, and a chip shows the Sent on channels pane", async () => {
    await renderMessages();
    expect(text("message-sent-on")).toContain("orders.v1");
    expect(missing("message-sent-on-choose")).toBe(true);
    expect(isOpen("channels")).toBe(false);
    click("message-sent-on-chip-orders");
    expect(isOpen("channels")).toBe(true);
  });

  it("says so when the message is on no channel, and offers to choose one", async () => {
    const doc = docWithReply();
    doc.channels[1].messageKeys = [];
    await renderMessages({ doc, item: "RefundIssued" });
    expect(text("message-sent-on")).toContain("Not sent on any channel");
    click("message-sent-on-choose");
    expect(isOpen("channels")).toBe(true);
  });

  it("follows the message: another message shows its own channels", async () => {
    await renderMessages({ doc: docWithReply() });
    expect(text("message-sent-on")).toContain("orders.v1");
    click("message-row-RefundIssued");
    expect(text("message-sent-on")).toContain("refunds.v1");
    expect(text("message-sent-on")).not.toContain("orders.v1");
  });
});

describe("MessagesSection: protocol bindings", () => {
  it("preselects the protocol of the first channel that carries the message, writes the template's fields with bindingVersion and drops `bindings` when cleared", async () => {
    const { probe } = await renderMessages();
    openCard("bindings");
    expect(select("message-bindings-protocol").value).toBe("kafka");
    click("message-bindings-add");
    type(select("message-bindings-kafka-schemaIdLocation"), "payload");
    expect(probe.draft.doc.messages[0].bindings).toEqual({ kafka: { schemaIdLocation: "payload", bindingVersion: bindingVersion("kafka", "message") } });
    expect(probe.draft.problems).toEqual([]);
    type(select("message-bindings-kafka-schemaIdLocation"), "");
    expect("bindings" in probe.draft.doc.messages[0]).toBe(false);
  });

  it("suggests the protocol of the channel that carries the message, not another channel's", async () => {
    const doc = sampleDocument();
    doc.channels[0] = { ...doc.channels[0], protocol: "amqp" };
    await renderMessages({ doc });
    openCard("bindings");
    expect(select("message-bindings-protocol").value).toBe("amqp");
  });

  it("suggests nothing for a message no channel carries yet", async () => {
    const doc = sampleDocument();
    doc.channels[0] = { ...doc.channels[0], messageKeys: [] };
    doc.operations = [];
    await renderMessages({ doc });
    openCard("bindings");
    expect(select("message-bindings-protocol").value).toBe("");
  });

  it("keeps the bindings a message already has when something else is edited", async () => {
    const doc = sampleDocument();
    doc.messages[0] = { ...doc.messages[0], bindings: { kafka: { schemaIdLocation: "header", bindingVersion: "0.5.0" } } };
    const { probe } = await renderMessages({ doc });
    type(field("Title"), "Order created");
    expect(probe.draft.doc.messages[0].bindings).toEqual({ kafka: { schemaIdLocation: "header", bindingVersion: "0.5.0" } });
    openCard("bindings");
    expect(select("message-bindings-kafka-schemaIdLocation").value).toBe("header");
  });
});

describe("MessagesSection: generated key", () => {
  it("starts with a placeholder, names the key from the name once the user leaves the form, and keeps the message selected", async () => {
    const { probe } = await renderMessages();
    click("message-add");
    type(box("message-name"), "order.refunded");
    expect(probe.draft.doc.messages[1].key).toBe("message");
    fireEvent.blur(box("message-name"));
    expect(probe.draft.doc.messages[1].key).toBe("order.refunded");
    expect(probe.item).toBe("order.refunded");
    expect(screen.getByTestId("message-row-order.refunded").getAttribute("aria-current")).toBe("true");
    expect(text("message-key-value")).toBe("order.refunded");
    expect(probe.draft.problems.filter((p) => p.pointer === "/messages/1/key")).toEqual([]);
  });

  it("falls back to the title when there is no name", async () => {
    const { probe } = await renderMessages();
    click("message-add");
    type(box("message-title"), "Order refunded");
    fireEvent.blur(box("message-title"));
    expect(probe.draft.doc.messages[1].key).toBe("Order-refunded");
  });

  it("the name wins over the title whichever was typed first, because the key waits while focus moves inside the form", async () => {
    const { probe } = await renderMessages();
    click("message-add");
    type(box("message-title"), "Order refunded");
    fireEvent.blur(box("message-title"), { relatedTarget: box("message-name") });
    expect(probe.draft.doc.messages[1].key).toBe("message");
    type(box("message-name"), "order.refunded");
    fireEvent.blur(box("message-name"));
    expect(probe.draft.doc.messages[1].key).toBe("order.refunded");
  });

  it("keeps the placeholder while there is nothing to name it by, and renames only once", async () => {
    const { probe } = await renderMessages();
    click("message-add");
    fireEvent.blur(box("message-summary"));
    expect(probe.draft.doc.messages[1].key).toBe("message");
    type(box("message-name"), "first.name");
    fireEvent.blur(box("message-name"));
    type(box("message-name"), "second.name");
    fireEvent.blur(box("message-name"));
    expect(probe.draft.doc.messages[1].key).toBe("first.name");
  });

  it("two messages with the same name get distinct keys", async () => {
    const { probe } = await renderMessages();
    click("message-add");
    type(box("message-name"), "order.refunded");
    fireEvent.blur(box("message-name"));
    click("message-add");
    type(box("message-name"), "order.refunded");
    fireEvent.blur(box("message-name"));
    expect(probe.draft.doc.messages.map((m) => m.key)).toEqual(["OrderCreated", "order.refunded", "order.refunded-2"]);
  });

  it("the automatic rename rewrites the channels and operations that already use the message", async () => {
    const doc = sampleDocument();
    doc.messages = [{ key: "message", payload: PIN, traitKeys: [] }];
    doc.channels[0].messageKeys = ["message"];
    doc.operations[0].messageKeys = ["message"];
    const { probe } = await renderMessages({ doc });
    type(box("message-name"), "order.placed");
    fireEvent.blur(box("message-name"));
    expect(probe.draft.doc.messages[0].key).toBe("order.placed");
    expect(probe.draft.doc.channels[0].messageKeys).toEqual(["order.placed"]);
    expect(probe.draft.doc.operations[0].messageKeys).toEqual(["order.placed"]);
    expect(probe.draft.problems).toEqual([]);
  });

  it("a message with a real key is never renamed by what is typed", async () => {
    const { probe } = await renderMessages();
    type(box("message-name"), "something.else");
    fireEvent.blur(box("message-name"));
    expect(probe.draft.doc.messages[0].key).toBe("OrderCreated");
  });

  it("the Identifier shows the key, collapsed", async () => {
    await renderMessages();
    expect((screen.getByTestId("message-key-disclosure") as HTMLDetailsElement).open).toBe(false);
    expect(box("message-key").value).toBe("OrderCreated");
  });

  it("renaming through the Identifier rewrites channel and operation references, keeps the message selected and the document valid", async () => {
    const { probe } = await renderMessages({ doc: docWithReply(), item: "RefundIssued" });
    type(box("message-key"), "RefundCompleted");
    fireEvent.blur(box("message-key"));
    expect(probe.draft.doc.messages[1].key).toBe("RefundCompleted");
    expect(probe.draft.doc.channels[1].messageKeys).toEqual(["RefundCompleted"]);
    expect(probe.draft.doc.operations[1].reply?.messageKeys).toEqual(["RefundCompleted"]);
    expect(probe.item).toBe("RefundCompleted");
    expect(screen.getByTestId("message-row-RefundCompleted").getAttribute("aria-current")).toBe("true");
    expect(probe.draft.problems).toEqual([]);
  });

  it("renaming through the Identifier rewrites the messageKeys of operations", async () => {
    const { probe } = await renderMessages();
    type(box("message-key"), "OrderPlaced");
    fireEvent.blur(box("message-key"));
    expect(probe.draft.doc.operations[0].messageKeys).toEqual(["OrderPlaced"]);
    expect(probe.draft.doc.channels[0].messageKeys).toEqual(["OrderPlaced"]);
    expect(probe.draft.problems).toEqual([]);
  });

  it("rejects a key another message already uses and a key with a space", async () => {
    const { probe } = await renderMessages({ doc: docWithReply() });
    type(box("message-key"), "RefundIssued");
    fireEvent.blur(box("message-key"));
    expect(text("message-key-error")).toBe('The key "RefundIssued" is already used.');
    type(box("message-key"), "has space");
    expect(text("message-key-error")).toContain("no spaces");
    fireEvent.blur(box("message-key"));
    expect(probe.draft.doc.messages[0].key).toBe("OrderCreated");
    expect(probe.draft.dirty).toBe(false);
  });
});

describe("MessagesSection: sent on channels", () => {
  it("renders one checkbox per channel, labelled by title or address, mirroring channels[].messageKeys", async () => {
    const doc = sampleDocument();
    doc.channels[1] = { ...doc.channels[1], title: "Refunds" };
    await renderMessages({ doc });
    expect(box("message-channels-option-orders").checked).toBe(true);
    expect(box("message-channels-option-refunds").checked).toBe(false);
    expect(box("message-channels-option-orders").closest("label")?.textContent).toContain("orders.v1");
    expect(box("message-channels-option-refunds").closest("label")?.textContent).toContain("Refunds");
  });

  it("checking a channel adds the message to that channel's messageKeys, unchecking removes it", async () => {
    const { probe } = await renderMessages();
    fireEvent.click(box("message-channels-option-refunds"));
    expect(probe.draft.doc.channels[1].messageKeys).toEqual(["OrderCreated"]);
    expect(box("message-channels-option-refunds").checked).toBe(true);
    fireEvent.click(box("message-channels-option-refunds"));
    expect(probe.draft.doc.channels[1].messageKeys).toEqual([]);
    expect(probe.draft.doc.channels[0].messageKeys).toEqual(["OrderCreated"]);
    expect(probe.draft.problems).toEqual([]);
  });

  it("refuses to take the message off a channel where an operation uses it, and names the operation", async () => {
    const { probe } = await renderMessages();
    fireEvent.click(box("message-channels-option-orders"));
    const notice = text("message-channels-blocked") ?? "";
    expect(notice).toContain('"publishOrder"');
    expect(notice).toContain('"orders"');
    expect(box("message-channels-option-orders").checked).toBe(true);
    expect(probe.draft.doc.channels[0].messageKeys).toEqual(["OrderCreated"]);
    expect(probe.draft.dirty).toBe(false);
  });

  it("also refuses when the message is an operation's reply on that channel", async () => {
    const { probe } = await renderMessages({ doc: docWithReply(), item: "RefundIssued" });
    fireEvent.click(box("message-channels-option-refunds"));
    expect(text("message-channels-blocked")).toContain('"askRefund"');
    expect(probe.draft.doc.channels[1].messageKeys).toEqual(["RefundIssued"]);
  });

  it("clears the notice after the next successful toggle", async () => {
    await renderMessages();
    fireEvent.click(box("message-channels-option-orders"));
    expect(missing("message-channels-blocked")).toBe(false);
    fireEvent.click(box("message-channels-option-refunds"));
    expect(missing("message-channels-blocked")).toBe(true);
  });

  it("tells the user to add a channel when there are none", async () => {
    const doc = sampleDocument();
    doc.channels = [];
    doc.operations = [];
    await renderMessages({ doc });
    expect(text("message-channels-empty")).toContain("No channels");
  });
});

describe("MessagesSection: remove message", () => {
  /** What the last toast offered: its text and the Undo action. */
  const lastToast = () => {
    const [message, options] = h.toast.mock.calls.at(-1) as [string, { action: { label: string; onClick: () => void }; duration: number }];
    return { message, options };
  };
  const undo = () => act(() => { lastToast().options.action.onClick(); });

  it("removes a message nothing refers to, without asking, and offers Undo", async () => {
    const confirm = vi.spyOn(window, "confirm").mockReturnValue(true);
    const { probe } = await renderMessages();
    click("message-add");
    click("message-remove");
    expect(confirm).not.toHaveBeenCalled();
    expect(probe.draft.doc.messages.map((m) => m.key)).toEqual(["OrderCreated"]);
    expect(probe.item).toBeNull();
    expect(lastToast().message).toBe('Removed "message"');
    expect(lastToast().options.action.label).toBe("Undo");
  });

  it("removes a message that channels and operations use, and every reference to it, without asking", async () => {
    const confirm = vi.spyOn(window, "confirm").mockReturnValue(true);
    const { probe } = await renderMessages();
    click("message-remove");
    expect(confirm).not.toHaveBeenCalled();
    expect(probe.draft.doc.messages).toEqual([]);
    expect(probe.draft.doc.channels.map((c) => c.messageKeys)).toEqual([[], []]);
    expect(probe.draft.doc.operations[0].messageKeys).toEqual([]);
    expect(probe.draft.problems).toEqual([]);
    expect(screen.getByTestId("message-empty")).toBeDefined();
  });

  it("says in the toast which channels and operations it was taken out of", async () => {
    await renderMessages();
    click("message-remove");
    const { message } = lastToast();
    expect(message).toContain('"OrderCreated"');
    expect(message).toContain("1 channel (orders)");
    expect(message).toContain("1 operation (publishOrder)");
  });

  it("removes the message from an operation's reply as well and keeps the reply's channel", async () => {
    const { probe } = await renderMessages({ doc: docWithReply(), item: "RefundIssued" });
    click("message-remove");
    expect(probe.draft.doc.messages.map((m) => m.key)).toEqual(["OrderCreated"]);
    expect(probe.draft.doc.channels[1].messageKeys).toEqual([]);
    expect(probe.draft.doc.operations[1].reply).toEqual({ channelKey: "refunds", messageKeys: [] });
    expect(probe.draft.doc.operations[1].messageKeys).toEqual(["OrderCreated"]);
    expect(probe.draft.problems).toEqual([]);
  });

  it("Undo brings back the message and every reference to it, exactly as they were", async () => {
    const { probe } = await renderMessages({ doc: docWithReply(), item: "RefundIssued" });
    click("message-remove");
    expect(probe.draft.doc).not.toEqual(docWithReply());
    await undo();
    expect(probe.draft.doc).toEqual(docWithReply());
    expect(screen.getByTestId("message-row-RefundIssued")).toBeDefined();
  });

  it("keeps the toast up long enough for a keyboard or screen-reader user to reach it", async () => {
    await renderMessages();
    click("message-remove");
    expect(lastToast().options.duration).toBeGreaterThanOrEqual(15_000);
  });

  it("Undo selects the message it brings back, and Remove moves focus to the strip", async () => {
    const { probe } = await renderMessages({ doc: docWithReply(), item: "RefundIssued" });
    click("message-remove");
    const active = document.activeElement as HTMLElement;
    expect(active.getAttribute("data-testid")).toMatch(/^message-row-/);
    expect(active.getAttribute("aria-selected")).toBe("true");
    expect(probe.item).toBeNull();
    await undo();
    expect(probe.item).toBe("RefundIssued");
  });

  it("takes the toast down at the next change to the document, so Undo can never overwrite a later edit", async () => {
    const { probe } = await renderMessages({ doc: docWithReply() });
    click("message-remove");
    const firstId = h.toast.mock.results[0].value;
    expect(h.toastDismiss).not.toHaveBeenCalled();
    type(field("Title"), "Edited after removing");
    expect(h.toastDismiss).toHaveBeenCalledWith(firstId);
    const edited = probe.draft.doc;
    await undo();
    expect(probe.draft.doc).toEqual(edited);
  });

  it("after two removals Undo brings back only the second, and the first toast is gone", async () => {
    const { probe } = await renderMessages({ doc: docWithReply() });
    click("message-remove");
    const firstId = h.toast.mock.results[0].value;
    click("message-remove");
    expect(h.toastDismiss).toHaveBeenCalledWith(firstId);
    expect(probe.draft.doc.messages).toEqual([]);
    await undo();
    expect(probe.draft.doc.messages.map((m) => m.key)).toEqual(["RefundIssued"]);
  });

  it("takes the toast down when the Messages section goes away", async () => {
    const { unmount } = await renderMessages();
    click("message-remove");
    const id = h.toast.mock.results[0].value;
    unmount();
    expect(h.toastDismiss).toHaveBeenCalledWith(id);
  });
});

describe("MessagesSection: duplicate message", () => {
  it("adds a copy, selects it, and puts it on no channel", async () => {
    const doc = sampleDocument();
    doc.messages[0] = { ...doc.messages[0], title: "Order created", summary: "An order was created" };
    const { probe } = await renderMessages({ doc });
    click("message-duplicate");
    expect(probe.draft.doc.messages).toHaveLength(2);
    const copy = probe.draft.doc.messages[1];
    expect(copy).toEqual({ ...doc.messages[0], key: copy.key });
    expect(copy.key).not.toBe("OrderCreated");
    expect(probe.item).toBe(copy.key);
    expect(probe.draft.doc.channels.every((c) => !c.messageKeys.includes(copy.key))).toBe(true);
    expect(text("message-sent-on")).toContain("Not sent on any channel");
  });

  it("is a button next to Remove, in the footer of the form", async () => {
    await renderMessages();
    const duplicate = screen.getByTestId("message-duplicate");
    expect(duplicate.getAttribute("aria-label")).toBe("Duplicate message");
    expect(duplicate.parentElement).toBe(screen.getByTestId("message-remove").parentElement);
  });
});

describe("MessagesSection: field errors", () => {
  it("shows the parser's problems under the property they belong to", async () => {
    await renderMessages();
    openCard("docs");
    type(box("message-externalDocs-url"), "not a url");
    expect(text("message-externalDocs-url-error")).toBeTruthy();
    expect(box("message-externalDocs-url").getAttribute("aria-invalid")).toBe("true");
  });

  it("shows the errors of the message at the selected index and not those of another message", async () => {
    const doc = docWithReply();
    doc.messages[1] = { ...doc.messages[1], payload: { entityId: "", entityVersionId: null } };
    await renderMessages({ doc });
    expect(missing("payload-error")).toBe(true);
    click("message-row-RefundIssued");
    expect(text("payload-error")).toBe("entityId is required");
  });

  it("shows the problems of a failed save under the Message properties card, opening it", async () => {
    const saveDocument = vi.fn<SaveDocument>().mockResolvedValue({
      success: false, error: "1 problem(s) in the event document", code: "VALIDATION_ERROR",
      details: { problems: [{ pointer: "/messages/0/traitKeys/0", message: 'Unknown message properties "Gone"' }] },
    });
    renderBuilder({ saveDocument, section: "messages" });
    await settle();
    openCard("properties");
    openCard("payload");
    expect(isOpen("properties")).toBe(false);
    type(field("Title"), "Changed");
    await act(async () => { click("builder-save"); });
    expect(isOpen("properties")).toBe(true);
    expect(text("message-prop-error")).toBe('Unknown message properties "Gone"');
  });
});

describe("MessagesSection: nothing is lost, nothing empty is added", () => {
  it("a message that uses every property keeps all of them when one is edited", async () => {
    const doc = maximalDocument();
    const before = structuredClone(doc.messages[0]);
    const { probe } = renderSection(MessagesSection, { doc });
    await screen.findByLabelText("Payload entity");
    expect(probe.draft.problems).toEqual([]);
    type(box("message-title"), "Order was created");
    expect(probe.draft.doc.messages[0]).toEqual({ ...before, title: "Order was created" });
    expect(probe.draft.problems).toEqual([]);
  });

  it("a new message with only a payload gives a valid document with no empty extras", async () => {
    const { probe } = await renderMessages();
    click("message-add");
    type(field("Payload entity"), "ent-2");
    expect(probe.draft.doc.messages[1]).toEqual({ key: "message", payload: { entityId: "ent-2", entityVersionId: "ver-2" }, traitKeys: [] });
    expect(parseEventDocument(probe.draft.doc).success).toBe(true);
    expect(probe.draft.problems).toEqual([]);
  });
});

describe("MessagesSection: external references", () => {
  it("shows the card of external messages under the list, and also while there are no local messages", async () => {
    await renderMessages();
    expect(text("external-refs-message")).toContain("Messages from other events");
    expect(missing("external-refs-channel")).toBe(true);
    cleanup();
    renderSection(MessagesSection, { doc: emptyEventDocument("Empty") });
    expect(screen.getByTestId("message-empty")).toBeDefined();
    expect(text("external-refs-empty")).toContain("Messages from other events");
  });

  it("lists the references of the document in the card and counts them with the messages in the outline", async () => {
    const doc = sampleDocument();
    doc.externalRefs = [{ key: "Order-placed", eventVersionId: "vv1", kind: "message", itemKey: "OrderPlaced" }];
    renderBuilder({ doc, section: "messages" });
    await settle();
    expect(screen.getByTestId("external-ref-row-Order-placed")).toBeDefined();
    expect(text("outline-count-messages")).toBe("2");
  });
});

describe("MessagesSection: the item tab strip", () => {
  it("picks items from a tab strip with the add button pinned beside it, not in the header", async () => {
    const { probe } = await renderMessages();
    const strip = screen.getByRole("tablist", { name: "Messages" });
    expect(within(strip).getAllByRole("tab").map((t) => t.getAttribute("data-testid"))).toEqual(["message-row-OrderCreated"]);
    expect(screen.getByTestId("message-row-OrderCreated").getAttribute("aria-current")).toBe("true");
    const add = screen.getByTestId("message-add");
    expect(strip.contains(add)).toBe(false);
    expect(screen.getAllByRole("button", { name: "Add message" })).toHaveLength(1);
    const before = probe.draft.doc.messages.length;
    fireEvent.click(add);
    expect(probe.draft.doc.messages).toHaveLength(before + 1);
    expect(probe.item).toBe(probe.draft.doc.messages[before].key);
  });

  it("keeps the section description in an info tip beside the heading", async () => {
    await renderMessages();
    const tip = screen.getByTestId("messages-help");
    expect(tip.hasAttribute("hidden")).toBe(true);
    expect(tip.textContent).toContain("What is sent");
    expect(screen.getByTestId("messages-help-button").getAttribute("aria-label")).toBe("About messages");
  });

  it("puts what the list row used to show under its name in the tab's title", async () => {
    await renderMessages();
    expect(screen.getByTestId("message-row-OrderCreated").getAttribute("title")).toContain("OrderCreated");
  });
});
