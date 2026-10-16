// @vitest-environment jsdom
import { act, cleanup, fireEvent, screen, waitFor, within } from "@testing-library/react";
import { afterEach, beforeAll, beforeEach, describe, expect, it, vi } from "vitest";
import type { BuilderOptions, LibraryTraitOption } from "@/features/events/builder/EventBuilder";
import { MessagesSection } from "@/features/events/builder/sections/MessagesSection";
import { OperationsSection } from "@/features/events/builder/sections/OperationsSection";
import { BUNDLED_TRAITS, propertySummary } from "@/lib/events/bundled-traits";
import { parseEventDocument } from "@/lib/events/document/parse";
import type { EventDocument } from "@/lib/events/document/types";
import { ENTITY_OPTIONS, renderBuilder, renderSection, sampleDocument } from "./builder-harness";

const h = vi.hoisted(() => ({ listPinnableVersionsAction: vi.fn() }));
vi.mock("@/features/events/pin-actions", () => ({ listPinnableVersionsAction: h.listPinnableVersionsAction }));

beforeAll(() => {
  globalThis.ResizeObserver ??= class { observe() { /* no layout */ } unobserve() { /* no layout */ } disconnect() { /* no layout */ } } as unknown as typeof ResizeObserver;
  Element.prototype.scrollIntoView ??= () => undefined;
});
beforeEach(() => {
  vi.clearAllMocks();
  h.listPinnableVersionsAction.mockResolvedValue({ success: true, data: [] });
});
afterEach(() => {
  cleanup();
  vi.restoreAllMocks();
});

const type = (el: HTMLElement, value: string) => fireEvent.change(el, { target: { value } });
const click = (testId: string) => fireEvent.click(screen.getByTestId(testId));
const box = (testId: string) => screen.getByTestId(testId) as HTMLInputElement;
const text = (testId: string) => screen.getByTestId(testId).textContent;
const missing = (testId: string) => screen.queryByTestId(testId) === null;

const CLOUDEVENTS = BUNDLED_TRAITS.find((t) => t.name === "CloudEvents")!;
const LIBRARY: LibraryTraitOption[] = [
  { id: "builtin-ce", name: "CloudEvents", kind: "MESSAGE", bundled: true, level: "Enterprise", spec: CLOUDEVENTS.spec, properties: propertySummary(CLOUDEVENTS.spec) },
  {
    id: "lib-msg-1", name: "Audit headers", kind: "MESSAGE", level: "Enterprise",
    spec: { headers: { type: "object", properties: { actor: { type: "string", description: "Who did it" } }, required: ["actor"] } },
    properties: [{ name: "actor", type: "string", required: true, description: "Who did it" }],
  },
  { id: "lib-msg-2", name: "Tracing", kind: "MESSAGE", level: "Domain · Payments" },
  {
    id: "lib-op-1", name: "Retry policy", kind: "OPERATION", level: "Enterprise",
    spec: { title: "Retry policy", summary: "Retries three times", description: "Backs off", tags: [{ name: "resilience" }], externalDocs: { url: "https://example.com/retry" } },
  },
  { id: "lib-op-2", name: "Dead letter", kind: "OPERATION", level: "Enterprise" },
];
const OPTIONS: BuilderOptions = { entityOptions: ENTITY_OPTIONS, libraryTraits: LIBRARY };

/** sampleDocument: message OrderCreated (on `orders`), a second message OrderUpdated, operation publishOrder. */
function baseDoc(): EventDocument {
  const doc = sampleDocument();
  doc.messages.push({ key: "OrderUpdated", payload: doc.messages[0].payload, traitKeys: [] });
  doc.channels[0].messageKeys = ["OrderCreated", "OrderUpdated"];
  return doc;
}

async function renderMessages(doc: EventDocument = baseDoc(), item: string | null = null) {
  const rendered = renderSection(MessagesSection, { doc, options: OPTIONS, item });
  await screen.findByLabelText("Payload entity");
  await act(async () => {});
  return rendered;
}

