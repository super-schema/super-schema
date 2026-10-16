// @vitest-environment jsdom
import { act, cleanup, fireEvent, screen, waitFor, within } from "@testing-library/react";
import { afterEach, beforeAll, beforeEach, describe, expect, it, vi } from "vitest";
import { SECTION_COMPONENTS, type BuilderOptions, type LibraryTraitOption } from "@/features/events/builder/EventBuilder";
import { PropertiesSection } from "@/features/events/builder/sections/PropertiesSection";
import type { SaveDocument } from "@/features/events/builder/use-event-draft";
import { BUNDLED_TRAITS, propertySummary } from "@/lib/events/bundled-traits";
import { parseEventDocument } from "@/lib/events/document/parse";
import { emptyEventDocument, type DocTrait, type EventDocument } from "@/lib/events/document/types";
import { bindingVersion, TEMPLATES } from "@/lib/events/templates";
import { ENTITY_OPTIONS, renderBuilder, renderSection, sampleDocument } from "./builder-harness";

// The chooser is a popover with a cmdk list: it measures and scrolls, jsdom does neither.
beforeAll(() => {
  globalThis.ResizeObserver ??= class { observe() { /* no layout */ } unobserve() { /* no layout */ } disconnect() { /* no layout */ } } as unknown as typeof ResizeObserver;
  Element.prototype.scrollIntoView ??= () => undefined;
});
beforeEach(() => {
  vi.clearAllMocks();
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
    .map((e) => e.getAttribute("data-testid") as string).filter((id) => !id.endsWith("-library") && !id.endsWith("-badge")).map((id) => id.replace("trait-row-", ""));
const openMore = () => {
  if (screen.getByTestId("trait-more-toggle").getAttribute("aria-expanded") !== "true") click("trait-more-toggle");
};

/** Open the single "+ Add" and pick an item; `kind: "OPERATION"` switches the segmented control first. */
async function choose(itemId: string, kind: "MESSAGE" | "OPERATION" = "MESSAGE") {
  click("trait-add");
  await screen.findByTestId("trait-chooser");
  if (kind === "OPERATION") click("trait-chooser-kind-operation");
  click(`trait-chooser-item-${itemId}`);
  await waitFor(() => expect(missing("trait-chooser")).toBe(true));
}

const CLOUDEVENTS = BUNDLED_TRAITS.find((t) => t.name === "CloudEvents")!;
const LIBRARY: LibraryTraitOption[] = [
  { id: "builtin-ce", name: "CloudEvents", kind: "MESSAGE", bundled: true, level: "Enterprise", spec: CLOUDEVENTS.spec, properties: propertySummary(CLOUDEVENTS.spec) },
  {
    id: "lib-msg-1", name: "Audit headers", kind: "MESSAGE", level: "Enterprise",
    spec: { headers: { type: "object", properties: { actor: { type: "string", description: "Who did it" } }, required: ["actor"] } },
    properties: [{ name: "actor", type: "string", required: true, description: "Who did it" }],
  },
  { id: "lib-msg-2", name: "Tracing", kind: "MESSAGE", level: "Domain · Payments" },
  { id: "lib-op-1", name: "Retry policy", kind: "OPERATION", level: "Enterprise", spec: { title: "Retry policy", summary: "Retries three times", tags: [{ name: "resilience" }] } },
  { id: "lib-op-2", name: "Dead letter", kind: "OPERATION" },
];
const OPTIONS: BuilderOptions = { entityOptions: ENTITY_OPTIONS, libraryTraits: LIBRARY };

/**
 * sampleDocument + three sets: `idempotent` (local, on messages, on OrderCreated), `audit` (library, lib-msg-1) and `retry` (local, on operations,
 * on no operation yet).
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
  expect(SECTION_COMPONENTS.traits).toBe(PropertiesSection);
});

describe("PropertiesSection: names and the single + Add", () => {
  it("is called Message properties with (Trait) in brackets, never 'Traits'", () => {
    renderSection(PropertiesSection, { doc: sampleDocument(), options: OPTIONS });
    expect(screen.getByRole("heading", { level: 2 }).textContent).toBe("Message properties (Trait)");
    expect(document.body.textContent).not.toMatch(/\bTraits?\b(?! *\))/);
  });

  it("shows an empty state and one primary Add button when the document has none", () => {
    renderSection(PropertiesSection, { doc: sampleDocument(), options: OPTIONS });
    expect(text("trait-empty")).toContain("No message properties yet");
    expect(button("trait-add").textContent).toContain("Add");
    expect(missing("trait-form")).toBe(true);
    expect(missing("trait-library-form")).toBe(true);
  });

  it("has no separate buttons for message, operation and library any more, and no library select", () => {
    renderSection(PropertiesSection, { doc: sampleDocument(), options: OPTIONS });
    for (const id of ["trait-add-message", "trait-add-operation", "trait-add-library", "trait-library-select"]) expect(missing(id), id).toBe(true);
    expect(screen.getAllByRole("button", { name: /^Add/ })).toHaveLength(1);
  });

  it("opens the chooser with Applies to, a search box and the Built in, Library and New (blank) groups", async () => {
    renderSection(PropertiesSection, { doc: sampleDocument(), options: OPTIONS });
    click("trait-add");
    await screen.findByTestId("trait-chooser");
    expect(within(screen.getByTestId("trait-chooser-kind")).getAllByRole("radio").map((r) => r.textContent)).toEqual(["Message", "Operation"]);
    expect(screen.getByTestId("trait-chooser-search")).toBeDefined();
    expect(screen.getByTestId("trait-chooser-item-builtin-ce").textContent).toContain("CloudEvents — 8 properties");
    expect(within(screen.getByTestId("trait-chooser-group-library")).getAllByRole("option").map((o) => o.textContent)).toEqual([
      "Audit headers — 1 propertyEnterprise", "TracingDomain · Payments",
    ]);
    expect(screen.getByTestId("trait-chooser-item-new").textContent).toContain("New message properties");
  });
});

describe("PropertiesSection: list, groups and selection", () => {
  it("lists the sets in two groups, On messages and On operations, in document order", () => {
    renderSection(PropertiesSection, { doc: traitsDoc(), options: OPTIONS });
    expect(within(screen.getByTestId("trait-group-message")).getByRole("heading", { name: "On messages" })).toBeDefined();
    expect(within(screen.getByTestId("trait-group-operation")).getByRole("heading", { name: "On operations" })).toBeDefined();
    expect(rowKeys("message")).toEqual(["idempotent", "audit"]);
    expect(rowKeys("operation")).toEqual(["retry"]);
  });

  it("shows a name or title in the list, the library set's own name, and not the generated key", () => {
    renderSection(PropertiesSection, { doc: traitsDoc(), options: OPTIONS });
    expect(text("trait-row-idempotent")).toContain("Idempotent");
    expect(text("trait-row-retry")).toContain("Retry");
    expect(text("trait-row-audit")).toContain("Audit headers");
    expect(text("trait-row-audit")).not.toContain("audit ");
  });

  it("falls back to 'New message properties' / 'New operation properties' for a set with no name yet, and to the key once it has been renamed", () => {
    const doc = sampleDocument();
    doc.traits = [
      { key: "trait", kind: "MESSAGE", spec: {} },
      { key: "trait-2", kind: "OPERATION", spec: {} },
      { key: "custom-key", kind: "OPERATION", spec: {} },
    ];
    renderSection(PropertiesSection, { doc, options: OPTIONS });
    expect(text("trait-row-trait")).toContain("New message properties");
    expect(text("trait-row-trait-2")).toContain("New operation properties");
    expect(text("trait-row-custom-key")).toContain("custom-key");
  });

  it("puts the 'Trait' badge on every row and a lock with 'Library' or 'Built in' on the library ones only", () => {
    const doc = traitsDoc();
    doc.traits.push({ key: "ce", kind: "MESSAGE", libraryTraitId: "builtin-ce" });
    renderSection(PropertiesSection, { doc, options: OPTIONS });
    for (const key of ["idempotent", "audit", "retry", "ce"]) expect(text(`trait-row-${key}-badge`)).toBe("Trait");
    expect(text("trait-row-audit-library")).toBe("Library");
    expect(text("trait-row-ce-library")).toBe("Built in");
    expect(screen.getByTestId("trait-row-ce-library").querySelector("svg")).not.toBeNull();
    expect(missing("trait-row-idempotent-library")).toBe(true);
    expect(missing("trait-row-retry-library")).toBe(true);
  });

  it("shows how many messages or operations use each set, and how many properties it brings", () => {
    const doc = traitsDoc();
    doc.operations[0] = { ...doc.operations[0], traitKeys: ["retry"] };
    doc.traits.push({ key: "ce", kind: "MESSAGE", libraryTraitId: "builtin-ce" });
    renderSection(PropertiesSection, { doc, options: OPTIONS });
    expect(text("trait-row-idempotent")).toContain("Used by 1 message");
    expect(text("trait-row-audit")).toContain("Used by 0 messages · 1 property");
    expect(text("trait-row-retry")).toContain("Used by 1 operation");
    expect(text("trait-row-ce")).toContain("8 properties");
  });

  it("says 'None yet.' for a group without sets", () => {
    const doc = sampleDocument();
    doc.traits = [{ key: "idempotent", kind: "MESSAGE", spec: {} }];
    renderSection(PropertiesSection, { doc, options: OPTIONS });
    expect(text("trait-group-operation-empty")).toBe("None yet.");
    expect(missing("trait-group-message-empty")).toBe(true);
  });

  it("opens the first set's form and selects another on click, local or library", () => {
    renderSection(PropertiesSection, { doc: traitsDoc(), options: OPTIONS });
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

  it("opens the set named by the selected item and falls back to the first when it is gone", () => {
    renderSection(PropertiesSection, { doc: traitsDoc(), options: OPTIONS, item: "retry" });
    expect(box("trait-title").value).toBe("Retry");
    cleanup();
    renderSection(PropertiesSection, { doc: traitsDoc(), options: OPTIONS, item: "gone" });
    expect(box("trait-name").value).toBe("Idempotent");
  });

  it("shows a problem dot on the row of a set the document reports a problem on", () => {
    const doc = traitsDoc();
    doc.traits[2] = { key: "retry", kind: "OPERATION", spec: { security: ["nowhere"] } };
    doc.components = { securitySchemes: { basic: { type: "http", scheme: "basic" } } };
    renderSection(PropertiesSection, { doc, options: OPTIONS });
    expect(text("trait-row-retry")).toContain("has problems");
    expect(text("trait-row-idempotent")).not.toContain("has problems");
  });
});

describe("PropertiesSection: adding with the chooser", () => {
  it("adds a built-in set at once as a library entry under a key from its name, and selects it read-only", async () => {
    const { probe } = renderSection(PropertiesSection, { doc: sampleDocument(), options: OPTIONS });
    await choose("builtin-ce");
    expect(probe.draft.doc.traits).toEqual([{ key: "CloudEvents", kind: "MESSAGE", libraryTraitId: "builtin-ce" }]);
    expect(probe.item).toBe("CloudEvents");
    expect(screen.getByTestId("trait-library-form")).toBeDefined();
    expect(text("trait-library-name")).toBe("CloudEvents");
    expect(text("trait-row-CloudEvents-library")).toBe("Built in");
    expect(parseEventDocument(probe.draft.doc).success).toBe(true);
    expect(missing("trait-empty")).toBe(true);
  });

  it("adds a library set of the message kind and one of the operation kind under their own groups", async () => {
    const { probe } = renderSection(PropertiesSection, { doc: sampleDocument(), options: OPTIONS });
    await choose("lib-msg-2");
    await choose("lib-op-1", "OPERATION");
    expect(probe.draft.doc.traits).toEqual([
      { key: "Tracing", kind: "MESSAGE", libraryTraitId: "lib-msg-2" },
      { key: "Retry-policy", kind: "OPERATION", libraryTraitId: "lib-op-1" },
    ]);
    expect(rowKeys("message")).toEqual(["Tracing"]);
    expect(rowKeys("operation")).toEqual(["Retry-policy"]);
    expect(probe.item).toBe("Retry-policy");
  });

  it("reuses the entry when the event already uses that library set: no second entry, and it is selected", async () => {
    const { probe } = renderSection(PropertiesSection, { doc: traitsDoc(), options: OPTIONS, item: "retry" });
    click("trait-add");
    await screen.findByTestId("trait-chooser");
    expect(text("trait-chooser-item-lib-msg-1-state")).toBe("In this event");
    click("trait-chooser-item-lib-msg-1");
    await waitFor(() => expect(missing("trait-chooser")).toBe(true));
    expect(probe.draft.doc.traits.map((t) => t.key)).toEqual(["idempotent", "audit", "retry"]);
    expect(probe.item).toBe("audit");
    expect(probe.draft.dirty).toBe(false);
  });

  it("keeps the generated key unique among the document's trait keys", async () => {
    const doc = sampleDocument();
    doc.traits = [{ key: "Tracing", kind: "OPERATION", spec: {} }];
    const { probe } = renderSection(PropertiesSection, { doc, options: OPTIONS });
    await choose("lib-msg-2");
    expect(probe.draft.doc.traits.map((t) => t.key)).toEqual(["Tracing", "Tracing-2"]);
  });

  it("adds a blank message set under a placeholder key, selects it and puts the focus in its name", async () => {
    const { probe } = renderSection(PropertiesSection, { doc: sampleDocument(), options: OPTIONS });
    await choose("new");
    expect(probe.draft.doc.traits).toEqual([{ key: "trait", kind: "MESSAGE", spec: {} }]);
    expect(probe.item).toBe("trait");
    expect(text("trait-kind")).toBe("Message properties (Trait)");
    expect(box("trait-name").value).toBe("");
    await waitFor(() => expect(document.activeElement).toBe(box("trait-name")));
    expect(probe.draft.problems).toEqual([]);
  });

  it("adds a blank operation set with the operation fields and focuses its title", async () => {
    const { probe } = renderSection(PropertiesSection, { doc: sampleDocument(), options: OPTIONS });
    await choose("new", "OPERATION");
    expect(probe.draft.doc.traits).toEqual([{ key: "trait", kind: "OPERATION", spec: {} }]);
    expect(text("trait-kind")).toBe("Operation properties (Trait)");
    expect(missing("trait-name")).toBe(true);
    await waitFor(() => expect(document.activeElement).toBe(box("trait-title")));
  });

  it("does not steal the focus again when a set is only selected later", async () => {
    renderSection(PropertiesSection, { doc: traitsDoc(), options: OPTIONS });
    await choose("new");
    await waitFor(() => expect(document.activeElement).toBe(box("trait-name")));
    click("trait-row-idempotent");
    click("trait-row-trait");
    expect(box("trait-name").value).toBe("");
    expect(document.activeElement).not.toBe(box("trait-name"));
  });

  it("gives every blank set its own placeholder key across both kinds and puts each in its group", async () => {
    const { probe } = renderSection(PropertiesSection, { doc: sampleDocument(), options: OPTIONS });
    await choose("new");
    await choose("new", "OPERATION");
    await choose("new");
    expect(probe.draft.doc.traits.map((t) => [t.key, t.kind])).toEqual([["trait", "MESSAGE"], ["trait-2", "OPERATION"], ["trait-3", "MESSAGE"]]);
    expect(rowKeys("message")).toEqual(["trait", "trait-3"]);
    expect(rowKeys("operation")).toEqual(["trait-2"]);
    expect(probe.item).toBe("trait-3");
  });

  it("keeps the other sets and the messages that use them when one is added", async () => {
    const { probe } = renderSection(PropertiesSection, { doc: traitsDoc(), options: OPTIONS });
    await choose("new", "OPERATION");
    expect(probe.draft.doc.traits.map((t) => t.key)).toEqual(["idempotent", "audit", "retry", "trait"]);
    expect(probe.draft.doc.messages[0].traitKeys).toEqual(["idempotent"]);
  });

  it("still offers the blank item and the built-in set when the library has nothing else", async () => {
    renderSection(PropertiesSection, { doc: sampleDocument(), options: { entityOptions: ENTITY_OPTIONS, libraryTraits: [LIBRARY[0]] } });
    click("trait-add");
    await screen.findByTestId("trait-chooser");
    expect(screen.getByTestId("trait-chooser-item-builtin-ce")).toBeDefined();
    expect(missing("trait-chooser-group-library")).toBe(true);
    expect(screen.getByTestId("trait-chooser-item-new")).toBeDefined();
  });
});

describe("PropertiesSection: a local message set is a Properties table and More details", () => {
  it("shows the name and the Properties table up front, and the other fields under a collapsed 'More details' with a count", () => {
    renderSection(PropertiesSection, { doc: traitsDoc(), options: OPTIONS, item: "idempotent" });
    expect(box("trait-name").value).toBe("Idempotent");
    expect(screen.getByTestId("trait-props-add")).toBeDefined();
    expect(screen.getByTestId("trait-more-toggle").getAttribute("aria-expanded")).toBe("false");
    expect(text("trait-more-count")).toBe("1");
    expect(missing("trait-more")).toBe(true);
    for (const key of ["title", "summary", "description", "contentType", "correlationId", "examples", "tags", "externalDocs", "deprecated"]) {
      expect(missing(`trait-${key}`) && missing(`trait-${key}-location`), key).toBe(true);
    }
  });

  it("has no headers entity picker any more", () => {
    renderSection(PropertiesSection, { doc: traitsDoc(), options: OPTIONS, item: "idempotent" });
    expect(missing("trait-headers")).toBe(true);
    expect(missing("trait-headers-picker")).toBe(true);
    expect(screen.queryByLabelText("Headers entity")).toBeNull();
  });

  it("every field of TEMPLATES.messageTrait stays reachable: name up front, headers as the table, the rest and the bindings inside More details", () => {
    renderSection(PropertiesSection, { doc: traitsDoc(), options: OPTIONS, item: "idempotent" });
    openMore();
    const keys = TEMPLATES.messageTrait.fields.map((f) => f.key);
    expect(keys).toEqual(["name", "title", "summary", "description", "contentType", "headers", "correlationId", "examples", "tags", "externalDocs", "deprecated", "bindings"]);
    const testIdOf: Record<string, string> = { headers: "trait-props-add", bindings: "trait-bindings", correlationId: "trait-correlationId" };
    for (const key of keys) expect(screen.queryByTestId(testIdOf[key] ?? `trait-${key}`), `trait-${key}`).not.toBeNull();
  });

  it("counts the fields set under More details, and opens them when one has a problem", () => {
    const doc = traitsDoc();
    doc.traits[0] = { key: "idempotent", kind: "MESSAGE", spec: { name: "Idempotent", deprecated: true, summary: "S", externalDocs: { url: "not a url" } } };
    renderSection(PropertiesSection, { doc, options: OPTIONS, item: "idempotent" });
    expect(text("trait-more-count")).toBe("3");
    expect(screen.getByTestId("trait-more-toggle").getAttribute("aria-expanded")).toBe("true");
    expect(box("trait-externalDocs-url").getAttribute("aria-invalid")).toBe("true");
  });

  it("writes the name and the other basics to the spec, and removes a key when it is blanked", () => {
    const { probe } = renderSection(PropertiesSection, { doc: traitsDoc(), options: OPTIONS, item: "idempotent" });
    openMore();
    type(box("trait-title"), "Idempotent write");
    type(box("trait-summary"), "Can be sent twice");
    type(box("trait-contentType"), "application/json");
    expect(specOf(probe.draft.doc, "idempotent")).toEqual({
      name: "Idempotent", description: "Safe to retry", title: "Idempotent write", summary: "Can be sent twice", contentType: "application/json",
    });
    for (const id of ["title", "summary", "contentType", "description", "name"]) type(box(`trait-${id}`), "");
    expect(traitOf(probe.draft.doc, "idempotent")).toEqual({ key: "idempotent", kind: "MESSAGE", spec: {} });
    expect(probe.draft.problems).toEqual([]);
  });

  it("sets Deprecated and writes false as a value", () => {
    const { probe } = renderSection(PropertiesSection, { doc: traitsDoc(), options: OPTIONS, item: "idempotent" });
    openMore();
    type(select("trait-deprecated"), "true");
    expect(specOf(probe.draft.doc, "idempotent").deprecated).toBe(true);
    type(select("trait-deprecated"), "false");
    expect(specOf(probe.draft.doc, "idempotent").deprecated).toBe(false);
    type(select("trait-deprecated"), "");
    expect("deprecated" in specOf(probe.draft.doc, "idempotent")).toBe(false);
  });

  it("writes a correlation id, tags, external docs and an example the way the template defines them", () => {
    const { probe } = renderSection(PropertiesSection, { doc: traitsDoc(), options: OPTIONS, item: "idempotent" });
    openMore();
    type(box("trait-correlationId-location"), "$message.header#/correlationId");
    type(box("trait-externalDocs-url"), "https://example.com/docs");
    click("trait-examples-add");
    type(box("trait-examples-0-name"), "first");
    type(box("trait-examples-0-payload"), '{"orderId":"o-1"}');
    expect(specOf(probe.draft.doc, "idempotent")).toMatchObject({
      correlationId: { location: "$message.header#/correlationId" }, externalDocs: { url: "https://example.com/docs" },
      examples: [{ name: "first", payload: { orderId: "o-1" } }],
    });
    expect(probe.draft.problems).toEqual([]);
  });

  it("keeps properties it has no field for (x- extensions) untouched, names them under More details, and keeps the inline headers", () => {
    const doc = traitsDoc();
    const headers = { type: "object", properties: { id: { type: "string" } } };
    doc.traits[0] = { key: "idempotent", kind: "MESSAGE", spec: { name: "Idempotent", "x-owner": "payments", headers } };
    const { probe } = renderSection(PropertiesSection, { doc, options: OPTIONS, item: "idempotent" });
    openMore();
    type(box("trait-title"), "T");
    expect(specOf(probe.draft.doc, "idempotent")).toEqual({ name: "Idempotent", "x-owner": "payments", headers, title: "T" });
    expect(text("trait-other")).toContain("x-owner");
    expect(text("trait-other")).not.toContain("headers");
  });

  it("shows the parser's problem under the field it points at, once, and on the row", () => {
    const doc = traitsDoc();
    doc.traits[0] = { key: "idempotent", kind: "MESSAGE", spec: { name: "Idempotent", externalDocs: { url: "not a url" } } };
    renderSection(PropertiesSection, { doc, options: OPTIONS, item: "idempotent" });
    const errors = Array.from(document.querySelectorAll("[data-testid^='trait-externalDocs'][data-testid$='-error']"));
    expect(errors.length).toBeGreaterThan(0);
    expect(box("trait-externalDocs-url").getAttribute("aria-invalid")).toBe("true");
    expect(text("trait-row-idempotent")).toContain("has problems");
  });

  it("keeps the optional-field help as an info tooltip and reads it through aria-describedby", () => {
    renderSection(PropertiesSection, { doc: traitsDoc(), options: OPTIONS, item: "idempotent" });
    openMore();
    expect(screen.getByTestId("trait-summary-hint-button").getAttribute("aria-describedby")).toBe("trait-summary-hint");
  });
});

describe("PropertiesSection: the Properties table of a local set", () => {
  it("adds a property and writes spec.headers as an object schema; removing the last one removes `headers`", () => {
    const { probe } = renderSection(PropertiesSection, { doc: traitsDoc(), options: OPTIONS, item: "idempotent" });
    click("trait-props-add");
    type(box("trait-props-name-0"), "correlationId");
    fireEvent.click(box("trait-props-required-0"));
    type(box("trait-props-description-0"), "Ties a request to its reply");
    expect(specOf(probe.draft.doc, "idempotent").headers).toEqual({
      type: "object", properties: { correlationId: { type: "string", description: "Ties a request to its reply" } }, required: ["correlationId"],
    });
    expect(specOf(probe.draft.doc, "idempotent")).toMatchObject({ name: "Idempotent", description: "Safe to retry" });
    expect(probe.draft.problems).toEqual([]);
    click("trait-props-remove-0");
    expect("headers" in specOf(probe.draft.doc, "idempotent")).toBe(false);
  });

  it("shows the stored properties, preserves what the table does not understand, and keeps them through a save", () => {
    const doc = traitsDoc();
    doc.traits[0] = {
      key: "idempotent", kind: "MESSAGE",
      spec: { name: "Idempotent", headers: { type: "object", properties: { source: { type: "string", format: "uri-reference", minLength: 1 } }, required: ["source"] } },
    };
    const { probe } = renderSection(PropertiesSection, { doc, options: OPTIONS, item: "idempotent" });
    expect(box("trait-props-name-0").value).toBe("source");
    expect(select("trait-props-type-0").value).toBe("link");
    type(box("trait-props-description-0"), "Where from");
    expect((specOf(probe.draft.doc, "idempotent").headers as { properties: { source: unknown } }).properties.source).toEqual({
      type: "string", format: "uri-reference", minLength: 1, description: "Where from",
    });
    expect(parseEventDocument(probe.draft.doc).success).toBe(true);
  });

  it("shows a stored headers entity pin as a read-only note and never drops it when something is edited", () => {
    const doc = traitsDoc();
    doc.traits[0] = { key: "idempotent", kind: "MESSAGE", spec: { name: "Idempotent" }, headers: { entityId: "ent-1", entityVersionId: "ver-1" } };
    const { probe } = renderSection(PropertiesSection, { doc, options: OPTIONS, item: "idempotent" });
    expect(text("trait-headers-note")).toBe("Headers also come from the entity OrderCreated.");
    click("trait-props-add");
    type(box("trait-props-name-0"), "x");
    type(box("trait-name"), "Renamed");
    expect(traitOf(probe.draft.doc, "idempotent")).toMatchObject({ headers: { entityId: "ent-1", entityVersionId: "ver-1" } });
    expect(parseEventDocument(probe.draft.doc).success).toBe(true);
  });

  it("shows no pin note for a set without one", () => {
    renderSection(PropertiesSection, { doc: traitsDoc(), options: OPTIONS, item: "idempotent" });
    expect(missing("trait-headers-note")).toBe(true);
  });
});

describe("PropertiesSection: a local operation set is its metadata", () => {
  it("shows title, summary and description up front and has no Properties table", () => {
    renderSection(PropertiesSection, { doc: traitsDoc(), options: OPTIONS, item: "retry" });
    for (const key of ["title", "summary", "description"]) expect(missing(`trait-${key}`), key).toBe(false);
    expect(missing("trait-props-add")).toBe(true);
    expect(missing("trait-name")).toBe(true);
    expect(missing("trait-headers")).toBe(true);
  });

  it("every field of TEMPLATES.operationTrait stays reachable, security tags, docs and bindings inside More details", () => {
    renderSection(PropertiesSection, { doc: traitsDoc(), options: OPTIONS, item: "retry" });
    openMore();
    const keys = TEMPLATES.operationTrait.fields.map((f) => f.key);
    expect(keys).toEqual(["title", "summary", "description", "security", "tags", "externalDocs", "bindings"]);
    const testIdOf: Record<string, string> = { bindings: "trait-bindings" };
    for (const key of keys) expect(screen.queryByTestId(testIdOf[key] ?? `trait-${key}`), `trait-${key}`).not.toBeNull();
  });

  it("writes the title, summary and description to the spec", () => {
    const { probe } = renderSection(PropertiesSection, { doc: traitsDoc(), options: OPTIONS, item: "retry" });
    type(box("trait-summary"), "Retry three times");
    type(box("trait-description"), "Backs off between tries");
    expect(specOf(probe.draft.doc, "retry")).toEqual({ title: "Retry", summary: "Retry three times", description: "Backs off between tries" });
  });

  it("lists the document's security schemes and writes the chosen ones to spec.security", () => {
    const doc = traitsDoc();
    doc.components = { securitySchemes: { basic: { type: "http", scheme: "basic" }, oauth: { type: "plain" } } };
    const { probe } = renderSection(PropertiesSection, { doc, options: OPTIONS, item: "retry" });
    openMore();
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
    renderSection(PropertiesSection, { doc: traitsDoc(), options: OPTIONS, item: "retry" });
    openMore();
    expect(text("trait-security-empty")).toContain("No security schemes");
  });
});

describe("PropertiesSection: protocol bindings", () => {
  it("writes a message set's binding fields with the binding version, and drops spec.bindings when the last field is cleared", () => {
    const { probe } = renderSection(PropertiesSection, { doc: traitsDoc(), options: OPTIONS, item: "idempotent" });
    openMore();
    type(box("trait-bindings-protocol"), "kafka");
    click("trait-bindings-add");
    type(select("trait-bindings-kafka-schemaIdLocation"), "payload");
    expect(specOf(probe.draft.doc, "idempotent").bindings).toEqual({ kafka: { schemaIdLocation: "payload", bindingVersion: bindingVersion("kafka", "message") } });
    expect(text("trait-more-count")).toBe("2");
    expect(probe.draft.problems).toEqual([]);
    type(select("trait-bindings-kafka-schemaIdLocation"), "");
    expect("bindings" in specOf(probe.draft.doc, "idempotent")).toBe(false);
  });

  it("uses the operation binding templates for an operation set", () => {
    const { probe } = renderSection(PropertiesSection, { doc: traitsDoc(), options: OPTIONS, item: "retry" });
    openMore();
    type(box("trait-bindings-protocol"), "kafka");
    click("trait-bindings-add");
    type(box("trait-bindings-kafka-groupId"), '{"type":"string","enum":["checkout"]}');
    expect(specOf(probe.draft.doc, "retry").bindings).toEqual({
      kafka: { groupId: { type: "string", enum: ["checkout"] }, bindingVersion: bindingVersion("kafka", "operation") },
    });
  });

  it("shows the bindings a set already has and keeps them when something else is edited", () => {
    const doc = traitsDoc();
    doc.traits[0] = { key: "idempotent", kind: "MESSAGE", spec: { name: "Idempotent", bindings: { kafka: { schemaIdLocation: "header", bindingVersion: "0.5.0" } } } };
    const { probe } = renderSection(PropertiesSection, { doc, options: OPTIONS, item: "idempotent" });
    openMore();
    expect(select("trait-bindings-kafka-schemaIdLocation").value).toBe("header");
    type(box("trait-title"), "T");
    expect(specOf(probe.draft.doc, "idempotent").bindings).toEqual({ kafka: { schemaIdLocation: "header", bindingVersion: "0.5.0" } });
  });
});

describe("PropertiesSection: the key is generated, then renamed on request", () => {
  it("names a new message set from its name when focus leaves the form, and follows the rename in the list and the URL item", async () => {
    const { probe } = renderSection(PropertiesSection, { doc: sampleDocument(), options: OPTIONS });
    await choose("new");
    type(box("trait-name"), "Idempotent writes");
    // typing never renames under the user's hands
    expect(probe.draft.doc.traits[0].key).toBe("trait");
    fireEvent.blur(box("trait-name"));
    expect(probe.draft.doc.traits[0].key).toBe("Idempotent-writes");
    expect(probe.item).toBe("Idempotent-writes");
    expect(text("trait-key-value")).toBe("Idempotent-writes");
    expect(screen.getByTestId("trait-row-Idempotent-writes").getAttribute("aria-current")).toBe("true");
  });

  it("names an operation set from its title", async () => {
    const { probe } = renderSection(PropertiesSection, { doc: sampleDocument(), options: OPTIONS });
    await choose("new", "OPERATION");
    type(box("trait-title"), "Retry policy");
    fireEvent.blur(box("trait-title"));
    expect(probe.draft.doc.traits[0].key).toBe("Retry-policy");
    expect(probe.item).toBe("Retry-policy");
  });

  it("does not rename while focus only moves between the form's own fields", async () => {
    const { probe } = renderSection(PropertiesSection, { doc: sampleDocument(), options: OPTIONS });
    await choose("new");
    type(box("trait-name"), "Idempotent");
    fireEvent.blur(box("trait-name"), { relatedTarget: screen.getByTestId("trait-props-add") });
    expect(probe.draft.doc.traits[0].key).toBe("trait");
  });

  it("keeps the placeholder key while there is nothing to name the set by", async () => {
    const { probe } = renderSection(PropertiesSection, { doc: sampleDocument(), options: OPTIONS });
    await choose("new");
    fireEvent.blur(box("trait-name"));
    expect(probe.draft.doc.traits[0].key).toBe("trait");
  });

  it("gives two sets with the same name distinct keys, across both kinds", async () => {
    const { probe } = renderSection(PropertiesSection, { doc: sampleDocument(), options: OPTIONS });
    await choose("new");
    type(box("trait-name"), "Retry");
    fireEvent.blur(box("trait-name"));
    await choose("new", "OPERATION");
    type(box("trait-title"), "Retry");
    fireEvent.blur(box("trait-title"));
    expect(probe.draft.doc.traits.map((t) => t.key)).toEqual(["Retry", "Retry-2"]);
    expect(parseEventDocument(probe.draft.doc).success).toBe(true);
  });

  it("never renames a set that already has a real key when its name changes", () => {
    const { probe } = renderSection(PropertiesSection, { doc: traitsDoc(), options: OPTIONS, item: "idempotent" });
    type(box("trait-name"), "Something else");
    fireEvent.blur(box("trait-name"));
    expect(probe.draft.doc.traits[0].key).toBe("idempotent");
  });

  it("renames through the Identifier: messages and operations follow the new key", () => {
    const doc = traitsDoc();
    doc.operations[0] = { ...doc.operations[0], traitKeys: ["retry"] };
    doc.messages.push({ key: "OrderUpdated", payload: doc.messages[0].payload, traitKeys: ["idempotent", "audit"] });
    const { probe } = renderSection(PropertiesSection, { doc, options: OPTIONS, item: "idempotent" });
    click("trait-key-toggle");
    type(box("trait-key"), "idem");
    fireEvent.blur(box("trait-key"));
    expect(probe.draft.doc.traits.map((t) => t.key)).toEqual(["idem", "audit", "retry"]);
    expect(probe.draft.doc.messages.map((m) => m.traitKeys)).toEqual([["idem"], ["idem", "audit"]]);
    expect(probe.item).toBe("idem");
    expect(parseEventDocument(probe.draft.doc).success).toBe(true);
    click("trait-row-retry");
    click("trait-key-toggle");
    type(box("trait-key"), "again");
    fireEvent.blur(box("trait-key"));
    expect(probe.draft.doc.operations[0].traitKeys).toEqual(["again"]);
    expect(parseEventDocument(probe.draft.doc).success).toBe(true);
  });

  it("refuses a key another set already has, of either kind, and keeps the old key", () => {
    const { probe } = renderSection(PropertiesSection, { doc: traitsDoc(), options: OPTIONS, item: "idempotent" });
    click("trait-key-toggle");
    type(box("trait-key"), "retry");
    expect(text("trait-key-error")).toBe('The key "retry" is already used.');
    fireEvent.blur(box("trait-key"));
    expect(probe.draft.doc.traits[0].key).toBe("idempotent");
  });

  it("refuses a key with a space, and puts the old key back on Escape", () => {
    const { probe } = renderSection(PropertiesSection, { doc: traitsDoc(), options: OPTIONS, item: "idempotent" });
    click("trait-key-toggle");
    type(box("trait-key"), "has space");
    expect(text("trait-key-error")).toContain("no spaces");
    fireEvent.keyDown(box("trait-key"), { key: "Escape" });
    expect(box("trait-key").value).toBe("idempotent");
    expect(probe.draft.doc.traits[0].key).toBe("idempotent");
  });

  it("keeps the identifier collapsed by default, with the key readable on the summary", () => {
    renderSection(PropertiesSection, { doc: traitsDoc(), options: OPTIONS, item: "idempotent" });
    expect((screen.getByTestId("trait-key-disclosure") as HTMLDetailsElement).open).toBe(false);
    expect(text("trait-key-value")).toBe("idempotent");
  });

  it("opens the identifier and shows the parser's message when the document reports a problem with the key", () => {
    const doc = traitsDoc();
    doc.traits.push({ key: "has space", kind: "MESSAGE", spec: {} });
    renderSection(PropertiesSection, { doc, options: OPTIONS, item: "has space" });
    expect((screen.getByTestId("trait-key-disclosure") as HTMLDetailsElement).open).toBe(true);
    expect(text("trait-key-error")).toContain("may only contain letters");
  });
});

describe("PropertiesSection: used by", () => {
  it("shows how many messages use a local message set", () => {
    const doc = traitsDoc();
    doc.messages.push({ key: "OrderUpdated", payload: doc.messages[0].payload, traitKeys: ["idempotent"] });
    renderSection(PropertiesSection, { doc, options: OPTIONS, item: "idempotent" });
    expect(text("trait-usage")).toBe("Used by 2 messages");
    expect(screen.getByTestId("trait-usage").getAttribute("title")).toBe("OrderCreated, OrderUpdated");
  });

  it("shows how many operations use an operation set, and zero when none does", () => {
    const doc = traitsDoc();
    renderSection(PropertiesSection, { doc, options: OPTIONS, item: "retry" });
    expect(text("trait-usage")).toBe("Used by 0 operations");
    cleanup();
    doc.operations[0] = { ...doc.operations[0], traitKeys: ["retry"] };
    renderSection(PropertiesSection, { doc, options: OPTIONS, item: "retry" });
    expect(text("trait-usage")).toBe("Used by 1 operation");
  });

  it("shows the same count on a library set", () => {
    const doc = traitsDoc();
    doc.messages[0] = { ...doc.messages[0], traitKeys: ["audit"] };
    renderSection(PropertiesSection, { doc, options: OPTIONS, item: "audit" });
    expect(text("trait-usage")).toBe("Used by 1 message");
  });

  it("follows an edit made elsewhere in the document", () => {
    const { probe } = renderSection(PropertiesSection, { doc: traitsDoc(), options: OPTIONS, item: "retry" });
    expect(text("trait-usage")).toBe("Used by 0 operations");
    act(() => probe.draft.update((d) => ({ ...d, operations: d.operations.map((o) => ({ ...o, traitKeys: ["retry"] })) })));
    expect(text("trait-usage")).toBe("Used by 1 operation");
  });
});

describe("PropertiesSection: removing", () => {
  it("removes a set nothing uses without asking, and selects the first remaining set", () => {
    const confirm = vi.spyOn(window, "confirm").mockReturnValue(true);
    const { probe } = renderSection(PropertiesSection, { doc: traitsDoc(), options: OPTIONS, item: "retry" });
    expect(text("trait-remove")).toContain("Remove operation properties");
    click("trait-remove");
    expect(confirm).not.toHaveBeenCalled();
    expect(probe.draft.doc.traits.map((t) => t.key)).toEqual(["idempotent", "audit"]);
    expect(probe.item).toBeNull();
    expect(box("trait-name").value).toBe("Idempotent");
    expect(text("trait-group-operation-empty")).toBe("None yet.");
  });

  it("asks before removing a set that messages use, then takes it off every message", () => {
    const confirm = vi.spyOn(window, "confirm").mockReturnValue(true);
    const doc = traitsDoc();
    doc.messages.push({ key: "OrderUpdated", payload: doc.messages[0].payload, traitKeys: ["idempotent", "audit"] });
    const { probe } = renderSection(PropertiesSection, { doc, options: OPTIONS, item: "idempotent" });
    expect(text("trait-remove")).toContain("Remove message properties");
    click("trait-remove");
    expect(confirm).toHaveBeenCalledTimes(1);
    expect(confirm.mock.calls[0][0]).toContain('Message properties "Idempotent"');
    expect(confirm.mock.calls[0][0]).toContain("2 messages");
    expect(confirm.mock.calls[0][0]).toContain("OrderCreated, OrderUpdated");
    expect(probe.draft.doc.traits.map((t) => t.key)).toEqual(["audit", "retry"]);
    expect(probe.draft.doc.messages.map((m) => m.traitKeys)).toEqual([[], ["audit"]]);
    expect(parseEventDocument(probe.draft.doc).success).toBe(true);
  });

  it("asks before removing an operation set that operations use, then takes it off every operation", () => {
    const confirm = vi.spyOn(window, "confirm").mockReturnValue(true);
    const doc = traitsDoc();
    doc.operations[0] = { ...doc.operations[0], traitKeys: ["retry"] };
    const { probe } = renderSection(PropertiesSection, { doc, options: OPTIONS, item: "retry" });
    click("trait-remove");
    expect(confirm.mock.calls[0][0]).toContain('Operation properties "Retry"');
    expect(confirm.mock.calls[0][0]).toContain("1 operation (publishOrder)");
    expect(probe.draft.doc.traits.map((t) => t.key)).toEqual(["idempotent", "audit"]);
    expect(probe.draft.doc.operations[0].traitKeys).toEqual([]);
    expect(parseEventDocument(probe.draft.doc).success).toBe(true);
  });

  it("changes nothing when the confirmation is declined", () => {
    vi.spyOn(window, "confirm").mockReturnValue(false);
    const { probe } = renderSection(PropertiesSection, { doc: traitsDoc(), options: OPTIONS, item: "idempotent" });
    click("trait-remove");
    expect(probe.draft.doc).toEqual(traitsDoc());
    expect(probe.draft.dirty).toBe(false);
  });

  it("removes a library set the same way, with the same propagation, and says it is removed from this event", () => {
    const confirm = vi.spyOn(window, "confirm").mockReturnValue(true);
    const doc = traitsDoc();
    doc.messages[0] = { ...doc.messages[0], traitKeys: ["idempotent", "audit"] };
    const { probe } = renderSection(PropertiesSection, { doc, options: OPTIONS, item: "audit" });
    expect(text("trait-remove")).toContain("Remove from this event");
    click("trait-remove");
    expect(confirm).toHaveBeenCalledTimes(1);
    expect(confirm.mock.calls[0][0]).toContain('"Audit headers"');
    expect(probe.draft.doc.traits.map((t) => t.key)).toEqual(["idempotent", "retry"]);
    expect(probe.draft.doc.messages[0].traitKeys).toEqual(["idempotent"]);
  });

  it("removing the last set brings the empty state back", () => {
    const doc = sampleDocument();
    doc.traits = [{ key: "only", kind: "MESSAGE", spec: {} }];
    renderSection(PropertiesSection, { doc, options: OPTIONS });
    click("trait-remove");
    expect(text("trait-empty")).toContain("No message properties yet");
  });
});

describe("PropertiesSection: a library or built-in set is read-only", () => {
  it("shows a built-in set locked: its eight properties, the lock note and an explanation, nothing to save", () => {
    const doc = sampleDocument();
    doc.traits = [{ key: "CloudEvents", kind: "MESSAGE", libraryTraitId: "builtin-ce" }];
    renderSection(PropertiesSection, { doc, options: OPTIONS });
    expect(text("trait-library-name")).toBe("CloudEvents");
    expect(text("trait-library-note")).toContain("Built in — can't be modified");
    expect(text("trait-props-note")).toBe("Built in — can't be modified");
    const names = within(screen.getByTestId("trait-props-table")).getAllByRole("rowheader").map((h) => h.textContent);
    expect(names).toEqual(["specversion", "id", "source", "type", "subject", "time", "datacontenttype", "dataschema"]);
    expect(text("trait-props-row-source-type")).toBe("Link");
    expect(text("trait-props-row-specversion-allowed")).toBe("Always1.0");
  });

  it("shows a library set with its properties and the note that it is edited where it is defined", () => {
    renderSection(PropertiesSection, { doc: traitsDoc(), options: OPTIONS, item: "audit" });
    expect(text("trait-library-name")).toBe("Audit headers");
    expect(text("trait-kind")).toBe("Message properties (Trait)");
    expect(text("trait-library-kind")).toBe("Messages");
    expect(text("trait-library-level")).toBe("Enterprise");
    expect(text("trait-library-note")).toBe("From the library — edit it under Message properties at the Tenant/Domain level");
    expect(text("trait-props-row-actor-description")).toBe("Who did it");
    expect(missing("trait-library-missing")).toBe(true);
  });

  it("shows the level of a domain set and of one the options carry no level for, and the operation note", () => {
    const doc = sampleDocument();
    doc.traits = [
      { key: "Tracing", kind: "MESSAGE", libraryTraitId: "lib-msg-2" },
      { key: "Dead-letter", kind: "OPERATION", libraryTraitId: "lib-op-2" },
    ];
    renderSection(PropertiesSection, { doc, options: OPTIONS, item: "Tracing" });
    expect(text("trait-library-level")).toBe("Domain · Payments");
    click("trait-row-Dead-letter");
    expect(text("trait-library-level")).toBe("Unknown");
    expect(text("trait-library-kind")).toBe("Operations");
    expect(text("trait-kind")).toBe("Operation properties (Trait)");
    expect(text("trait-props-note")).toContain("From the library");
  });

  it("has no input, no select and no textarea: nothing in it can be edited, only removed from this event", () => {
    renderSection(PropertiesSection, { doc: traitsDoc(), options: OPTIONS, item: "audit" });
    const form = screen.getByTestId("trait-library-form");
    expect(form.querySelectorAll("input, select, textarea")).toHaveLength(0);
    expect(within(form).getByRole("button", { name: "Remove from this event" })).toBeDefined();
    expect(missing("trait-name")).toBe(true);
    expect(missing("trait-key-disclosure")).toBe(true);
    expect(missing("trait-props-add")).toBe(true);
  });

  it("does not touch the document when it is only looked at", () => {
    const { probe } = renderSection(PropertiesSection, { doc: traitsDoc(), options: OPTIONS, item: "audit" });
    click("trait-row-retry");
    click("trait-row-audit");
    expect(probe.draft.dirty).toBe(false);
  });

  it("says so when the library set is no longer offered to this event, and still names it by its key", () => {
    const doc = sampleDocument();
    doc.traits = [{ key: "gone-trait", kind: "MESSAGE", libraryTraitId: "deleted-id" }];
    renderSection(PropertiesSection, { doc, options: OPTIONS });
    expect(text("trait-library-name")).toBe("gone-trait");
    expect(text("trait-library-missing")).toContain("not offered to this event any more");
  });

  it("still opens, edits around and saves a document that uses the old entity-pinned CloudEvents library set (it has no inline properties)", () => {
    const doc = sampleDocument();
    doc.traits = [{ key: "CloudEvents-legacy", kind: "MESSAGE", libraryTraitId: "legacy-ce" }];
    doc.messages[0] = { ...doc.messages[0], traitKeys: ["CloudEvents-legacy"] };
    const legacy: BuilderOptions = { entityOptions: ENTITY_OPTIONS, libraryTraits: [...LIBRARY, { id: "legacy-ce", name: "CloudEvents-legacy", kind: "MESSAGE", level: "Enterprise" }] };
    const { probe } = renderSection(PropertiesSection, { doc, options: legacy });
    expect(text("trait-library-name")).toBe("CloudEvents-legacy");
    expect(text("trait-props-empty")).toBe("No properties.");
    expect(parseEventDocument(probe.draft.doc).success).toBe(true);
  });

  it("shows the library problem a failed save reported, and offers the identifier only when the key itself has a problem", async () => {
    const saveDocument = vi.fn<SaveDocument>().mockResolvedValue({
      success: false, error: "1 problem(s) in the event document", code: "VALIDATION_ERROR",
      details: { problems: [{ pointer: "/traits/1/libraryTraitId", message: 'Library trait "lib-msg-1" not found' }] },
    });
    renderBuilder({ doc: traitsDoc(), options: OPTIONS, section: "traits", item: "idempotent", saveDocument });
    type(box("trait-name"), "x");
    await act(async () => { fireEvent.click(button("builder-save")); });
    click("trait-row-audit");
    expect(text("trait-library-error")).toBe('Library trait "lib-msg-1" not found');
    expect(text("trait-row-audit")).toContain("has problems");
    expect(missing("trait-key-disclosure")).toBe(true);
  });

  it("opens the identifier of a library set whose key the document reports a problem on, so the key can be fixed", () => {
    const doc = traitsDoc();
    doc.traits.push({ key: "has space", kind: "MESSAGE", libraryTraitId: "lib-msg-2" });
    const { probe } = renderSection(PropertiesSection, { doc, options: OPTIONS, item: "has space" });
    expect((screen.getByTestId("trait-key-disclosure") as HTMLDetailsElement).open).toBe(true);
    expect(text("trait-key-error")).toContain("may only contain letters");
    type(box("trait-key"), "tracing");
    fireEvent.blur(box("trait-key"));
    expect(probe.draft.doc.traits.map((t) => t.key)).toEqual(["idempotent", "audit", "retry", "tracing"]);
    expect(probe.item).toBe("tracing");
    expect(probe.draft.problems).toEqual([]);
  });
});

describe("EventBuilder: the Message properties section in the shell", () => {
  it("is the content of the 'Message properties' outline node (the section id stays traits)", () => {
    const { probe } = renderBuilder({ doc: traitsDoc(), options: OPTIONS });
    click("outline-traits");
    expect(probe.section).toBe("traits");
    expect(screen.getByTestId("section-traits")).toBeDefined();
    expect(screen.getByTestId("outline-traits").getAttribute("aria-current")).toBe("true");
    expect(screen.getByTestId("outline-traits").textContent).toContain("Message properties");
    expect(screen.getByTestId("outline-traits").textContent).not.toMatch(/Trait/);
  });

  it("counts local and library sets on the outline node", () => {
    renderBuilder({ doc: traitsDoc(), options: OPTIONS });
    expect(text("outline-count-traits")).toBe("3");
  });

  it("shows a problem badge on Message properties for a problem under /traits, and the count follows the fix", () => {
    const doc = traitsDoc();
    doc.traits[0] = { key: "idempotent", kind: "MESSAGE", spec: { name: "Idempotent", externalDocs: { url: "nope" } } };
    renderBuilder({ doc, options: OPTIONS, section: "traits" });
    expect(screen.getByTestId("outline-problems-traits").textContent).toContain("1");
    type(box("trait-externalDocs-url"), "https://example.com");
    expect(screen.queryByTestId("outline-problems-traits")).toBeNull();
  });

  it("lists a failed save's problems under the section's user-facing name and jumps to the set", async () => {
    const saveDocument = vi.fn<SaveDocument>().mockResolvedValue({
      success: false, error: "1 problem(s) in the event document", code: "VALIDATION_ERROR",
      details: { problems: [{ pointer: "/traits/2/spec/title", message: "title must be a string" }] },
    });
    const { probe } = renderBuilder({ doc: traitsDoc(), options: OPTIONS, saveDocument });
    type(screen.getByTestId("metadata-title"), "Orders v2");
    await act(async () => { fireEvent.click(button("builder-save")); });
    const alert = within(screen.getByRole("alert"));
    fireEvent.click(alert.getByRole("button", { name: "Message properties · retry: title must be a string" }));
    expect(probe.section).toBe("traits");
    expect(probe.item).toBe("retry");
    expect(screen.getByTestId("trait-row-retry").getAttribute("aria-current")).toBe("true");
  });

  it("a set added here and a document with no other change save together through the shell", async () => {
    const { probe } = renderBuilder({ doc: emptyEventDocument("Orders"), options: OPTIONS, section: "traits" });
    await choose("new", "OPERATION");
    type(box("trait-title"), "Retry");
    fireEvent.blur(box("trait-title"));
    await act(async () => { fireEvent.click(button("builder-save")); });
    expect(probe.saveDocument).toHaveBeenCalledTimes(1);
    expect(probe.saveDocument.mock.calls[0][2]).toMatchObject({ traits: [{ key: "Retry", kind: "OPERATION", spec: { title: "Retry" } }] });
  });

  it("a built-in set added here is saved as a library reference by its id", async () => {
    const { probe } = renderBuilder({ doc: emptyEventDocument("Orders"), options: OPTIONS, section: "traits" });
    await choose("builtin-ce");
    await act(async () => { fireEvent.click(button("builder-save")); });
    expect(probe.saveDocument.mock.calls[0][2]).toMatchObject({ traits: [{ key: "CloudEvents", kind: "MESSAGE", libraryTraitId: "builtin-ce" }] });
  });
});
