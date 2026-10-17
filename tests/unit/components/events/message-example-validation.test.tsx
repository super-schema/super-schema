// @vitest-environment jsdom
// Message examples against the schema of their entity, through the REAL CodeMirror editor (jsdom with the stand-ins of
// ./template/codemirror-jsdom) and the REAL `codemirror-json-schema` (vitest.config.ts inlines it). The one thing mocked is the server
// action that renders a pin's schema. A violation is only ever a WARNING marker; "Generate from payload" fills the field with an example
// the editor then accepts; a schema that goes away (another entity chosen, a failed load) takes its warnings with it at once.
import "./template/codemirror-jsdom";
import { forEachDiagnostic } from "@codemirror/lint";
import { EditorView } from "@codemirror/view";
import { act, cleanup, configure, fireEvent, render, screen, waitFor } from "@testing-library/react";
import { useState } from "react";
import { afterEach, beforeAll, beforeEach, describe, expect, it, vi } from "vitest";
import { MessagesSection } from "@/features/events/builder/sections/MessagesSection";
import { PropertiesSection } from "@/features/events/builder/sections/PropertiesSection";
import { exampleSchema, exampleSource } from "@/features/events/builder/template/controls/example-schema";
import { JsonControl } from "@/features/events/builder/template/controls/JsonControl";
import type { ControlProps } from "@/features/events/builder/template/controls/types";
import { resetPinSchemaCache } from "@/features/events/builder/use-pin-json-schema";
import type { DocMessageExample, EventDocument } from "@/lib/events/document/types";
import type { EntityPin } from "@/lib/events/types";
import { ENTITY_OPTIONS, PIN, renderSection, sampleDocument } from "./builder-harness";

type Schema = Record<string, unknown>;
type Outcome = { success: true; data: { schema: Schema } } | { success: false; error: string; code: string };

// The first test pays the cold dynamic import of the editor setup and the schema library (about 1 s idle, over 5 s under a loaded full run).
vi.setConfig({ testTimeout: 30_000 });
beforeAll(async () => {
  await import("@/features/events/builder/template/controls/codemirror-setup");
  await import("codemirror-json-schema");
  await import("@codemirror/autocomplete");
}, 60_000);

const h = vi.hoisted(() => ({ pinJsonSchemaAction: vi.fn(), listPinnableVersionsAction: vi.fn() }));
vi.mock("@/features/events/pin-actions", () => ({ listPinnableVersionsAction: h.listPinnableVersionsAction }));
vi.mock("@/app/(dashboard)/schemas/[domainSlug]/[productSlug]/event-actions", () => ({
  getExternalRefStatusesAction: () => Promise.resolve({ success: false, error: "unavailable" }),
  getExternalVersionItemsAction: () => Promise.resolve({ success: false, error: "unavailable" }),
  pinJsonSchemaAction: h.pinJsonSchemaAction,
}));

// Markers arrive after the linter's 250 ms delay (or at once when forced); a loaded machine needs more than the 1 s default.
configure({ asyncUtilTimeout: 4000 });

const ORDER: Schema = {
  type: "object",
  properties: { orderId: { type: "string" }, quantity: { type: "integer", minimum: -2147483648, maximum: 2147483647 } },
  required: ["orderId"],
  additionalProperties: false,
};
const TRACE: Schema = { type: "object", properties: { traceId: { type: "string" } }, required: ["traceId"], additionalProperties: false };
const BOOLEAN_ORDER: Schema = { type: "object", properties: { orderId: { type: "boolean" } } };
const GENERATED = { orderId: "string", quantity: 0 };

const ENT_1: EntityPin = PIN; // ent-1 @ ver-1, the sample document's payload
const ENT_2: EntityPin = { entityId: "ent-2", entityVersionId: "ver-2" };
const ok = (schema: Schema): Outcome => ({ success: true, data: { schema } });
const sleep = (ms: number) => new Promise<void>((resolve) => { setTimeout(resolve, ms); });

