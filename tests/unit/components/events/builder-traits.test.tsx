// @vitest-environment jsdom
import { act, cleanup, fireEvent, screen, waitFor, within } from "@testing-library/react";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { SECTION_COMPONENTS, type BuilderOptions, type LibraryTraitOption } from "@/features/events/builder/EventBuilder";
import { TraitsSection } from "@/features/events/builder/sections/TraitsSection";
import type { SaveDocument } from "@/features/events/builder/use-event-draft";
import { parseEventDocument } from "@/lib/events/document/parse";
import { emptyEventDocument, type DocTrait, type EventDocument } from "@/lib/events/document/types";
import { bindingVersion, TEMPLATES } from "@/lib/events/templates";
import { ENTITY_OPTIONS, renderBuilder, renderSection, sampleDocument } from "./builder-harness";

// The headers pin loads its entity picker lazily; its version list goes through a server action.
const h = vi.hoisted(() => ({ listPinnableVersionsAction: vi.fn() }));
vi.mock("@/features/events/pin-actions", () => ({ listPinnableVersionsAction: h.listPinnableVersionsAction }));

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
const select = (testId: string) => screen.getByTestId(testId) as HTMLSelectElement;
const button = (testId: string) => screen.getByTestId(testId) as HTMLButtonElement;
const text = (testId: string) => screen.getByTestId(testId).textContent;
const missing = (testId: string) => screen.queryByTestId(testId) === null;
const rowKeys = (group: "message" | "operation") =>
  Array.from(screen.getByTestId(`trait-group-${group}`).querySelectorAll("[data-testid^='trait-row-']"))
    .map((e) => e.getAttribute("data-testid") as string).filter((id) => !id.endsWith("-library")).map((id) => id.replace("trait-row-", ""));
const optionTexts = (group: HTMLElement) => Array.from(group.querySelectorAll("option")).map((o) => o.textContent);

const LIBRARY: LibraryTraitOption[] = [
  { id: "lib-msg-1", name: "Audit headers", kind: "MESSAGE", level: "Enterprise" },
  { id: "lib-msg-2", name: "Tracing", kind: "MESSAGE", level: "Domain · Payments" },
  { id: "lib-op-1", name: "Retry policy", kind: "OPERATION", level: "Enterprise" },
  { id: "lib-op-2", name: "Dead letter", kind: "OPERATION" },
];
const OPTIONS: BuilderOptions = { entityOptions: ENTITY_OPTIONS, libraryTraits: LIBRARY };

/**
 * sampleDocument + three traits: `idempotent` (local message trait, on OrderCreated), `audit` (library message trait, lib-msg-1)
 * and `retry` (local operation trait, on no operation yet).
 */
function traitsDoc(): EventDocument {
  const doc = sampleDocument();
  doc.traits = [
    { key: "idempotent", kind: "MESSAGE", spec: { name: "Idempotent", description: "Safe to retry" } },
    { key: "audit", kind: "MESSAGE", libraryTraitId: "lib-msg-1" },
    { key: "retry", kind: "OPERATION", spec: { title: "Retry" } },
  ];
  doc.messages[0] = { ...doc.messages[0], traitKeys: ["idempotent"] };
  return doc;
}

const traitOf = (doc: EventDocument, key: string): DocTrait => doc.traits.find((t) => t.key === key) as DocTrait;
const specOf = (doc: EventDocument, key: string) => (traitOf(doc, key) as { spec: Record<string, unknown> }).spec;

it("the fixture is a valid document, so any problem below comes from the edit under test", () => {
  expect(parseEventDocument(traitsDoc()).success).toBe(true);
});

it("is registered as the traits section of the builder", () => {
  expect(SECTION_COMPONENTS.traits).toBe(TraitsSection);
});

describe("TraitsSection: empty state and actions", () => {
  it("shows an empty state and the three ways to add a trait when the document has none", () => {
    renderSection(TraitsSection, { doc: sampleDocument(), options: OPTIONS });
    expect(text("trait-empty")).toContain("No traits yet");
    expect(button("trait-add-message").textContent).toContain("Add message trait");
    expect(button("trait-add-operation").textContent).toContain("Add operation trait");
    expect(button("trait-add-library").textContent).toContain("Add from library");
    expect(screen.getByTestId("trait-library-select")).toBeDefined();
    expect(missing("trait-form")).toBe(true);
    expect(missing("trait-library-form")).toBe(true);
  });

  it("labels the library select and keeps Add from library disabled until a trait is chosen", () => {
    renderSection(TraitsSection, { doc: sampleDocument(), options: OPTIONS });
    expect(screen.getByLabelText("Library trait")).toBe(screen.getByTestId("trait-library-select"));
    expect(button("trait-add-library").disabled).toBe(true);
    type(select("trait-library-select"), "lib-op-1");
    expect(button("trait-add-library").disabled).toBe(false);
  });
});