/** Open the card's "+ Add" and pick an item. */
async function addFromCard(prefix: "message" | "operation", itemId: string) {
  click(`${prefix}-prop-add`);
  await screen.findByTestId("trait-chooser");
  click(`trait-chooser-item-${itemId}`);
  await waitFor(() => expect(missing("trait-chooser")).toBe(true));
}

describe("MessagePropertiesCard: the properties where they are used", () => {
  it("is the 'Message properties (Trait)' card, open by default, with an Add button and an empty hint", async () => {
    await renderMessages();
    expect(screen.getByTestId("message-card-properties-toggle").textContent).toContain("Message properties (Trait)");
    expect(screen.getByTestId("message-card-properties-toggle").getAttribute("aria-expanded")).toBe("true");
    expect(text("message-prop-empty")).toContain("No message properties on this message yet");
    expect(screen.getByTestId("message-prop-add").getAttribute("aria-label")).toBe("Add message properties");
  });

  it("shows one row per applied set with its name, the Trait badge, a lock for built-in and library sets, and the property count", async () => {
    const doc = baseDoc();
    doc.traits = [
      { key: "CloudEvents", kind: "MESSAGE", libraryTraitId: "builtin-ce" },
      { key: "audit", kind: "MESSAGE", libraryTraitId: "lib-msg-1" },
      { key: "idem", kind: "MESSAGE", spec: { name: "Idempotent", headers: { type: "object", properties: { key: { type: "string" } } } } },
    ];
    doc.messages[0] = { ...doc.messages[0], traitKeys: ["CloudEvents", "audit", "idem"] };
    await renderMessages(doc);
    expect(text("message-prop-toggle-CloudEvents")).toContain("CloudEvents");
    expect(text("message-prop-badge-CloudEvents")).toBe("Trait");
    expect(text("message-prop-lock-CloudEvents")).toBe("Built in");
    expect(text("message-prop-count-CloudEvents")).toBe("8 properties");
    expect(text("message-prop-lock-audit")).toBe("Library");
    expect(text("message-prop-toggle-audit")).toContain("Audit headers");
    expect(text("message-prop-count-idem")).toBe("1 property");
    expect(text("message-prop-badge-idem")).toBe("Trait");
    expect(missing("message-prop-lock-idem")).toBe(true);
    expect(text("message-card-properties-count")).toBe("3");
  });

  it("opens the chooser filtered to messages: no Applies to control, only message sets", async () => {
    await renderMessages();
    click("message-prop-add");
    await screen.findByTestId("trait-chooser");
    expect(missing("trait-chooser-kind")).toBe(true);
    expect(text("trait-chooser-kind-locked")).toContain("this message");
    expect(missing("trait-chooser-item-lib-op-1")).toBe(true);
    expect(screen.getByTestId("trait-chooser-item-builtin-ce")).toBeDefined();
  });

  it("adds a built-in set to THIS message in one step: the entry is created, applied, and its properties are shown", async () => {
    const { probe } = await renderMessages();
    await addFromCard("message", "builtin-ce");
    expect(probe.draft.doc.traits).toEqual([{ key: "CloudEvents", kind: "MESSAGE", libraryTraitId: "builtin-ce" }]);
    expect(probe.draft.doc.messages.map((m) => m.traitKeys)).toEqual([["CloudEvents"], []]);
    expect(parseEventDocument(probe.draft.doc).success).toBe(true);
    // The row is open: the unmodifiable properties are visible in the form.
    expect(screen.getByTestId("message-prop-panel-CloudEvents")).toBeDefined();
    const names = within(screen.getByTestId("message-prop-CloudEvents-table")).getAllByRole("rowheader").map((r) => r.textContent);
    expect(names).toEqual(["specversion", "id", "source", "type", "subject", "time", "datacontenttype", "dataschema"]);
    expect(text("message-prop-CloudEvents-note")).toBe("Built in — can't be modified");
    expect(text("message-prop-CloudEvents-defined-by")).toContain("Defined by CloudEvents");
    expect(text("message-prop-CloudEvents-row-specversion-allowed")).toBe("Always1.0");
  });

  it("shows a built-in set locked: its panel has no input, select or button to edit it", async () => {
    const { probe } = await renderMessages();
    await addFromCard("message", "builtin-ce");
    const panel = screen.getByTestId("message-prop-panel-CloudEvents");
    expect(panel.querySelectorAll("input, select, textarea, button")).toHaveLength(0);
    expect(probe.draft.dirty).toBe(true);
  });

  it("adds a library set the same way and shows it with the library note", async () => {
    const { probe } = await renderMessages();
    await addFromCard("message", "lib-msg-1");
    expect(probe.draft.doc.traits).toEqual([{ key: "Audit-headers", kind: "MESSAGE", libraryTraitId: "lib-msg-1" }]);
    expect(probe.draft.doc.messages[0].traitKeys).toEqual(["Audit-headers"]);
    expect(text("message-prop-Audit-headers-note")).toBe("From the library — edit it under Message properties at the Tenant/Domain level");
    expect(text("message-prop-Audit-headers-row-actor-description")).toBe("Who did it");
  });

  it("reuses the document entry when another message already uses the library set: one entry, both messages apply it", async () => {
    const doc = baseDoc();
    doc.traits = [{ key: "CloudEvents", kind: "MESSAGE", libraryTraitId: "builtin-ce" }];
    doc.messages[1] = { ...doc.messages[1], traitKeys: ["CloudEvents"] };
    const { probe } = await renderMessages(doc);
    click("message-prop-add");
    await screen.findByTestId("trait-chooser");
    expect(text("trait-chooser-item-builtin-ce-state")).toBe("In this event");
    click("trait-chooser-item-builtin-ce");
    await waitFor(() => expect(missing("trait-chooser")).toBe(true));
    expect(probe.draft.doc.traits).toHaveLength(1);
    expect(probe.draft.doc.messages.map((m) => m.traitKeys)).toEqual([["CloudEvents"], ["CloudEvents"]]);
  });

  it("shows a set already applied to this message as Added and does not add it twice", async () => {
    const doc = baseDoc();
    doc.traits = [{ key: "CloudEvents", kind: "MESSAGE", libraryTraitId: "builtin-ce" }];
    doc.messages[0] = { ...doc.messages[0], traitKeys: ["CloudEvents"] };
    const { probe } = await renderMessages(doc);
    click("message-prop-add");
    await screen.findByTestId("trait-chooser");
    expect(text("trait-chooser-item-builtin-ce-state")).toBe("Added");
    click("trait-chooser-item-builtin-ce");
    expect(probe.draft.doc.messages[0].traitKeys).toEqual(["CloudEvents"]);
    expect(probe.draft.dirty).toBe(false);
  });

  it("applies a set to this message only, never to the other messages", async () => {
    const { probe } = await renderMessages();
    await addFromCard("message", "lib-msg-2");
    expect(probe.draft.doc.messages.map((m) => m.traitKeys)).toEqual([["Tracing"], []]);
  });
});