/** What the action answers, by the entity of the pin it is asked about. */
function serve(byEntity: Record<string, Outcome | Promise<Outcome>>) {
  h.pinJsonSchemaAction.mockImplementation(async (_productId: string, pin: EntityPin) => byEntity[pin.entityId] ?? { success: false, error: "unknown", code: "NOT_FOUND" });
}
const deferred = () => {
  let resolve!: (o: Outcome) => void;
  const promise = new Promise<Outcome>((r) => { resolve = r; });
  return { promise, resolve };
};

beforeEach(() => {
  vi.clearAllMocks();
  resetPinSchemaCache(); // the schema of a published version is kept for the page session: every test starts a new one
  h.listPinnableVersionsAction.mockResolvedValue({ success: true, data: [{ id: "ver-1", label: "1.0" }] });
  serve({ "ent-1": ok(ORDER), "ent-2": ok(TRACE) });
});
afterEach(() => {
  cleanup();
  document.body.innerHTML = "";
});

interface Marker { severity: string; message: string; text: string }
function markers(view: EditorView): Marker[] {
  const found: Marker[] = [];
  forEachDiagnostic(view.state, (d, from, to) => found.push({ severity: d.severity, message: d.message, text: view.state.sliceDoc(from, to) }));
  return found;
}

/** A sample document whose only message has `examples` (and, optionally, a headers pin). */
function documentWith(examples: DocMessageExample[] | undefined, headers?: EntityPin): EventDocument {
  const doc = sampleDocument();
  doc.messages = [{ ...doc.messages[0], ...(examples && { examples }), ...(headers && { headers }) }];
  return doc;
}

/** The accordion cards load their pickers lazily: wait for them to settle before the test acts. */
async function renderMessages(doc: EventDocument, open = true) {
  const rendered = renderSection(MessagesSection, { doc });
  await screen.findByLabelText("Payload entity");
  await act(async () => {});
  // An example with neither headers nor payload (just added) is a problem of the document, and a card that holds a problem opens by itself.
  const toggle = screen.getByTestId("message-card-examples-toggle");
  if (open && toggle.getAttribute("aria-expanded") !== "true") fireEvent.click(toggle);
  return rendered;
}

/** The real editor of one example field (the textarea stands in until CodeMirror has loaded). */
async function editorOf(field: "payload" | "headers", example = 0): Promise<EditorView> {
  const wrapper = await screen.findByTestId(`message-examples-${example}-${field}-editor`);
  await waitFor(() => expect(wrapper.getAttribute("data-editor")).toBe("codemirror"));
  return EditorView.findFromDOM(wrapper.querySelector(".cm-editor") as HTMLElement) as EditorView;
}
const generateButton = (field: "payload" | "headers" = "payload", example = 0) =>
  screen.getByTestId(`message-examples-${example}-${field}-generate`) as HTMLButtonElement;
const replaceText = (view: EditorView, text: string) => act(() => { view.dispatch({ changes: { from: 0, to: view.state.doc.length, insert: text }, userEvent: "input.paste" }); });