describe("TraitsSection: list, groups and selection", () => {
  it("lists message traits and operation traits in their own groups, in document order", () => {
    renderSection(TraitsSection, { doc: traitsDoc(), options: OPTIONS });
    expect(within(screen.getByTestId("trait-group-message")).getByRole("heading", { name: "Message traits" })).toBeDefined();
    expect(within(screen.getByTestId("trait-group-operation")).getByRole("heading", { name: "Operation traits" })).toBeDefined();
    expect(rowKeys("message")).toEqual(["idempotent", "audit"]);
    expect(rowKeys("operation")).toEqual(["retry"]);
  });

  it("shows a name or title in the list, the library trait's own name, and not the generated key", () => {
    renderSection(TraitsSection, { doc: traitsDoc(), options: OPTIONS });
    expect(text("trait-row-idempotent")).toContain("Idempotent");
    expect(text("trait-row-retry")).toContain("Retry");
    expect(text("trait-row-audit")).toContain("Audit headers");
    expect(text("trait-row-audit")).not.toContain("audit ");
  });

  it("falls back to 'New message trait' / 'New operation trait' for a trait with no name yet, and to the key once it has been renamed", () => {
    const doc = sampleDocument();
    doc.traits = [
      { key: "trait", kind: "MESSAGE", spec: {} },
      { key: "trait-2", kind: "OPERATION", spec: {} },
      { key: "custom-key", kind: "OPERATION", spec: {} },
    ];
    renderSection(TraitsSection, { doc, options: OPTIONS });
    expect(text("trait-row-trait")).toContain("New message trait");
    expect(text("trait-row-trait-2")).toContain("New operation trait");
    expect(text("trait-row-custom-key")).toContain("custom-key");
  });

  it("marks library traits with a 'library' badge and no local trait", () => {
    renderSection(TraitsSection, { doc: traitsDoc(), options: OPTIONS });
    expect(text("trait-row-audit-library")).toBe("library");
    expect(missing("trait-row-idempotent-library")).toBe(true);
    expect(missing("trait-row-retry-library")).toBe(true);
  });

  it("shows how many messages or operations use each trait", () => {
    const doc = traitsDoc();
    doc.operations[0] = { ...doc.operations[0], traitKeys: ["retry"] };
    renderSection(TraitsSection, { doc, options: OPTIONS });
    expect(text("trait-row-idempotent")).toContain("Used by 1 message");
    expect(text("trait-row-audit")).toContain("Used by 0 messages");
    expect(text("trait-row-retry")).toContain("Used by 1 operation");
  });

  it("says 'None yet.' for a group without traits", () => {
    const doc = sampleDocument();
    doc.traits = [{ key: "idempotent", kind: "MESSAGE", spec: {} }];
    renderSection(TraitsSection, { doc, options: OPTIONS });
    expect(text("trait-group-operation-empty")).toBe("None yet.");
    expect(missing("trait-group-message-empty")).toBe(true);
  });

  it("opens the first trait's form and selects another on click, local or library", () => {
    renderSection(TraitsSection, { doc: traitsDoc(), options: OPTIONS });
    expect(screen.getByTestId("trait-row-idempotent").getAttribute("aria-current")).toBe("true");
    expect(box("trait-name").value).toBe("Idempotent");
    click("trait-row-audit");
    expect(screen.getByTestId("trait-row-audit").getAttribute("aria-current")).toBe("true");
    expect(screen.getByTestId("trait-row-idempotent").hasAttribute("aria-current")).toBe(false);
    expect(screen.getByTestId("trait-library-form")).toBeDefined();
    expect(missing("trait-form")).toBe(true);
    click("trait-row-retry");
    expect(box("trait-title").value).toBe("Retry");
  });

  it("opens the trait named by the selected item and falls back to the first when it is gone", () => {
    renderSection(TraitsSection, { doc: traitsDoc(), options: OPTIONS, item: "retry" });
    expect(box("trait-title").value).toBe("Retry");
    cleanup();
    renderSection(TraitsSection, { doc: traitsDoc(), options: OPTIONS, item: "gone" });
    expect(box("trait-name").value).toBe("Idempotent");
  });

  it("shows a problem dot on the row of a trait the document reports a problem on", () => {
    const doc = traitsDoc();
    doc.traits[2] = { key: "retry", kind: "OPERATION", spec: { security: ["nowhere"] } };
    doc.components = { securitySchemes: { basic: { type: "http", scheme: "basic" } } };
    renderSection(TraitsSection, { doc, options: OPTIONS });
    expect(text("trait-row-retry")).toContain("has problems");
    expect(text("trait-row-idempotent")).not.toContain("has problems");
  });
});

describe("TraitsSection: adding a local trait", () => {
  it("adds a message trait with an empty spec under a placeholder key, selects it and shows its form", () => {
    const { probe } = renderSection(TraitsSection, { doc: sampleDocument(), options: OPTIONS });
    click("trait-add-message");
    expect(probe.draft.doc.traits).toEqual([{ key: "trait", kind: "MESSAGE", spec: {} }]);
    expect(probe.item).toBe("trait");
    expect(text("trait-kind")).toBe("Message trait");
    expect(box("trait-name").value).toBe("");
    expect(missing("trait-empty")).toBe(true);
    expect(probe.draft.problems).toEqual([]);
  });

  it("adds an operation trait with the operation trait's own fields", () => {
    const { probe } = renderSection(TraitsSection, { doc: sampleDocument(), options: OPTIONS });
    click("trait-add-operation");
    expect(probe.draft.doc.traits).toEqual([{ key: "trait", kind: "OPERATION", spec: {} }]);
    expect(text("trait-kind")).toBe("Operation trait");
    expect(box("trait-title").value).toBe("");
    // an operation trait has no name and no headers
    expect(missing("trait-name")).toBe(true);
    expect(missing("trait-headers")).toBe(true);
    expect(probe.draft.problems).toEqual([]);
  });

  it("gives every new trait its own placeholder key across both kinds, and puts each in its group", () => {
    const { probe } = renderSection(TraitsSection, { doc: sampleDocument(), options: OPTIONS });
    click("trait-add-message");
    click("trait-add-operation");
    click("trait-add-message");
    expect(probe.draft.doc.traits.map((t) => [t.key, t.kind])).toEqual([["trait", "MESSAGE"], ["trait-2", "OPERATION"], ["trait-3", "MESSAGE"]]);
    expect(rowKeys("message")).toEqual(["trait", "trait-3"]);
    expect(rowKeys("operation")).toEqual(["trait-2"]);
    expect(probe.item).toBe("trait-3");
    expect(screen.getByTestId("trait-row-trait-3").getAttribute("aria-current")).toBe("true");
  });

  it("keeps the other traits and the messages that use them when one is added", () => {
    const { probe } = renderSection(TraitsSection, { doc: traitsDoc(), options: OPTIONS });
    click("trait-add-operation");
    expect(probe.draft.doc.traits.map((t) => t.key)).toEqual(["idempotent", "audit", "retry", "trait"]);
    expect(probe.draft.doc.messages[0].traitKeys).toEqual(["idempotent"]);
  });
});