describe("MessagePropertiesCard: a new local set", () => {
  it("creates a blank set with a placeholder key, applies it to this message, opens it and focuses its name", async () => {
    const { probe } = await renderMessages();
    await addFromCard("message", "new");
    expect(probe.draft.doc.traits).toEqual([{ key: "trait", kind: "MESSAGE", spec: {} }]);
    expect(probe.draft.doc.messages[0].traitKeys).toEqual(["trait"]);
    expect(text("message-prop-toggle-trait")).toContain("New message properties");
    await waitFor(() => expect(document.activeElement).toBe(box("message-prop-trait-name")));
    expect(missing("message-prop-lock-trait")).toBe(true);
  });

  it("names the set and its key when focus leaves, keeps the row open and the message's traitKeys following", async () => {
    const { probe } = await renderMessages();
    await addFromCard("message", "new");
    type(box("message-prop-trait-name"), "Idempotent writes");
    expect(probe.draft.doc.traits[0].key).toBe("trait");
    fireEvent.blur(box("message-prop-trait-name"));
    expect(probe.draft.doc.traits[0].key).toBe("Idempotent-writes");
    expect(probe.draft.doc.messages[0].traitKeys).toEqual(["Idempotent-writes"]);
    expect(text("message-prop-toggle-Idempotent-writes")).toContain("Idempotent writes");
    expect(screen.getByTestId("message-prop-panel-Idempotent-writes")).toBeDefined();
    expect(parseEventDocument(probe.draft.doc).success).toBe(true);
  });

  it("edits the set's properties right there: the Properties table writes spec.headers of the set", async () => {
    const { probe } = await renderMessages();
    await addFromCard("message", "new");
    click("message-prop-trait-add");
    type(box("message-prop-trait-name-0"), "correlationId");
    fireEvent.click(box("message-prop-trait-required-0"));
    const trait = probe.draft.doc.traits[0] as unknown as { spec: { headers: unknown } };
    expect(trait.spec.headers).toEqual({ type: "object", properties: { correlationId: { type: "string" } }, required: ["correlationId"] });
    expect(text("message-prop-count-trait")).toBe("1 property");
    expect(probe.draft.problems).toEqual([]);
  });

  it("keeps a local set's other messages untouched: editing is shared by the set, application is per message", async () => {
    const doc = baseDoc();
    doc.traits = [{ key: "idem", kind: "MESSAGE", spec: { name: "Idempotent" } }];
    doc.messages[0] = { ...doc.messages[0], traitKeys: ["idem"] };
    doc.messages[1] = { ...doc.messages[1], traitKeys: ["idem"] };
    const { probe } = await renderMessages(doc);
    click("message-prop-toggle-idem");
    click("message-prop-idem-add");
    type(box("message-prop-idem-name-0"), "key");
    expect((probe.draft.doc.traits[0] as { spec: { headers?: unknown } }).spec.headers).toBeDefined();
    expect(probe.draft.doc.messages.map((m) => m.traitKeys)).toEqual([["idem"], ["idem"]]);
  });

  it("shows a stored headers entity pin as a read-only note and keeps it", async () => {
    const doc = baseDoc();
    doc.traits = [{ key: "idem", kind: "MESSAGE", spec: { name: "Idempotent" }, headers: { entityId: "ent-2", entityVersionId: "ver-2" } }];
    doc.messages[0] = { ...doc.messages[0], traitKeys: ["idem"] };
    const { probe } = await renderMessages(doc);
    click("message-prop-toggle-idem");
    expect(text("message-prop-idem-pin-note")).toBe("Headers come from the entity OrderCancelled.");
    type(box("message-prop-idem-name"), "Renamed");
    expect(probe.draft.doc.traits[0]).toMatchObject({ headers: { entityId: "ent-2", entityVersionId: "ver-2" } });
  });
});