describe("an example payload against the schema of the message's payload entity", () => {
  it("warns about an example that breaks the schema, on the offending value, and about nothing else", async () => {
    await renderMessages(documentWith([{ name: "bad", payload: { orderId: 5 } }]));
    const view = await editorOf("payload");
    await waitFor(() => expect(markers(view)).toHaveLength(1));
    expect(markers(view)[0]).toEqual({ severity: "warning", message: "Expected `string` but received `number`", text: "5" });
    expect(h.pinJsonSchemaAction).toHaveBeenCalledTimes(1);
    expect(h.pinJsonSchemaAction).toHaveBeenCalledWith("p1", ENT_1);
  });

  it("checks values behind local $refs too, as the server's schema has them: its definitions, and a model that contains itself", async () => {
    // What `pinJsonSchemaAction` hands over: draft-07, the other models under `definitions`, references kept as local `$ref`s.
    const WITH_REFS: Schema = {
      $schema: "http://json-schema.org/draft-07/schema#",
      type: "object",
      properties: { ship: { $ref: "#/definitions/Address" }, children: { type: "array", items: { $ref: "#" } } },
      definitions: { Address: { type: "object", properties: { zip: { type: "string" } } } },
    };
    serve({ "ent-1": ok(WITH_REFS) });
    await renderMessages(documentWith([{ payload: { ship: { zip: 5 }, children: [{ children: [{ ship: { zip: 7 } }] }] } }]));
    const view = await editorOf("payload");
    await waitFor(() => expect(markers(view)).toHaveLength(2));
    expect(markers(view).map((m) => m.text).sort()).toEqual(["5", "7"]);
    expect(markers(view).every((m) => m.severity === "warning" && m.message === "Expected `string` but received `number`")).toBe(true);
  });

  it("does not warn about an example that matches", async () => {
    await renderMessages(documentWith([{ payload: { orderId: "o-1", quantity: 2 } }]));
    const view = await editorOf("payload");
    await waitFor(() => expect(h.pinJsonSchemaAction).toHaveBeenCalled());
    // "the action was called" is not "the schema is installed": the button is enabled once the schema has arrived, so the wait below proves something
    await waitFor(() => expect(generateButton().disabled).toBe(false));
    await act(async () => { await sleep(400); });
    expect(markers(view)).toEqual([]);
  });

  it("never lets a violation block anything: the value is saved into the draft and the field is not invalid", async () => {
    const { probe } = await renderMessages(documentWith([{ payload: { orderId: "o-1" } }]));
    const view = await editorOf("payload");
    await waitFor(() => expect(h.pinJsonSchemaAction).toHaveBeenCalled());
    await waitFor(() => expect(generateButton().disabled).toBe(false));
    replaceText(view, '{"orderId": 5, "colour": "red"}');
    await waitFor(() => expect(probe.draft.doc.messages[0].examples?.[0].payload).toEqual({ orderId: 5, colour: "red" }));
    await waitFor(() => expect(markers(view).map((m) => m.severity)).toEqual(["warning", "warning"]));
    expect(screen.queryByTestId("message-examples-0-payload-validation")).toBeNull();
    expect(view.contentDOM.hasAttribute("aria-invalid")).toBe(false);
    expect(probe.draft.problems).toEqual([]);
  });

  it("checks the headers example against the schema of the HEADERS entity, and the payload against its own", async () => {
    await renderMessages(documentWith([{ headers: { traceId: 7 }, payload: { orderId: "o-1" } }], ENT_2));
    const headers = await editorOf("headers");
    const payload = await editorOf("payload");
    await waitFor(() => expect(markers(headers)).toHaveLength(1));
    expect(markers(headers)[0]).toMatchObject({ severity: "warning", text: "7" });
    // the payload's own schema has arrived too (its button is enabled), so the empty list below is a verdict and not a race
    await waitFor(() => expect(generateButton("payload").disabled).toBe(false));
    await act(async () => { await sleep(400); });
    expect(markers(payload)).toEqual([]);
    expect(h.pinJsonSchemaAction.mock.calls.map(([, pin]) => (pin as EntityPin).entityId).sort()).toEqual(["ent-1", "ent-2"]);
  });

  it("asks nothing while the Examples card is closed or the message has no example (rendering a schema runs the TypeSpec compiler)", async () => {
    const closed = await renderMessages(documentWith([{ payload: { orderId: 5 } }]), false);
    await act(async () => { await sleep(100); });
    expect(h.pinJsonSchemaAction).not.toHaveBeenCalled();
    closed.unmount();

    await renderMessages(documentWith(undefined));
    await act(async () => { await sleep(100); });
    expect(h.pinJsonSchemaAction).not.toHaveBeenCalled();
  });

  it("asks nothing for a message that has no payload entity yet", async () => {
    const doc = documentWith([{ payload: { orderId: 5 } }]);
    doc.messages[0].payload = { entityId: "", entityVersionId: null };
    await renderMessages(doc);
    await editorOf("payload");
    await act(async () => { await sleep(100); });
    expect(h.pinJsonSchemaAction).not.toHaveBeenCalled();
  });
});