describe("TraitsSection: a local message trait is the whole AsyncAPI message trait template", () => {
  it("shows every property of TEMPLATES.messageTrait: the basics at once, the rest under More properties, headers and bindings drawn by hand", async () => {
    renderSection(TraitsSection, { doc: traitsDoc(), options: OPTIONS, item: "idempotent" });
    click("trait-more-toggle");
    await waitFor(() => expect(missing("trait-headers-loading")).toBe(true));
    const keys = TEMPLATES.messageTrait.fields.map((f) => f.key);
    expect(keys).toEqual(["name", "title", "summary", "description", "contentType", "headers", "correlationId", "examples", "tags", "externalDocs", "deprecated", "bindings"]);
    for (const key of keys) expect(screen.queryByTestId(`trait-${key}`), `trait-${key}`).not.toBeNull();
  });

  it("keeps the 'More properties' group collapsed until asked, and counts what is set in it", () => {
    const doc = traitsDoc();
    doc.traits[0] = { key: "idempotent", kind: "MESSAGE", spec: { name: "Idempotent", deprecated: true } };
    renderSection(TraitsSection, { doc, options: OPTIONS, item: "idempotent" });
    // a field that is set opens the group
    expect(screen.getByTestId("trait-more-toggle").textContent).toContain("1 set");
    expect(screen.getByTestId("trait-deprecated")).toBeDefined();
    cleanup();
    renderSection(TraitsSection, { doc: traitsDoc(), options: OPTIONS, item: "idempotent" });
    expect(screen.getByTestId("trait-more-toggle").getAttribute("aria-expanded")).toBe("false");
    expect(missing("trait-deprecated")).toBe(true);
  });

  it("writes the name, title, summary, description and content type to the spec, and removes a key when it is blanked", () => {
    const { probe } = renderSection(TraitsSection, { doc: traitsDoc(), options: OPTIONS, item: "idempotent" });
    type(box("trait-title"), "Idempotent write");
    type(box("trait-summary"), "Can be sent twice");
    type(box("trait-contentType"), "application/json");
    expect(specOf(probe.draft.doc, "idempotent")).toEqual({
      name: "Idempotent", description: "Safe to retry", title: "Idempotent write", summary: "Can be sent twice", contentType: "application/json",
    });
    type(box("trait-title"), "");
    type(box("trait-summary"), "");
    type(box("trait-contentType"), "");
    type(box("trait-description"), "");
    expect(specOf(probe.draft.doc, "idempotent")).toEqual({ name: "Idempotent" });
    type(box("trait-name"), "");
    expect(specOf(probe.draft.doc, "idempotent")).toEqual({});
    expect(traitOf(probe.draft.doc, "idempotent")).toEqual({ key: "idempotent", kind: "MESSAGE", spec: {} });
    expect(probe.draft.problems).toEqual([]);
  });

  it("sets Deprecated and writes false as a value", () => {
    const { probe } = renderSection(TraitsSection, { doc: traitsDoc(), options: OPTIONS, item: "idempotent" });
    click("trait-more-toggle");
    type(select("trait-deprecated"), "true");
    expect(specOf(probe.draft.doc, "idempotent").deprecated).toBe(true);
    type(select("trait-deprecated"), "false");
    expect(specOf(probe.draft.doc, "idempotent").deprecated).toBe(false);
    type(select("trait-deprecated"), "");
    expect("deprecated" in specOf(probe.draft.doc, "idempotent")).toBe(false);
  });

  it("writes a correlation id, tags and external docs the way the template defines them", () => {
    const { probe } = renderSection(TraitsSection, { doc: traitsDoc(), options: OPTIONS, item: "idempotent" });
    type(box("trait-correlationId-location"), "$message.header#/correlationId");
    click("trait-more-toggle");
    type(box("trait-externalDocs-url"), "https://example.com/docs");
    expect(specOf(probe.draft.doc, "idempotent")).toMatchObject({
      correlationId: { location: "$message.header#/correlationId" }, externalDocs: { url: "https://example.com/docs" },
    });
    expect(probe.draft.problems).toEqual([]);
  });

  it("adds a message example", () => {
    const { probe } = renderSection(TraitsSection, { doc: traitsDoc(), options: OPTIONS, item: "idempotent" });
    click("trait-examples-add");
    type(box("trait-examples-0-name"), "first");
    type(box("trait-examples-0-payload"), '{"orderId":"o-1"}');
    expect(specOf(probe.draft.doc, "idempotent").examples).toEqual([{ name: "first", payload: { orderId: "o-1" } }]);
    expect(probe.draft.problems).toEqual([]);
  });

  it("keeps properties it has no field for (x- extensions, an inline headers schema) untouched when something else is edited", () => {
    const doc = traitsDoc();
    doc.traits[0] = { key: "idempotent", kind: "MESSAGE", spec: { name: "Idempotent", "x-owner": "payments", headers: { type: "object" } } };
    const { probe } = renderSection(TraitsSection, { doc, options: OPTIONS, item: "idempotent" });
    type(box("trait-title"), "T");
    expect(specOf(probe.draft.doc, "idempotent")).toEqual({ name: "Idempotent", "x-owner": "payments", headers: { type: "object" }, title: "T" });
    expect(text("trait-other")).toContain("x-owner");
    expect(text("trait-other")).not.toContain("headers");
  });

  it("shows the parser's problem under the field it points at, once", async () => {
    const doc = traitsDoc();
    doc.traits[0] = { key: "idempotent", kind: "MESSAGE", spec: { name: "Idempotent", externalDocs: { url: "not a url" } } };
    renderSection(TraitsSection, { doc, options: OPTIONS, item: "idempotent" });
    // a field with a value (and a problem) opens the "More properties" group by itself
    const errors = Array.from(document.querySelectorAll("[data-testid^='trait-externalDocs'][data-testid$='-error']"));
    expect(errors.length).toBeGreaterThan(0);
    expect(screen.getByTestId("trait-externalDocs-url").getAttribute("aria-invalid")).toBe("true");
    expect(text("trait-row-idempotent")).toContain("has problems");
  });
});