describe("MessagePropertiesCard: expand, remove", () => {
  it("expands and collapses a row from its button, with aria-expanded and aria-controls", async () => {
    const doc = baseDoc();
    doc.traits = [{ key: "audit", kind: "MESSAGE", libraryTraitId: "lib-msg-1" }];
    doc.messages[0] = { ...doc.messages[0], traitKeys: ["audit"] };
    await renderMessages(doc);
    const toggle = screen.getByTestId("message-prop-toggle-audit");
    expect(toggle.getAttribute("aria-expanded")).toBe("false");
    expect(missing("message-prop-panel-audit")).toBe(true);
    fireEvent.click(toggle);
    expect(toggle.getAttribute("aria-expanded")).toBe("true");
    expect(toggle.getAttribute("aria-controls")).toBe(screen.getByTestId("message-prop-panel-audit").id);
    expect(screen.getByTestId("message-prop-audit-row-actor")).toBeDefined();
    fireEvent.click(toggle);
    expect(missing("message-prop-panel-audit")).toBe(true);
  });

  it("removes a set from THIS message only, keeping a local set in the document for the other message", async () => {
    const doc = baseDoc();
    doc.traits = [{ key: "idem", kind: "MESSAGE", spec: { name: "Idempotent" } }];
    doc.messages[0] = { ...doc.messages[0], traitKeys: ["idem"] };
    doc.messages[1] = { ...doc.messages[1], traitKeys: ["idem"] };
    const { probe } = await renderMessages(doc);
    click("message-prop-remove-idem");
    expect(probe.draft.doc.messages.map((m) => m.traitKeys)).toEqual([[], ["idem"]]);
    expect(probe.draft.doc.traits.map((t) => t.key)).toEqual(["idem"]);
    expect(text("message-prop-empty")).toContain("No message properties");
  });

  it("keeps a local set that nothing uses any more: it stays under Message properties, where it can be reused", async () => {
    const doc = baseDoc();
    doc.traits = [{ key: "idem", kind: "MESSAGE", spec: { name: "Idempotent" } }];
    doc.messages[0] = { ...doc.messages[0], traitKeys: ["idem"] };
    const { probe } = await renderMessages(doc);
    click("message-prop-remove-idem");
    expect(probe.draft.doc.traits.map((t) => t.key)).toEqual(["idem"]);
  });

  it("prunes a library entry that nothing uses any more", async () => {
    const doc = baseDoc();
    doc.traits = [{ key: "CloudEvents", kind: "MESSAGE", libraryTraitId: "builtin-ce" }];
    doc.messages[0] = { ...doc.messages[0], traitKeys: ["CloudEvents"] };
    const { probe } = await renderMessages(doc);
    click("message-prop-remove-CloudEvents");
    expect(probe.draft.doc.traits).toEqual([]);
    expect(probe.draft.doc.messages[0].traitKeys).toEqual([]);
    expect(parseEventDocument(probe.draft.doc).success).toBe(true);
  });

  it("keeps a library entry another message still uses", async () => {
    const doc = baseDoc();
    doc.traits = [{ key: "CloudEvents", kind: "MESSAGE", libraryTraitId: "builtin-ce" }];
    doc.messages[0] = { ...doc.messages[0], traitKeys: ["CloudEvents"] };
    doc.messages[1] = { ...doc.messages[1], traitKeys: ["CloudEvents"] };
    const { probe } = await renderMessages(doc);
    click("message-prop-remove-CloudEvents");
    expect(probe.draft.doc.traits.map((t) => t.key)).toEqual(["CloudEvents"]);
    expect(probe.draft.doc.messages.map((m) => m.traitKeys)).toEqual([[], ["CloudEvents"]]);
  });

  it("names the remove button after the set and the message", async () => {
    const doc = baseDoc();
    doc.traits = [{ key: "CloudEvents", kind: "MESSAGE", libraryTraitId: "builtin-ce" }];
    doc.messages[0] = { ...doc.messages[0], traitKeys: ["CloudEvents"] };
    await renderMessages(doc);
    expect(screen.getByRole("button", { name: "Remove CloudEvents from this message" })).toBe(screen.getByTestId("message-prop-remove-CloudEvents"));
  });

  it("shows a key that is applied but not defined so it can be taken off", async () => {
    const doc = baseDoc();
    doc.messages[0] = { ...doc.messages[0], traitKeys: ["Gone"] };
    const { probe } = await renderMessages(doc);
    expect(text("message-prop-row-Gone")).toContain("Gone (not defined)");
    click("message-prop-remove-Gone");
    expect(probe.draft.doc.messages[0].traitKeys).toEqual([]);
  });

  it("says when a library set is not offered to this event any more", async () => {
    const doc = baseDoc();
    doc.traits = [{ key: "old", kind: "MESSAGE", libraryTraitId: "deleted" }];
    doc.messages[0] = { ...doc.messages[0], traitKeys: ["old"] };
    await renderMessages(doc);
    click("message-prop-toggle-old");
    expect(text("message-prop-old-missing")).toContain("not offered to this event any more");
  });

  it("shows the parser's problem for a bad reference under the card", async () => {
    const doc = baseDoc();
    doc.messages[0] = { ...doc.messages[0], traitKeys: ["Gone"] };
    await renderMessages(doc);
    expect(text("message-prop-error")).toContain("Gone");
  });

  it("when a set is removed in the Message properties section, its key leaves the message card's chip row", async () => {
    const doc = baseDoc();
    doc.traits = [{ key: "idem", kind: "MESSAGE", spec: { name: "Idempotent" } }];
    doc.messages[0] = { ...doc.messages[0], traitKeys: ["idem"] };
    vi.spyOn(window, "confirm").mockReturnValue(true);
    const { probe } = renderBuilder({ doc, options: OPTIONS, section: "traits" });
    click("trait-remove");
    expect(probe.draft.doc.messages[0].traitKeys).toEqual([]);
    click("outline-messages");
    await screen.findByLabelText("Payload entity");
    expect(missing("message-prop-row-idem")).toBe(true);
    expect(text("message-prop-empty")).toContain("No message properties");
  });
});