describe("no stale schema", () => {
  const swapPayload = (probe: ReturnType<typeof renderSection>["probe"], pin: EntityPin) =>
    act(() => probe.draft.update((d) => ({ ...d, messages: d.messages.map((m, i) => (i === 0 ? { ...m, payload: pin } : m)) })));

  it("drops the old schema's warnings the moment another payload entity is chosen, and applies the new schema when it arrives", async () => {
    const { probe } = await renderMessages(documentWith([{ payload: { orderId: 5 } }]));
    const view = await editorOf("payload");
    await waitFor(() => expect(markers(view)).toHaveLength(1));
    expect(markers(view)[0].message).toContain("`string`");

    const next = deferred();
    serve({ "ent-1": ok(ORDER), "ent-2": next.promise });
    await swapPayload(probe, ENT_2);
    // ent-2's schema is still on its way: the example is checked against NOTHING, not against ent-1's schema
    await waitFor(() => expect(markers(view)).toEqual([]));
    expect(generateButton().disabled).toBe(true);
    await act(async () => { await sleep(400); });
    expect(markers(view)).toEqual([]);

    next.resolve(ok(BOOLEAN_ORDER));
    await waitFor(() => expect(markers(view)).toHaveLength(1));
    expect(markers(view)[0].message).toContain("`boolean`");
    expect(generateButton().disabled).toBe(false);
  });

  it("ignores the answer of a pin that is no longer the message's", async () => {
    const { probe } = await renderMessages(documentWith([{ payload: { orderId: 5 } }]));
    const view = await editorOf("payload");
    await waitFor(() => expect(markers(view)).toHaveLength(1));

    const slow = deferred();
    serve({ "ent-1": ok(ORDER), "ent-2": slow.promise });
    await swapPayload(probe, ENT_2);
    await swapPayload(probe, { entityId: "ent-3", entityVersionId: "ver-3" });
    slow.resolve(ok(BOOLEAN_ORDER)); // ent-2's answer arrives after the message moved on to ent-3
    await act(async () => { await sleep(400); });
    expect(markers(view)).toEqual([]);
  });

  it("leaves NO schema when a load fails, never retries it on its own, and a rejected action counts as a failure too", async () => {
    const { probe } = await renderMessages(documentWith([{ payload: { orderId: 5 } }]));
    const view = await editorOf("payload");
    await waitFor(() => expect(markers(view)).toHaveLength(1));

    serve({ "ent-1": ok(ORDER), "ent-2": { success: false, error: "The schema of this entity could not be generated", code: "ARTIFACT_RENDER_FAILED" } });
    await swapPayload(probe, ENT_2);
    await waitFor(() => expect(markers(view)).toEqual([]));
    await act(async () => { await sleep(500); });
    expect(markers(view)).toEqual([]);
    expect(generateButton().disabled).toBe(true);
    expect(h.pinJsonSchemaAction.mock.calls.filter(([, pin]) => (pin as EntityPin).entityId === "ent-2")).toHaveLength(1);

    h.pinJsonSchemaAction.mockImplementation(() => Promise.reject(new Error("network down")));
    await swapPayload(probe, { entityId: "ent-4", entityVersionId: "ver-4" });
    await act(async () => { await sleep(300); });
    expect(markers(view)).toEqual([]);
    expect(generateButton().disabled).toBe(true);
    expect(h.pinJsonSchemaAction.mock.calls.filter(([, pin]) => (pin as EntityPin).entityId === "ent-4")).toHaveLength(1);
  });

  it("keeps the schema of a published version for the page session: going back to it asks nothing again", async () => {
    serve({ "ent-1": ok(ORDER), "ent-2": ok({ type: "object" }) }); // ent-2 accepts anything, so only ent-1 can warn
    const { probe } = await renderMessages(documentWith([{ payload: { orderId: 5 } }]));
    const view = await editorOf("payload");
    await waitFor(() => expect(markers(view)).toHaveLength(1));
    await swapPayload(probe, ENT_2);
    await waitFor(() => expect(markers(view)).toEqual([]));
    await swapPayload(probe, ENT_1);
    await waitFor(() => expect(markers(view)).toHaveLength(1));
    expect(h.pinJsonSchemaAction.mock.calls.filter(([, pin]) => (pin as EntityPin).entityId === "ent-1")).toHaveLength(1);
  });

  it("reads an unpinned (draft) entity again every time, as it can change underneath", async () => {
    serve({ "ent-1": ok(ORDER), "ent-2": ok({ type: "object" }) });
    const draft = (id: string): EntityPin => ({ entityId: id, entityVersionId: null });
    const doc = documentWith([{ payload: { orderId: 5 } }]);
    doc.messages[0].payload = draft("ent-1");
    const { probe } = await renderMessages(doc);
    const view = await editorOf("payload");
    await waitFor(() => expect(markers(view)).toHaveLength(1));
    await swapPayload(probe, draft("ent-2"));
    await waitFor(() => expect(markers(view)).toEqual([]));
    await swapPayload(probe, draft("ent-1"));
    await waitFor(() => expect(markers(view)).toHaveLength(1));
    expect(h.pinJsonSchemaAction.mock.calls.filter(([, pin]) => (pin as EntityPin).entityId === "ent-1")).toHaveLength(2);
  });
});