describe("TraitsSection: a local operation trait is the whole AsyncAPI operation trait template", () => {
  it("shows every property of TEMPLATES.operationTrait, bindings drawn by hand", () => {
    renderSection(TraitsSection, { doc: traitsDoc(), options: OPTIONS, item: "retry" });
    click("trait-more-toggle");
    const keys = TEMPLATES.operationTrait.fields.map((f) => f.key);
    expect(keys).toEqual(["title", "summary", "description", "security", "tags", "externalDocs", "bindings"]);
    for (const key of keys) expect(screen.queryByTestId(`trait-${key}`), `trait-${key}`).not.toBeNull();
  });

  it("writes the title, summary and description to the spec", () => {
    const { probe } = renderSection(TraitsSection, { doc: traitsDoc(), options: OPTIONS, item: "retry" });
    type(box("trait-summary"), "Retry three times");
    type(box("trait-description"), "Backs off between tries");
    expect(specOf(probe.draft.doc, "retry")).toEqual({ title: "Retry", summary: "Retry three times", description: "Backs off between tries" });
  });

  it("lists the document's security schemes and writes the chosen ones to spec.security", () => {
    const doc = traitsDoc();
    doc.components = { securitySchemes: { basic: { type: "http", scheme: "basic" }, oauth: { type: "plain" } } };
    const { probe } = renderSection(TraitsSection, { doc, options: OPTIONS, item: "retry" });
    click("trait-more-toggle");
    click("trait-security-option-oauth");
    click("trait-security-option-basic");
    expect(specOf(probe.draft.doc, "retry").security).toEqual(["oauth", "basic"]);
    click("trait-security-option-oauth");
    expect(specOf(probe.draft.doc, "retry").security).toEqual(["basic"]);
    click("trait-security-option-basic");
    expect("security" in specOf(probe.draft.doc, "retry")).toBe(false);
    expect(probe.draft.problems).toEqual([]);
  });

  it("says that no security schemes are defined yet when the document has none", () => {
    renderSection(TraitsSection, { doc: traitsDoc(), options: OPTIONS, item: "retry" });
    click("trait-more-toggle");
    expect(text("trait-security-empty")).toContain("No security schemes");
  });
});

describe("TraitsSection: headers entity of a message trait", () => {
  it("shows an optional headers entity picker under a message trait and none under an operation trait", async () => {
    renderSection(TraitsSection, { doc: traitsDoc(), options: OPTIONS, item: "idempotent" });
    expect(await screen.findByTestId("trait-headers-picker")).toBeDefined();
    expect(screen.getByLabelText("Headers entity")).toBeDefined();
    cleanup();
    renderSection(TraitsSection, { doc: traitsDoc(), options: OPTIONS, item: "retry" });
    expect(missing("trait-headers")).toBe(true);
    expect(missing("trait-headers-picker")).toBe(true);
  });

  it("pins the chosen entity to trait.headers, not to spec.headers, and unpins it again", async () => {
    const { probe } = renderSection(TraitsSection, { doc: traitsDoc(), options: OPTIONS, item: "idempotent" });
    await screen.findByTestId("trait-headers-picker");
    type(screen.getByLabelText("Headers entity"), "ent-2");
    expect(traitOf(probe.draft.doc, "idempotent")).toMatchObject({ headers: { entityId: "ent-2", entityVersionId: "ver-2" } });
    expect("headers" in specOf(probe.draft.doc, "idempotent")).toBe(false);
    type(screen.getByLabelText("Headers entity"), "");
    expect("headers" in traitOf(probe.draft.doc, "idempotent")).toBe(false);
    expect(specOf(probe.draft.doc, "idempotent")).toEqual({ name: "Idempotent", description: "Safe to retry" });
  });

  it("shows a stored headers pin and keeps it when the spec is edited", async () => {
    const doc = traitsDoc();
    doc.traits[0] = { key: "idempotent", kind: "MESSAGE", spec: { name: "Idempotent" }, headers: { entityId: "ent-1", entityVersionId: "ver-1" } };
    const { probe } = renderSection(TraitsSection, { doc, options: OPTIONS, item: "idempotent" });
    await screen.findByTestId("trait-headers-picker");
    expect((screen.getByLabelText("Headers entity") as HTMLSelectElement).value).toBe("ent-1");
    type(box("trait-title"), "Title");
    expect(traitOf(probe.draft.doc, "idempotent")).toMatchObject({ headers: { entityId: "ent-1", entityVersionId: "ver-1" } });
  });

  it("shows the parser's problem for a headers pin under the picker", async () => {
    const doc = traitsDoc();
    doc.traits[0] = { key: "idempotent", kind: "MESSAGE", spec: { name: "Idempotent" }, headers: { entityId: "", entityVersionId: null } };
    renderSection(TraitsSection, { doc, options: OPTIONS, item: "idempotent" });
    await screen.findByTestId("trait-headers-picker");
    expect(screen.getByTestId("trait-headers-error").textContent).toBeTruthy();
  });
});

describe("TraitsSection: protocol bindings", () => {
  it("writes a message trait's binding fields with the binding version, and drops spec.bindings when the last field is cleared", () => {
    const { probe } = renderSection(TraitsSection, { doc: traitsDoc(), options: OPTIONS, item: "idempotent" });
    type(box("trait-bindings-protocol"), "kafka");
    click("trait-bindings-add");
    type(select("trait-bindings-kafka-schemaIdLocation"), "payload");
    expect(specOf(probe.draft.doc, "idempotent").bindings).toEqual({ kafka: { schemaIdLocation: "payload", bindingVersion: bindingVersion("kafka", "message") } });
    expect(probe.draft.problems).toEqual([]);
    type(select("trait-bindings-kafka-schemaIdLocation"), "");
    expect("bindings" in specOf(probe.draft.doc, "idempotent")).toBe(false);
  });

  it("uses the operation binding templates for an operation trait", () => {
    const { probe } = renderSection(TraitsSection, { doc: traitsDoc(), options: OPTIONS, item: "retry" });
    type(box("trait-bindings-protocol"), "kafka");
    click("trait-bindings-add");
    type(box("trait-bindings-kafka-groupId"), '{"type":"string","enum":["checkout"]}');
    expect(specOf(probe.draft.doc, "retry").bindings).toEqual({
      kafka: { groupId: { type: "string", enum: ["checkout"] }, bindingVersion: bindingVersion("kafka", "operation") },
    });
  });

  it("shows the bindings a trait already has and keeps them when something else is edited", () => {
    const doc = traitsDoc();
    doc.traits[0] = { key: "idempotent", kind: "MESSAGE", spec: { name: "Idempotent", bindings: { kafka: { schemaIdLocation: "header", bindingVersion: "0.5.0" } } } };
    const { probe } = renderSection(TraitsSection, { doc, options: OPTIONS, item: "idempotent" });
    expect(select("trait-bindings-kafka-schemaIdLocation").value).toBe("header");
    type(box("trait-title"), "T");
    expect(specOf(probe.draft.doc, "idempotent").bindings).toEqual({ kafka: { schemaIdLocation: "header", bindingVersion: "0.5.0" } });
  });
});