describe("MessagePropertiesCard: edit all details", () => {
  it("offers a link to the full form of a local set that opens it in the Message properties section", async () => {
    const doc = baseDoc();
    doc.traits = [{ key: "idem", kind: "MESSAGE", spec: { name: "Idempotent" } }];
    doc.messages[0] = { ...doc.messages[0], traitKeys: ["idem"] };
    const { probe } = renderBuilder({ doc, options: OPTIONS, section: "messages" });
    await screen.findByLabelText("Payload entity");
    click("message-prop-toggle-idem");
    click("message-prop-idem-more");
    expect(probe.section).toBe("traits");
    expect(probe.item).toBe("idem");
    expect(screen.getByTestId("trait-form")).toBeDefined();
  });

  it("has no such link where the host cannot switch sections", async () => {
    const doc = baseDoc();
    doc.traits = [{ key: "idem", kind: "MESSAGE", spec: { name: "Idempotent" } }];
    doc.messages[0] = { ...doc.messages[0], traitKeys: ["idem"] };
    await renderMessages(doc);
    click("message-prop-toggle-idem");
    expect(missing("message-prop-idem-more")).toBe(true);
  });
});

describe("OperationPropertiesCard", () => {
  const opDoc = (): EventDocument => {
    const doc = baseDoc();
    doc.traits = [];
    return doc;
  };

  it("is the 'Operation properties (Trait)' card, open by default, with its own Add button", () => {
    renderSection(OperationsSection, { doc: opDoc(), options: OPTIONS });
    expect(screen.getByTestId("operation-card-properties-toggle").textContent).toContain("Operation properties (Trait)");
    expect(screen.getByTestId("operation-card-properties-toggle").getAttribute("aria-expanded")).toBe("true");
    expect(screen.getByTestId("operation-prop-add").getAttribute("aria-label")).toBe("Add operation properties");
  });

  it("opens the chooser filtered to operations: only operation sets, no Applies to control", async () => {
    renderSection(OperationsSection, { doc: opDoc(), options: OPTIONS });
    click("operation-prop-add");
    await screen.findByTestId("trait-chooser");
    expect(missing("trait-chooser-kind")).toBe(true);
    expect(text("trait-chooser-kind-locked")).toContain("this operation");
    expect(screen.getByTestId("trait-chooser-item-lib-op-1")).toBeDefined();
    expect(missing("trait-chooser-item-builtin-ce")).toBe(true);
    expect(missing("trait-chooser-group-builtin")).toBe(true);
  });

  it("adds a library set to THIS operation in one step and shows its metadata read-only", async () => {
    const { probe } = renderSection(OperationsSection, { doc: opDoc(), options: OPTIONS });
    await addFromCard("operation", "lib-op-1");
    expect(probe.draft.doc.traits).toEqual([{ key: "Retry-policy", kind: "OPERATION", libraryTraitId: "lib-op-1" }]);
    expect(probe.draft.doc.operations[0].traitKeys).toEqual(["Retry-policy"]);
    expect(text("operation-prop-lock-Retry-policy")).toBe("Library");
    expect(text("operation-prop-Retry-policy-note")).toContain("From the library");
    expect(text("operation-prop-Retry-policy-meta-title")).toBe("Retry policy");
    expect(text("operation-prop-Retry-policy-meta-summary")).toBe("Retries three times");
    expect(text("operation-prop-Retry-policy-meta-description")).toBe("Backs off");
    expect(text("operation-prop-Retry-policy-meta-tags")).toBe("resilience");
    expect(text("operation-prop-Retry-policy-meta-docs")).toBe("https://example.com/retry");
    expect(screen.getByTestId("operation-prop-panel-Retry-policy").querySelectorAll("input, select, textarea")).toHaveLength(0);
    expect(parseEventDocument(probe.draft.doc).success).toBe(true);
  });

  it("explains a library set that has no details to show", async () => {
    renderSection(OperationsSection, { doc: opDoc(), options: { entityOptions: ENTITY_OPTIONS, libraryTraits: [{ ...LIBRARY[4], spec: undefined }] } });
    await addFromCard("operation", "lib-op-2");
    expect(text("operation-prop-Dead-letter-meta-empty")).toContain("Defined in the library at Enterprise");
  });

  it("adds a blank operation set, focuses its title and names its key from the title", async () => {
    const { probe } = renderSection(OperationsSection, { doc: opDoc(), options: OPTIONS });
    await addFromCard("operation", "new");
    expect(probe.draft.doc.traits).toEqual([{ key: "trait", kind: "OPERATION", spec: {} }]);
    expect(probe.draft.doc.operations[0].traitKeys).toEqual(["trait"]);
    await waitFor(() => expect(document.activeElement).toBe(box("operation-prop-trait-title")));
    type(box("operation-prop-trait-title"), "Retry three times");
    fireEvent.blur(box("operation-prop-trait-title"));
    expect(probe.draft.doc.traits[0].key).toBe("Retry-three-times");
    expect(probe.draft.doc.operations[0].traitKeys).toEqual(["Retry-three-times"]);
    expect((probe.draft.doc.traits[0] as unknown as { spec: { title: string } }).spec.title).toBe("Retry three times");
  });

  it("edits a local operation set's title, summary and description in the card", async () => {
    const doc = opDoc();
    doc.traits = [{ key: "retry", kind: "OPERATION", spec: { title: "Retry" } }];
    doc.operations[0] = { ...doc.operations[0], traitKeys: ["retry"] };
    const { probe } = renderSection(OperationsSection, { doc, options: OPTIONS });
    click("operation-prop-toggle-retry");
    type(box("operation-prop-retry-summary"), "Three tries");
    expect((probe.draft.doc.traits[0] as { spec: unknown }).spec).toEqual({ title: "Retry", summary: "Three tries" });
    expect(missing("operation-prop-retry-add")).toBe(true);
  });

  it("removes a set from this operation only and prunes a library entry nothing uses any more", async () => {
    const doc = opDoc();
    doc.traits = [{ key: "Retry-policy", kind: "OPERATION", libraryTraitId: "lib-op-1" }];
    doc.operations[0] = { ...doc.operations[0], traitKeys: ["Retry-policy"] };
    const { probe } = renderSection(OperationsSection, { doc, options: OPTIONS });
    expect(screen.getByRole("button", { name: "Remove Retry policy from this operation" })).toBeDefined();
    click("operation-prop-remove-Retry-policy");
    expect(probe.draft.doc.traits).toEqual([]);
    expect(probe.draft.doc.operations[0].traitKeys).toEqual([]);
    expect(text("operation-prop-empty")).toContain("No operation properties on this operation yet");
  });

  it("shows the parser's problem for a bad reference under the card, and opens it", async () => {
    const doc = opDoc();
    doc.operations[0] = { ...doc.operations[0], traitKeys: ["Gone"] };
    renderSection(OperationsSection, { doc, options: OPTIONS });
    expect(text("operation-prop-error")).toContain("Gone");
  });
});