describe("Generate from payload", () => {
  it("is not usable until the schema is known, and says why: it is still loading, then it is there", async () => {
    const pending = deferred();
    serve({ "ent-1": pending.promise });
    await renderMessages(documentWith([{ name: "empty" }]));
    await editorOf("payload");
    expect(generateButton().disabled).toBe(true);
    // the schema is being rendered (it takes seconds): not "needs an entity", which the user already chose
    expect(screen.getByTestId("message-examples-0-payload-generate-hint").textContent).toBe("Loading the schema…");
    expect(generateButton().textContent).toBe("Generate from payload");
    expect(generateButton("headers").textContent).toBe("Generate from headers");
    expect(screen.getByTestId("message-examples-0-headers-generate-hint").textContent).toBe("Needs a headers entity with a schema.");
    pending.resolve(ok(ORDER));
    await waitFor(() => expect(generateButton().disabled).toBe(false));
    expect(screen.queryByTestId("message-examples-0-payload-generate-hint")).toBeNull();
  });

  it("says 'Needs a payload entity with a schema.' when there is none coming: the load failed, or the message has no payload entity", async () => {
    serve({ "ent-1": { success: false, error: "The schema of this entity could not be generated", code: "ARTIFACT_RENDER_FAILED" } });
    await renderMessages(documentWith([{ name: "empty" }]));
    await editorOf("payload");
    await waitFor(() => expect(screen.getByTestId("message-examples-0-payload-generate-hint").textContent).toBe("Needs a payload entity with a schema."));
    expect(generateButton().disabled).toBe(true);
    cleanup();

    const doc = documentWith([{ name: "empty" }]);
    doc.messages[0].payload = { entityId: "", entityVersionId: null };
    await renderMessages(doc);
    await editorOf("payload");
    expect(screen.getByTestId("message-examples-0-payload-generate-hint").textContent).toBe("Needs a payload entity with a schema.");
  });

  it("fills an empty example at once, with pretty JSON the editor then reports as valid", async () => {
    const { probe } = await renderMessages(documentWith([{ name: "fresh" }]));
    const view = await editorOf("payload");
    await waitFor(() => expect(generateButton().disabled).toBe(false));
    await act(async () => { fireEvent.click(generateButton()); });
    await waitFor(() => expect(view.state.doc.toString()).toBe(JSON.stringify(GENERATED, null, 2)));
    expect(screen.queryByTestId("message-examples-0-payload-generate-confirm")).toBeNull();
    expect(probe.draft.doc.messages[0].examples?.[0]).toEqual({ name: "fresh", payload: GENERATED });
    await act(async () => { await sleep(500); });
    expect(markers(view)).toEqual([]); // no squiggle: the example is what the schema asks for
  });

  it("clears the warnings of a wrong example by replacing it, after asking first", async () => {
    const { probe } = await renderMessages(documentWith([{ payload: { orderId: 5, extra: true } }]));
    const view = await editorOf("payload");
    await waitFor(() => expect(markers(view).length).toBeGreaterThan(0));
    await waitFor(() => expect(generateButton().disabled).toBe(false));

    fireEvent.click(generateButton());
    expect(screen.getByTestId("message-examples-0-payload-generate-confirm").textContent).toContain("Replace the current example?");
    expect(probe.draft.doc.messages[0].examples?.[0].payload).toEqual({ orderId: 5, extra: true }); // nothing yet

    await act(async () => { fireEvent.click(screen.getByTestId("message-examples-0-payload-generate-replace")); });
    await waitFor(() => expect(probe.draft.doc.messages[0].examples?.[0].payload).toEqual(GENERATED));
    expect(screen.queryByTestId("message-examples-0-payload-generate-confirm")).toBeNull();
    await waitFor(() => expect(markers(view)).toEqual([]));
  });

  it("keeps the current example when the answer to the question is Keep, and gives focus back to the button", async () => {
    const { probe } = await renderMessages(documentWith([{ payload: { orderId: "o-1" } }]));
    await editorOf("payload");
    await waitFor(() => expect(generateButton().disabled).toBe(false));
    fireEvent.click(generateButton());
    expect(screen.getByTestId("message-examples-0-payload-generate-confirm")).toBeTruthy();
    fireEvent.click(screen.getByTestId("message-examples-0-payload-generate-keep"));
    expect(screen.queryByTestId("message-examples-0-payload-generate-confirm")).toBeNull();
    expect(document.activeElement).toBe(generateButton());
    expect(probe.draft.doc.messages[0].examples?.[0].payload).toEqual({ orderId: "o-1" });
  });

  it("generates the headers example from the headers entity's schema", async () => {
    const { probe } = await renderMessages(documentWith([{ name: "h" }], ENT_2));
    await editorOf("headers");
    await waitFor(() => expect(generateButton("headers").disabled).toBe(false));
    await act(async () => { fireEvent.click(generateButton("headers")); });
    await waitFor(() => expect(probe.draft.doc.messages[0].examples?.[0].headers).toEqual({ traceId: "string" }));
    expect(probe.draft.doc.messages[0].examples?.[0].payload).toBeUndefined();
  });

  it("leaves Generate from headers disabled for a message that has no headers entity (there is nothing to generate it from)", async () => {
    await renderMessages(documentWith([{ name: "n" }]));
    await editorOf("headers");
    expect(generateButton("headers").disabled).toBe(true);
  });
});