describe("TraitsSection: the key is generated, then renamed on request", () => {
  it("names a new message trait from its name when focus leaves the form, and follows the rename in the list and the URL item", () => {
    const { probe } = renderSection(TraitsSection, { doc: sampleDocument(), options: OPTIONS });
    click("trait-add-message");
    type(box("trait-name"), "Idempotent writes");
    // typing never renames under the user's hands
    expect(probe.draft.doc.traits[0].key).toBe("trait");
    fireEvent.blur(box("trait-name"));
    expect(probe.draft.doc.traits[0].key).toBe("Idempotent-writes");
    expect(probe.item).toBe("Idempotent-writes");
    expect(text("trait-key-value")).toBe("Idempotent-writes");
    expect(screen.getByTestId("trait-row-Idempotent-writes").getAttribute("aria-current")).toBe("true");
  });

  it("names an operation trait from its title", () => {
    const { probe } = renderSection(TraitsSection, { doc: sampleDocument(), options: OPTIONS });
    click("trait-add-operation");
    type(box("trait-title"), "Retry policy");
    fireEvent.blur(box("trait-title"));
    expect(probe.draft.doc.traits[0].key).toBe("Retry-policy");
    expect(probe.item).toBe("Retry-policy");
  });

  it("prefers the name over the title for a message trait, whichever was typed first", () => {
    const { probe } = renderSection(TraitsSection, { doc: sampleDocument(), options: OPTIONS });
    click("trait-add-message");
    type(box("trait-title"), "A title");
    fireEvent.blur(box("trait-title"), { relatedTarget: box("trait-name") });
    expect(probe.draft.doc.traits[0].key).toBe("trait");
    type(box("trait-name"), "TheName");
    fireEvent.blur(box("trait-name"));
    expect(probe.draft.doc.traits[0].key).toBe("TheName");
  });

  it("does not rename while focus only moves between the form's own fields", () => {
    const { probe } = renderSection(TraitsSection, { doc: sampleDocument(), options: OPTIONS });
    click("trait-add-message");
    type(box("trait-name"), "Idempotent");
    fireEvent.blur(box("trait-name"), { relatedTarget: box("trait-title") });
    expect(probe.draft.doc.traits[0].key).toBe("trait");
  });

  it("keeps the placeholder key while there is nothing to name the trait by", () => {
    const { probe } = renderSection(TraitsSection, { doc: sampleDocument(), options: OPTIONS });
    click("trait-add-message");
    fireEvent.blur(box("trait-name"));
    expect(probe.draft.doc.traits[0].key).toBe("trait");
  });

  it("gives two traits with the same name distinct keys, across both kinds", () => {
    const { probe } = renderSection(TraitsSection, { doc: sampleDocument(), options: OPTIONS });
    click("trait-add-message");
    type(box("trait-name"), "Retry");
    fireEvent.blur(box("trait-name"));
    click("trait-add-operation");
    type(box("trait-title"), "Retry");
    fireEvent.blur(box("trait-title"));
    expect(probe.draft.doc.traits.map((t) => t.key)).toEqual(["Retry", "Retry-2"]);
    expect(parseEventDocument(probe.draft.doc).success).toBe(true);
  });

  it("never renames a trait that already has a real key when its name changes", () => {
    const { probe } = renderSection(TraitsSection, { doc: traitsDoc(), options: OPTIONS, item: "idempotent" });
    type(box("trait-name"), "Something else");
    fireEvent.blur(box("trait-name"));
    expect(probe.draft.doc.traits[0].key).toBe("idempotent");
  });

  it("renames the key naming the traits' users too: messages and operations follow the new key", () => {
    const doc = traitsDoc();
    doc.operations[0] = { ...doc.operations[0], traitKeys: ["retry"] };
    doc.messages.push({ key: "OrderUpdated", payload: doc.messages[0].payload, traitKeys: ["idempotent", "audit"] });
    const { probe } = renderSection(TraitsSection, { doc, options: OPTIONS, item: "idempotent" });
    click("trait-key-toggle");
    type(box("trait-key"), "idem");
    fireEvent.blur(box("trait-key"));
    expect(probe.draft.doc.traits.map((t) => t.key)).toEqual(["idem", "audit", "retry"]);
    expect(probe.draft.doc.messages.map((m) => m.traitKeys)).toEqual([["idem"], ["idem", "audit"]]);
    expect(probe.item).toBe("idem");
    expect(parseEventDocument(probe.draft.doc).success).toBe(true);
    // an operation trait's rename rewrites the operations
    click("trait-row-retry");
    click("trait-key-toggle");
    type(box("trait-key"), "again");
    fireEvent.blur(box("trait-key"));
    expect(probe.draft.doc.operations[0].traitKeys).toEqual(["again"]);
    expect(parseEventDocument(probe.draft.doc).success).toBe(true);
  });

  it("refuses a key another trait already has, of either kind, and keeps the old key", () => {
    const { probe } = renderSection(TraitsSection, { doc: traitsDoc(), options: OPTIONS, item: "idempotent" });
    click("trait-key-toggle");
    type(box("trait-key"), "retry");
    expect(text("trait-key-error")).toBe('The key "retry" is already used.');
    fireEvent.blur(box("trait-key"));
    expect(probe.draft.doc.traits[0].key).toBe("idempotent");
  });

  it("refuses a key with a space, and puts the old key back on Escape", () => {
    const { probe } = renderSection(TraitsSection, { doc: traitsDoc(), options: OPTIONS, item: "idempotent" });
    click("trait-key-toggle");
    type(box("trait-key"), "has space");
    expect(text("trait-key-error")).toContain("no spaces");
    fireEvent.keyDown(box("trait-key"), { key: "Escape" });
    expect(box("trait-key").value).toBe("idempotent");
    expect(probe.draft.doc.traits[0].key).toBe("idempotent");
  });

  it("keeps the identifier collapsed by default, with the key readable on the summary", () => {
    renderSection(TraitsSection, { doc: traitsDoc(), options: OPTIONS, item: "idempotent" });
    expect((screen.getByTestId("trait-key-disclosure") as HTMLDetailsElement).open).toBe(false);
    expect(text("trait-key-value")).toBe("idempotent");
  });

  it("opens the identifier and shows the parser's message when the document reports a problem with the key", () => {
    const doc = traitsDoc();
    doc.traits.push({ key: "has space", kind: "MESSAGE", spec: {} });
    renderSection(TraitsSection, { doc, options: OPTIONS, item: "has space" });
    expect((screen.getByTestId("trait-key-disclosure") as HTMLDetailsElement).open).toBe(true);
    expect(text("trait-key-error")).toContain('may only contain letters');
  });
});

