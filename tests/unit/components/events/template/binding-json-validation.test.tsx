// @vitest-environment jsdom
// The raw-JSON fields of a protocol binding are checked against the AsyncAPI binding schemas: BindingsForm -> TemplateForm -> FieldControl
// (which looks the schema up from the field's pointer) -> JsonControl -> the REAL CodeMirror editor (jsdom with the stand-ins of
// ./codemirror-jsdom) and the REAL `codemirror-json-schema` (loaded because vitest.config.ts inlines it).
// A schema violation is only ever a warning marker: the value is written all the same.
import "./codemirror-jsdom";
import { forceLinting, forEachDiagnostic } from "@codemirror/lint";
import { EditorView } from "@codemirror/view";
import { act, cleanup, configure, render, screen, waitFor } from "@testing-library/react";
import { useEffect, useState } from "react";
import { afterEach, describe, expect, it, vi } from "vitest";
import { BindingsForm } from "@/features/events/builder/template";
import { bindingVersion } from "@/lib/events/templates";

// Markers arrive after the linter's 250 ms delay (or at once when forced); a loaded machine needs more than the 1 s default.
configure({ asyncUtilTimeout: 4000 });
afterEach(cleanup);

type Target = "server" | "channel" | "operation" | "message";
type Props = Partial<Omit<Parameters<typeof BindingsForm>[0], "value" | "onChange">> & { value?: Record<string, unknown>; target?: Target };

function renderBindings({ value: initial = {}, target = "channel", ...props }: Props = {}) {
  const probe = {
    value: initial as Record<string, unknown>,
    onChange: vi.fn<(next: Record<string, unknown>) => void>(),
  };
  function Harness() {
    const [value, setValue] = useState<Record<string, unknown>>(initial);
    useEffect(() => { probe.value = value; });
    return (
      <BindingsForm
        target={target} idPrefix="b" {...props} value={value}
        onChange={(next) => {
          probe.onChange(next);
          setValue(next);
        }}
      />
    );
  }
  return { ...render(<Harness />), probe };
}

const sleep = (ms: number) => new Promise<void>((resolve) => { setTimeout(resolve, ms); });

interface Marker { severity: string; message: string; source: string | undefined; text: string }
function markers(view: EditorView): Marker[] {
  const found: Marker[] = [];
  forEachDiagnostic(view.state, (d, from, to) => found.push({ severity: d.severity, message: d.message, source: d.source, text: view.state.sliceDoc(from, to) }));
  return found;
}
const replaceDoc = (view: EditorView, text: string) => act(() => { view.dispatch({ changes: { from: 0, to: view.state.doc.length, insert: text }, userEvent: "input.paste" }); });

/** The editor of one field, once CodeMirror has taken over from the textarea. `fieldId` is the control's id (`b-kafka-groupId`). */
async function editorOf(fieldId: string): Promise<EditorView> {
  const frame = await screen.findByTestId(`${fieldId}-field`);
  await waitFor(() => expect(frame.querySelector(".cm-editor")).not.toBeNull());
  return EditorView.findFromDOM(frame.querySelector(".cm-editor") as HTMLElement) as EditorView;
}

const V = (protocol: string, target: Target) => bindingVersion(protocol, target)!;