describe("a trait's examples are not message examples", () => {
  it("get no schema, no Generate button and no call to the server", async () => {
    const doc = { ...sampleDocument(), traits: [{ key: "idem", kind: "MESSAGE" as const, spec: { examples: [{ name: "t", payload: { a: 1 } }] } }] };
    renderSection(PropertiesSection, { doc, options: { entityOptions: ENTITY_OPTIONS, libraryTraits: [] }, item: "idem" });
    fireEvent.click(await screen.findByTestId("trait-more-toggle")); // a trait's examples are under "More details"
    const payload = await screen.findByTestId("trait-examples-0-payload");
    expect(payload).toBeTruthy();
    expect(screen.queryByTestId("trait-examples-0-payload-generate")).toBeNull();
    expect(screen.queryByTestId("trait-examples-0-headers-generate")).toBeNull();
    await act(async () => { await sleep(100); });
    expect(h.pinJsonSchemaAction).not.toHaveBeenCalled();
  });
});

describe("JsonControl: the Generate button on its own", () => {
  const FIELD = { key: "payload", label: "Payload", kind: "json", group: "basics" } as ControlProps["field"];
  function mount(over: Partial<ControlProps> = {}) {
    const onChange = vi.fn();
    const props: ControlProps = {
      field: FIELD, id: "f", value: undefined, onChange, required: false, invalid: false, path: "/messages/0/examples/0/payload",
      renderFields: () => null, schema: ORDER, context: { pinSchemas: { payload: ORDER, headers: null } }, ...over,
    };
    const utils = render(<JsonControl {...props} />);
    return { ...utils, onChange, props };
  }
  const click = async (testId: string) => { await act(async () => { fireEvent.click(screen.getByTestId(testId)); }); };

  it("shows a short message, writes nothing and throws nothing when the schema cannot give an example", async () => {
    const { onChange } = mount({ schema: { type: "object", properties: { a: { $ref: "#/definitions/Missing" } } } });
    await click("f-generate");
    await waitFor(() => expect(screen.getByTestId("f-generate-error").textContent).toBe("Could not generate an example from this schema."));
    expect(onChange).not.toHaveBeenCalled();
  });

  it("says so when the schema has nothing to build an example from, instead of clearing the field", async () => {
    const { onChange } = mount({ schema: { type: "object", properties: {} }, value: { keep: "me" } });
    await click("f-generate");
    await click("f-generate-replace");
    await waitFor(() => expect(screen.getByTestId("f-generate-error").textContent).toBe("This schema has nothing to generate an example from."));
    expect(onChange).not.toHaveBeenCalled();
  });

  it("removes the message when the user tries again and it works, and when the field changes", async () => {
    const { rerender, props, onChange } = mount({ schema: { type: "object", properties: { a: { $ref: "#/definitions/Missing" } } } });
    await click("f-generate");
    await waitFor(() => expect(screen.getByTestId("f-generate-error")).toBeTruthy());
    rerender(<JsonControl {...props} schema={ORDER} />);
    await click("f-generate");
    await waitFor(() => expect(onChange).toHaveBeenCalledWith(GENERATED));
    expect(screen.queryByTestId("f-generate-error")).toBeNull();
  });

  it("asks before replacing text that is not even valid JSON, and never for an empty field", async () => {
    const first = mount({ value: undefined });
    await click("f-generate");
    await waitFor(() => expect(first.onChange).toHaveBeenCalledWith(GENERATED)); // empty: no question
    cleanup();

    const { onChange } = mount({ value: undefined });
    const wrapper = await screen.findByTestId("f-editor");
    await waitFor(() => expect(wrapper.getAttribute("data-editor")).toBe("codemirror"));
    replaceText(EditorView.findFromDOM(wrapper.querySelector(".cm-editor") as HTMLElement) as EditorView, '{"orderId": ');
    await click("f-generate");
    expect(screen.getByTestId("f-generate-confirm")).toBeTruthy();
    expect(onChange).not.toHaveBeenCalled();

    // ...and Replace completes it: the broken text is replaced by the example, which clears the "Not valid JSON" message
    expect(screen.getByTestId("f-validation").textContent).toMatch(/^Not valid JSON: /);
    await click("f-generate-replace");
    await waitFor(() => expect(onChange).toHaveBeenCalledWith(GENERATED));
    const view = EditorView.findFromDOM(wrapper.querySelector(".cm-editor") as HTMLElement) as EditorView;
    await waitFor(() => expect(view.state.doc.toString()).toBe(JSON.stringify(GENERATED, null, 2)));
    expect(screen.queryByTestId("f-validation")).toBeNull();
    expect(screen.queryByTestId("f-generate-confirm")).toBeNull();
  });

  it("replaces broken text with the example even when the stored value already IS that example (Generate, break the text, Generate, Replace)", async () => {
    // A form that keeps the value, as the real one does: writing a value equal to the stored one changes nothing there, so the editor's text
    // can only be put right by the control itself.
    function Stored() {
      const [value, setValue] = useState<unknown>(undefined);
      return (
        <>
          <JsonControl
            field={FIELD} id="f" value={value} onChange={setValue} required={false} invalid={false} path="/messages/0/examples/0/payload"
            renderFields={() => null} schema={ORDER} context={{ pinSchemas: { payload: ORDER, headers: null } }}
          />
          <output data-testid="stored">{JSON.stringify(value)}</output>
        </>
      );
    }
    render(<Stored />);
    const wrapper = await screen.findByTestId("f-editor");
    await waitFor(() => expect(wrapper.getAttribute("data-editor")).toBe("codemirror"));
    const view = EditorView.findFromDOM(wrapper.querySelector(".cm-editor") as HTMLElement) as EditorView;
    const generated = JSON.stringify(GENERATED, null, 2);

    await click("f-generate"); // empty: no question
    await waitFor(() => expect(view.state.doc.toString()).toBe(generated));
    expect(screen.getByTestId("stored").textContent).toBe(JSON.stringify(GENERATED));

    replaceText(view, generated.slice(0, -1)); // a closing brace deleted: invalid text, the stored value stays the example
    await waitFor(() => expect(screen.getByTestId("f-validation").textContent).toMatch(/^Not valid JSON: /));
    expect(screen.getByTestId("stored").textContent).toBe(JSON.stringify(GENERATED));

    await click("f-generate");
    expect(screen.getByTestId("f-generate-confirm")).toBeTruthy();
    await click("f-generate-replace");
    await waitFor(() => expect(view.state.doc.toString()).toBe(generated));
    expect(screen.queryByTestId("f-validation")).toBeNull();
    expect(screen.getByTestId("stored").textContent).toBe(JSON.stringify(GENERATED));
  });

  it("shows no button outside the message example fields", () => {
    mount({ path: "/messages/0/bindings", context: { pinSchemas: { payload: ORDER } } });
    expect(screen.queryByTestId("f-generate")).toBeNull();
    cleanup();
    mount({ path: "/traits/0/examples/0/payload", context: { pinSchemas: { payload: ORDER } } });
    expect(screen.queryByTestId("f-generate")).toBeNull();
    cleanup();
    mount({ context: undefined });
    expect(screen.queryByTestId("f-generate")).toBeNull();
  });

  it("is disabled with the whole control", () => {
    mount({ disabled: true });
    expect((screen.getByTestId("f-generate") as HTMLButtonElement).disabled).toBe(true);
  });
});