describe("TraitsSection: used by", () => {
  it("shows how many messages use a local message trait", () => {
    const doc = traitsDoc();
    doc.messages.push({ key: "OrderUpdated", payload: doc.messages[0].payload, traitKeys: ["idempotent"] });
    renderSection(TraitsSection, { doc, options: OPTIONS, item: "idempotent" });
    expect(text("trait-usage")).toBe("Used by 2 messages");
    expect(screen.getByTestId("trait-usage").getAttribute("title")).toBe("OrderCreated, OrderUpdated");
  });

  it("shows how many operations use an operation trait, and zero when none does", () => {
    const doc = traitsDoc();
    renderSection(TraitsSection, { doc, options: OPTIONS, item: "retry" });
    expect(text("trait-usage")).toBe("Used by 0 operations");
    cleanup();
    doc.operations[0] = { ...doc.operations[0], traitKeys: ["retry"] };
    renderSection(TraitsSection, { doc, options: OPTIONS, item: "retry" });
    expect(text("trait-usage")).toBe("Used by 1 operation");
  });

  it("shows the same count on a library trait", () => {
    const doc = traitsDoc();
    doc.messages[0] = { ...doc.messages[0], traitKeys: ["audit"] };
    renderSection(TraitsSection, { doc, options: OPTIONS, item: "audit" });
    expect(text("trait-usage")).toBe("Used by 1 message");
  });

  it("follows an edit made elsewhere in the document", () => {
    const { probe } = renderSection(TraitsSection, { doc: traitsDoc(), options: OPTIONS, item: "retry" });
    expect(text("trait-usage")).toBe("Used by 0 operations");
    act(() => probe.draft.update((d) => ({ ...d, operations: d.operations.map((o) => ({ ...o, traitKeys: ["retry"] })) })));
    expect(text("trait-usage")).toBe("Used by 1 operation");
  });
});

describe("TraitsSection: removing", () => {
  it("removes a trait nothing uses without asking, and selects the first remaining trait", () => {
    const confirm = vi.spyOn(window, "confirm").mockReturnValue(true);
    const { probe } = renderSection(TraitsSection, { doc: traitsDoc(), options: OPTIONS, item: "retry" });
    click("trait-remove");
    expect(confirm).not.toHaveBeenCalled();
    expect(probe.draft.doc.traits.map((t) => t.key)).toEqual(["idempotent", "audit"]);
    expect(probe.item).toBeNull();
    expect(box("trait-name").value).toBe("Idempotent");
    expect(text("trait-group-operation-empty")).toBe("None yet.");
  });

  it("asks before removing a trait that messages use, then takes it off every message", () => {
    const confirm = vi.spyOn(window, "confirm").mockReturnValue(true);
    const doc = traitsDoc();
    doc.messages.push({ key: "OrderUpdated", payload: doc.messages[0].payload, traitKeys: ["idempotent", "audit"] });
    const { probe } = renderSection(TraitsSection, { doc, options: OPTIONS, item: "idempotent" });
    click("trait-remove");
    expect(confirm).toHaveBeenCalledTimes(1);
    expect(confirm.mock.calls[0][0]).toContain('"Idempotent"');
    expect(confirm.mock.calls[0][0]).toContain("2 messages");
    expect(confirm.mock.calls[0][0]).toContain("OrderCreated, OrderUpdated");
    expect(probe.draft.doc.traits.map((t) => t.key)).toEqual(["audit", "retry"]);
    expect(probe.draft.doc.messages.map((m) => m.traitKeys)).toEqual([[], ["audit"]]);
    expect(parseEventDocument(probe.draft.doc).success).toBe(true);
  });

  it("asks before removing an operation trait that operations use, then takes it off every operation", () => {
    const confirm = vi.spyOn(window, "confirm").mockReturnValue(true);
    const doc = traitsDoc();
    doc.operations[0] = { ...doc.operations[0], traitKeys: ["retry"] };
    const { probe } = renderSection(TraitsSection, { doc, options: OPTIONS, item: "retry" });
    click("trait-remove");
    expect(confirm.mock.calls[0][0]).toContain("1 operation (publishOrder)");
    expect(probe.draft.doc.traits.map((t) => t.key)).toEqual(["idempotent", "audit"]);
    expect(probe.draft.doc.operations[0].traitKeys).toEqual([]);
    expect(parseEventDocument(probe.draft.doc).success).toBe(true);
  });

  it("changes nothing when the confirmation is declined", () => {
    vi.spyOn(window, "confirm").mockReturnValue(false);
    const { probe } = renderSection(TraitsSection, { doc: traitsDoc(), options: OPTIONS, item: "idempotent" });
    click("trait-remove");
    expect(probe.draft.doc).toEqual(traitsDoc());
    expect(probe.draft.dirty).toBe(false);
  });

  it("removes a library trait the same way, with the same propagation", () => {
    const confirm = vi.spyOn(window, "confirm").mockReturnValue(true);
    const doc = traitsDoc();
    doc.messages[0] = { ...doc.messages[0], traitKeys: ["idempotent", "audit"] };
    const { probe } = renderSection(TraitsSection, { doc, options: OPTIONS, item: "audit" });
    click("trait-remove");
    expect(confirm).toHaveBeenCalledTimes(1);
    expect(confirm.mock.calls[0][0]).toContain('"Audit headers"');
    expect(probe.draft.doc.traits.map((t) => t.key)).toEqual(["idempotent", "retry"]);
    expect(probe.draft.doc.messages[0].traitKeys).toEqual(["idempotent"]);
  });

  it("removing the last trait brings the empty state back", () => {
    const doc = sampleDocument();
    doc.traits = [{ key: "only", kind: "MESSAGE", spec: {} }];
    renderSection(TraitsSection, { doc, options: OPTIONS });
    click("trait-remove");
    expect(text("trait-empty")).toContain("No traits yet");
  });
});