describe("a binding's raw-JSON field is checked against its AsyncAPI binding schema", () => {
  const GROUP = "b-kafka-groupId";
  const kafkaOperation = (groupId: unknown) => ({ kafka: { groupId, bindingVersion: V("kafka", "operation") } });
  const mountGroupId = (groupId: unknown) =>
    renderBindings({ target: "operation", errorPrefix: "/operations/2/bindings", value: kafkaOperation(groupId) });

  it("warns about a Kafka group id that is not a JSON Schema, and still writes it", async () => {
    const { probe } = mountGroupId({ type: "string", enum: ["billing"] });
    const view = await editorOf(GROUP);
    await sleep(400);
    expect(markers(view)).toEqual([]);

    replaceDoc(view, '"billing"');
    expect(probe.onChange).toHaveBeenLastCalledWith(kafkaOperation("billing"));
    expect(probe.value).toEqual(kafkaOperation("billing"));
    await waitFor(() => expect(markers(view)).toHaveLength(1));
    const [marker] = markers(view);
    expect(marker.severity).toBe("warning");
    expect(marker.message).toMatch(/object/);
    expect(marker.message).toMatch(/object/);
    expect(marker.message).toMatch(/received `string`/);
    // a warning is not a problem of the field: no error text, no aria-invalid
    expect(screen.queryByTestId(`${GROUP}-validation`)).toBeNull();
    expect(screen.queryByTestId(`${GROUP}-error`)).toBeNull();
    expect(view.contentDOM.hasAttribute("aria-invalid")).toBe(false);
  });

  it("warns about a number too, and about a JSON Schema whose keyword has the wrong type, each on its own value", async () => {
    mountGroupId({ type: "string" });
    const view = await editorOf(GROUP);

    replaceDoc(view, "5");
    await waitFor(() => expect(markers(view).map((m) => m.text)).toEqual(["5"]));

    replaceDoc(view, '{ "type": "strng" }');
    await waitFor(() => expect(markers(view).map((m) => m.text)).toEqual(['"strng"']));

    replaceDoc(view, '{ "type": "object", "required": "id" }');
    await waitFor(() => expect(markers(view).map((m) => m.text)).toEqual(['"id"']));
    expect(new Set(markers(view).map((m) => m.severity))).toEqual(new Set(["warning"]));
  });

  it("clears the warning as soon as the value is a schema, and a JSON Schema with an x- extension or a $ref is fine", async () => {
    const { probe } = mountGroupId("billing");
    const view = await editorOf(GROUP);
    await waitFor(() => expect(markers(view)).toHaveLength(1));

    replaceDoc(view, '{ "type": "string", "enum": ["billing"], "x-owner": "payments" }');
    await waitFor(() => expect(markers(view)).toEqual([]));
    expect(probe.value).toEqual(kafkaOperation({ type: "string", enum: ["billing"], "x-owner": "payments" }));

    replaceDoc(view, '{ "$ref": "#/components/schemas/Group" }');
    forceLinting(view);
    await sleep(400);
    expect(markers(view)).toEqual([]);
  });

  it("keeps the syntax error of invalid JSON as the field's problem, with no schema warning on top", async () => {
    const { probe } = mountGroupId({ type: "string" });
    const view = await editorOf(GROUP);
    probe.onChange.mockClear();

    replaceDoc(view, '{ "type": ');
    expect(screen.getByTestId(`${GROUP}-validation`).textContent).toMatch(/^Not valid JSON: /);
    expect(probe.onChange).not.toHaveBeenCalled();
    await waitFor(() => expect(markers(view)).toHaveLength(1));
    expect(markers(view)[0]).toMatchObject({ severity: "error", source: "JSON" });
  });

  it("shows no warning for a valid object in a field that takes a schema or a reference to one (anypointmq message headers)", async () => {
    const headers = { type: "object", properties: { messageId: { type: "string" } } };
    renderBindings({
      target: "message", errorPrefix: "/messages/1/bindings",
      value: { anypointmq: { headers, bindingVersion: V("anypointmq", "message") } },
    });
    const view = await editorOf("b-anypointmq-headers");
    await sleep(400);
    expect(markers(view)).toEqual([]);

    // a reference to a schema is as good as a schema
    replaceDoc(view, '{ "$ref": "#/components/schemas/Headers" }');
    forceLinting(view);
    await sleep(400);
    expect(markers(view)).toEqual([]);

    // but a list is neither
    replaceDoc(view, '["messageId"]');
    await waitFor(() => expect(markers(view)).toHaveLength(1));
    expect(markers(view)[0].severity).toBe("warning");
  });

  it("checks the fields inside lists at their own pointers (an SNS policy statement's principal, action and resource)", async () => {
    const statement = { effect: "Allow", principal: 5, action: "sns:Publish", resource: ["arn:aws:sns:eu-west-1:1:orders"] };
    renderBindings({
      target: "channel", errorPrefix: "/channels/0/bindings",
      value: { sns: { policy: { statements: [statement] }, bindingVersion: V("sns", "channel") } },
    });
    const principal = await editorOf("b-sns-policy-statements-0-principal");
    const action = await editorOf("b-sns-policy-statements-0-action");
    const resource = await editorOf("b-sns-policy-statements-0-resource");
    await waitFor(() => expect(markers(principal)).toHaveLength(1));
    expect(markers(principal)[0]).toMatchObject({ severity: "warning", text: "5" });
    await sleep(400);
    expect(markers(action)).toEqual([]);
    expect(markers(resource)).toEqual([]);

    replaceDoc(principal, '{ "AWS": "arn:aws:iam::123456789012:root" }');
    await waitFor(() => expect(markers(principal)).toEqual([]));
  });

  it("checks the value of a JMS server property, and nothing in the server binding's other fields", async () => {
    renderBindings({
      target: "server", errorPrefix: "/servers/3/bindings",
      value: { jms: { properties: [{ name: "retries", value: { not: "a scalar" } }], bindingVersion: V("jms", "server") } },
    });
    const value = await editorOf("b-jms-properties-0-value");
    await waitFor(() => expect(markers(value)).toHaveLength(1));
    expect(markers(value)[0].severity).toBe("warning");
    replaceDoc(value, "3");
    await waitFor(() => expect(markers(value)).toEqual([]));
  });

  it("does not check the JSON fallback of a protocol the catalog does not know, nor a pointer that is not a binding", async () => {
    renderBindings({ target: "channel", errorPrefix: "/channels/0/bindings", value: { acme: { retries: "many", nested: { anything: [1, 2] } } } });
    const view = await editorOf("b-acme-json");
    await sleep(400);
    expect(markers(view)).toEqual([]);
    replaceDoc(view, "5");
    forceLinting(view);
    await sleep(400);
    expect(markers(view)).toEqual([]);
  });
});