describe("which fields are message examples", () => {
  it("recognises exactly /messages/{i}/examples/{n}/payload and /headers", () => {
    expect(exampleSource("/messages/0/examples/0/payload")).toBe("payload");
    expect(exampleSource("/messages/12/examples/3/headers")).toBe("headers");
    for (const other of [
      "/traits/0/examples/0/payload", "/messages/0/examples/payload", "/messages/0/examples/0/name", "/messages/0/bindings/kafka/key",
      "/messages/0/bindings/http/headers", "/messages/0/examples/0/payload/x", "messages/0/examples/0/payload", "",
    ]) expect(exampleSource(other), other).toBeNull();
  });

  it("hands each example field the schema of its own role, and null when there is none", () => {
    const context = { pinSchemas: { payload: ORDER, headers: TRACE } };
    expect(exampleSchema("/messages/0/examples/0/payload", context)).toBe(ORDER);
    expect(exampleSchema("/messages/0/examples/1/headers", context)).toBe(TRACE);
    expect(exampleSchema("/messages/0/examples/0/payload", { pinSchemas: { payload: null } })).toBeNull();
    expect(exampleSchema("/messages/0/examples/0/headers", { pinSchemas: { payload: ORDER } })).toBeNull();
    expect(exampleSchema("/messages/0/examples/0/payload", {})).toBeNull();
    expect(exampleSchema("/messages/0/examples/0/payload", undefined)).toBeNull();
    expect(exampleSchema("/traits/0/examples/0/payload", context)).toBeNull();
  });
});