describe("TraitsSection: adding from the library", () => {
  it("offers the library traits in a select grouped by kind, with their level", () => {
    renderSection(TraitsSection, { doc: sampleDocument(), options: OPTIONS });
    const messageGroup = screen.getByTestId("trait-library-group-message");
    const operationGroup = screen.getByTestId("trait-library-group-operation");
    expect(messageGroup.getAttribute("label")).toBe("Message traits");
    expect(operationGroup.getAttribute("label")).toBe("Operation traits");
    expect(optionTexts(messageGroup)).toEqual(["Audit headers · Enterprise", "Tracing · Domain · Payments"]);
    // a trait without a level is listed by its name alone
    expect(optionTexts(operationGroup)).toEqual(["Retry policy · Enterprise", "Dead letter"]);
  });

  it("filters by kind: a message trait is never offered under operation traits, nor the reverse", () => {
    renderSection(TraitsSection, { doc: sampleDocument(), options: OPTIONS });
    const values = (group: string) => Array.from(screen.getByTestId(group).querySelectorAll("option")).map((o) => o.getAttribute("value"));
    expect(values("trait-library-group-message")).toEqual(["lib-msg-1", "lib-msg-2"]);
    expect(values("trait-library-group-operation")).toEqual(["lib-op-1", "lib-op-2"]);
  });

  it("hides the library traits the event already uses", () => {
    renderSection(TraitsSection, { doc: traitsDoc(), options: OPTIONS });
    expect(optionTexts(screen.getByTestId("trait-library-group-message"))).toEqual(["Tracing · Domain · Payments"]);
    expect(optionTexts(screen.getByTestId("trait-library-group-operation"))).toEqual(["Retry policy · Enterprise", "Dead letter"]);
  });

  it("adds the chosen message trait as a library trait with its kind and id, keyed by its name, and selects it", () => {
    const { probe } = renderSection(TraitsSection, { doc: sampleDocument(), options: OPTIONS });
    type(select("trait-library-select"), "lib-msg-2");
    click("trait-add-library");
    expect(probe.draft.doc.traits).toEqual([{ key: "Tracing", kind: "MESSAGE", libraryTraitId: "lib-msg-2" }]);
    expect(probe.item).toBe("Tracing");
    expect(screen.getByTestId("trait-library-form")).toBeDefined();
    expect(text("trait-library-name")).toBe("Tracing");
    expect(rowKeys("message")).toEqual(["Tracing"]);
    expect(parseEventDocument(probe.draft.doc).success).toBe(true);
  });

  it("adds an operation trait from the library under the operation group", () => {
    const { probe } = renderSection(TraitsSection, { doc: sampleDocument(), options: OPTIONS });
    type(select("trait-library-select"), "lib-op-1");
    click("trait-add-library");
    expect(probe.draft.doc.traits).toEqual([{ key: "Retry-policy", kind: "OPERATION", libraryTraitId: "lib-op-1" }]);
    expect(rowKeys("operation")).toEqual(["Retry-policy"]);
    expect(text("trait-row-Retry-policy-library")).toBe("library");
  });

  it("drops the added trait from the select and resets the choice", () => {
    renderSection(TraitsSection, { doc: sampleDocument(), options: OPTIONS });
    type(select("trait-library-select"), "lib-msg-2");
    click("trait-add-library");
    expect(optionTexts(screen.getByTestId("trait-library-group-message"))).toEqual(["Audit headers · Enterprise"]);
    expect(select("trait-library-select").value).toBe("");
    expect(button("trait-add-library").disabled).toBe(true);
  });

  it("keeps the generated key unique among the document's traits", () => {
    const doc = sampleDocument();
    doc.traits = [{ key: "Tracing", kind: "OPERATION", spec: {} }];
    const { probe } = renderSection(TraitsSection, { doc, options: OPTIONS });
    type(select("trait-library-select"), "lib-msg-2");
    click("trait-add-library");
    expect(probe.draft.doc.traits.map((t) => t.key)).toEqual(["Tracing", "Tracing-2"]);
  });

  it("does nothing when no library trait is chosen", () => {
    const { probe } = renderSection(TraitsSection, { doc: sampleDocument(), options: OPTIONS });
    fireEvent.click(button("trait-add-library"));
    expect(probe.draft.doc.traits).toEqual([]);
  });

  it("disables the select and says there is no library yet when the library is empty", () => {
    renderSection(TraitsSection, { doc: sampleDocument(), options: { entityOptions: ENTITY_OPTIONS, libraryTraits: [] } });
    expect(select("trait-library-select").disabled).toBe(true);
    expect(select("trait-library-select").getAttribute("aria-describedby")).toBe("trait-library-empty");
    expect(text("trait-library-empty")).toContain("There are no library traits yet");
    expect(text("trait-library-empty")).toContain("Tenant or Domain level");
    expect(button("trait-add-library").disabled).toBe(true);
  });

  it("says every library trait is used when none is left to add", () => {
    const doc = sampleDocument();
    doc.traits = LIBRARY.map((l) => ({ key: l.id, kind: l.kind, libraryTraitId: l.id }));
    renderSection(TraitsSection, { doc, options: OPTIONS });
    expect(select("trait-library-select").disabled).toBe(true);
    expect(text("trait-library-empty")).toBe("Every library trait is already used by this event.");
  });
});

describe("TraitsSection: a library trait is read-only", () => {
  it("shows its name, kind, level and the note that it is edited where it is defined", () => {
    renderSection(TraitsSection, { doc: traitsDoc(), options: OPTIONS, item: "audit" });
    expect(text("trait-library-name")).toBe("Audit headers");
    expect(text("trait-kind")).toBe("Message trait");
    expect(text("trait-library-kind")).toBe("Message trait");
    expect(text("trait-library-level")).toBe("Enterprise");
    expect(text("trait-library-note")).toBe("Defined in the library — edit it under Traits at the Tenant or Domain level.");
    expect(missing("trait-library-missing")).toBe(true);
  });

  it("shows the level of a domain trait and of one the options carry no level for", () => {
    const doc = sampleDocument();
    doc.traits = [
      { key: "Tracing", kind: "MESSAGE", libraryTraitId: "lib-msg-2" },
      { key: "Dead-letter", kind: "OPERATION", libraryTraitId: "lib-op-2" },
    ];
    renderSection(TraitsSection, { doc, options: OPTIONS, item: "Tracing" });
    expect(text("trait-library-level")).toBe("Domain · Payments");
    click("trait-row-Dead-letter");
    expect(text("trait-library-level")).toBe("Unknown");
    expect(text("trait-library-kind")).toBe("Operation trait");
  });

  it("has no input, no select and no textarea: nothing in it can be edited, only removed", () => {
    renderSection(TraitsSection, { doc: traitsDoc(), options: OPTIONS, item: "audit" });
    const form = screen.getByTestId("trait-library-form");
    expect(form.querySelectorAll("input, select, textarea")).toHaveLength(0);
    expect(within(form).getByRole("button", { name: "Remove trait" })).toBeDefined();
    expect(missing("trait-name")).toBe(true);
    expect(missing("trait-key-disclosure")).toBe(true);
  });

  it("does not touch the document when it is only looked at", () => {
    const { probe } = renderSection(TraitsSection, { doc: traitsDoc(), options: OPTIONS, item: "audit" });
    click("trait-row-retry");
    click("trait-row-audit");
    expect(probe.draft.dirty).toBe(false);
  });

  it("says so when the library trait is no longer offered to this event, and still names it by its key", () => {
    const doc = sampleDocument();
    doc.traits = [{ key: "gone-trait", kind: "MESSAGE", libraryTraitId: "deleted-id" }];
    renderSection(TraitsSection, { doc, options: OPTIONS });
    expect(text("trait-library-name")).toBe("gone-trait");
    expect(text("trait-library-missing")).toContain("not offered to this event any more");
  });

  it("shows the library problem a failed save reported, and offers the identifier only when the key itself has a problem", async () => {
    const saveDocument = vi.fn<SaveDocument>().mockResolvedValue({
      success: false, error: "1 problem(s) in the event document", code: "VALIDATION_ERROR",
      details: { problems: [{ pointer: "/traits/1/libraryTraitId", message: 'Library trait "lib-msg-1" not found' }] },
    });
    renderBuilder({ doc: traitsDoc(), options: OPTIONS, section: "traits", item: "idempotent", saveDocument });
    type(box("trait-title"), "x");
    await act(async () => { fireEvent.click(button("builder-save")); });
    click("trait-row-audit");
    expect(text("trait-library-error")).toBe('Library trait "lib-msg-1" not found');
    expect(text("trait-row-audit")).toContain("has problems");
    expect(missing("trait-key-disclosure")).toBe(true);
  });

  it("opens the identifier of a library trait whose key the document reports a problem on, so the key can be fixed", () => {
    const doc = traitsDoc();
    doc.traits.push({ key: "has space", kind: "MESSAGE", libraryTraitId: "lib-msg-2" });
    const { probe } = renderSection(TraitsSection, { doc, options: OPTIONS, item: "has space" });
    expect((screen.getByTestId("trait-key-disclosure") as HTMLDetailsElement).open).toBe(true);
    expect(text("trait-key-error")).toContain('may only contain letters');
    type(box("trait-key"), "tracing");
    fireEvent.blur(box("trait-key"));
    expect(probe.draft.doc.traits.map((t) => t.key)).toEqual(["idempotent", "audit", "retry", "tracing"]);
    expect(probe.item).toBe("tracing");
    expect(probe.draft.problems).toEqual([]);
  });
});

describe("EventBuilder: the Traits section in the shell", () => {
  it("is the content of the Traits outline node", () => {
    const { probe } = renderBuilder({ doc: traitsDoc(), options: OPTIONS });
    click("outline-traits");
    expect(probe.section).toBe("traits");
    expect(screen.getByTestId("section-traits")).toBeDefined();
    expect(screen.getByTestId("outline-traits").getAttribute("aria-current")).toBe("true");
  });

  it("counts local and library traits on the outline node", () => {
    renderBuilder({ doc: traitsDoc(), options: OPTIONS });
    expect(text("outline-count-traits")).toBe("3");
  });

  it("shows a problem badge on Traits for a problem under /traits, and the count follows the fix", () => {
    const doc = traitsDoc();
    doc.traits[0] = { key: "idempotent", kind: "MESSAGE", spec: { name: "Idempotent", externalDocs: { url: "nope" } } };
    renderBuilder({ doc, options: OPTIONS, section: "traits" });
    expect(screen.getByTestId("outline-problems-traits").textContent).toContain("1");
    // the "More properties" group is open already: a field with a value (and a problem) opens it
    type(box("trait-externalDocs-url"), "https://example.com");
    expect(screen.queryByTestId("outline-problems-traits")).toBeNull();
  });

  it("lists a failed save's trait problems and jumps to the trait", async () => {
    const saveDocument = vi.fn<SaveDocument>().mockResolvedValue({
      success: false, error: "1 problem(s) in the event document", code: "VALIDATION_ERROR",
      details: { problems: [{ pointer: "/traits/2/spec/title", message: "title must be a string" }] },
    });
    const { probe } = renderBuilder({ doc: traitsDoc(), options: OPTIONS, saveDocument });
    type(screen.getByTestId("metadata-title"), "Orders v2");
    await act(async () => { fireEvent.click(button("builder-save")); });
    const alert = within(screen.getByRole("alert"));
    fireEvent.click(alert.getByRole("button", { name: "Traits · retry: title must be a string" }));
    expect(probe.section).toBe("traits");
    expect(probe.item).toBe("retry");
    expect(screen.getByTestId("trait-row-retry").getAttribute("aria-current")).toBe("true");
  });

  it("a trait added here and a document with no other change save together through the shell", async () => {
    const { probe } = renderBuilder({ doc: emptyEventDocument("Orders"), options: OPTIONS, section: "traits" });
    click("trait-add-operation");
    type(box("trait-title"), "Retry");
    fireEvent.blur(box("trait-title"));
    await act(async () => { fireEvent.click(button("builder-save")); });
    expect(probe.saveDocument).toHaveBeenCalledTimes(1);
    expect(probe.saveDocument.mock.calls[0][2]).toMatchObject({ traits: [{ key: "Retry", kind: "OPERATION", spec: { title: "Retry" } }] });
  });
});
