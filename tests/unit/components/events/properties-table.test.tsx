// @vitest-environment jsdom
import { useEffect, useState } from "react";
import { act, cleanup, fireEvent, render, screen, within } from "@testing-library/react";
import { afterEach, describe, expect, it } from "vitest";
import type { JsonObject } from "@/lib/event-specs/types";
import { BUNDLED_TRAITS } from "@/lib/events/bundled-traits";
import { PropertiesTable } from "@/features/events/builder/sections/PropertiesTable";
import { BUILT_IN_NOTE, LIBRARY_NOTE } from "@/features/events/builder/labels";

afterEach(cleanup);

const cloudEventsHeaders = BUNDLED_TRAITS.find((t) => t.name === "CloudEvents")!.spec.headers as JsonObject;
const type = (el: HTMLElement, value: string) => fireEvent.change(el, { target: { value } });
const id = (testId: string) => screen.getByTestId(testId);
const input = (testId: string) => screen.getByTestId(testId) as HTMLInputElement;
const select = (testId: string) => screen.getByTestId(testId) as HTMLSelectElement;
const missing = (testId: string) => screen.queryByTestId(testId) === null;

/** An editable table backed by real state; `probe.headers` is the latest value the table wrote. */
function renderEditable(initial: unknown) {
  const probe: { headers: unknown; calls: unknown[]; set: (next: unknown) => void } = { headers: initial, calls: [], set: () => undefined };
  function Host() {
    const [headers, setHeaders] = useState<unknown>(initial);
    useEffect(() => {
      Object.assign(probe, { headers, set: setHeaders });
    }, [headers]);
    return <PropertiesTable idPrefix="t" headers={headers} onChange={(next) => { probe.calls.push(next); setHeaders(next); }} />;
  }
  const view = render(<Host />);
  return { probe, setOutside: (next: unknown) => act(() => probe.set(next)), ...view };
}

describe("PropertiesTable: read-only", () => {
  it("shows the columns Name, Type, Required and Description", () => {
    render(<PropertiesTable idPrefix="t" headers={cloudEventsHeaders} readOnly />);
    const head = within(id("t-table")).getAllByRole("columnheader").map((h) => h.textContent);
    expect(head).toEqual(["Name", "Type", "Required", "Description"]);
  });

  it("lists the built-in CloudEvents properties: required first, friendly types, descriptions", () => {
    render(<PropertiesTable idPrefix="t" headers={cloudEventsHeaders} readOnly />);
    const names = within(id("t-table")).getAllByRole("rowheader").map((h) => h.textContent);
    expect(names).toEqual(["specversion", "id", "source", "type", "subject", "time", "datacontenttype", "dataschema"]);
    expect(id("t-row-source-type").textContent).toBe("Link");
    expect(id("t-row-time-type").textContent).toBe("Date-time");
    expect(id("t-row-id-type").textContent).toBe("Text");
    expect(id("t-row-id-required").textContent).toBe("Required");
    expect(id("t-row-subject-required").textContent).toBe("Optional");
    expect(id("t-row-id-description").textContent).toContain("Identifies the event");
  });

  it("shows a const as 'Always <value>' chips and an enum as 'One of' chips", () => {
    render(<PropertiesTable idPrefix="t" readOnly headers={{ type: "object", properties: { specversion: { type: "string", const: "1.0" }, level: { type: "string", enum: ["a", "b"] } } }} />);
    expect(id("t-row-specversion-allowed").textContent).toBe("Always1.0");
    expect(id("t-row-level-allowed").textContent).toBe("One ofab");
    expect(id("t-row-level-allowed-chip-1").textContent).toBe("b");
  });

  it("has no input, select or button: nothing can be edited", () => {
    render(<PropertiesTable idPrefix="t" headers={cloudEventsHeaders} readOnly note={BUILT_IN_NOTE} />);
    const root = id("t-properties");
    expect(root.querySelectorAll("input, select, textarea, button")).toHaveLength(0);
    expect(missing("t-add")).toBe(true);
  });

  it("shows the lock note when given one, for built-in and library sets", () => {
    const { rerender } = render(<PropertiesTable idPrefix="t" headers={cloudEventsHeaders} readOnly note={BUILT_IN_NOTE} />);
    expect(id("t-note").textContent).toBe("Built in — can't be modified");
    expect(id("t-note").querySelector("svg")).not.toBeNull();
    rerender(<PropertiesTable idPrefix="t" headers={cloudEventsHeaders} readOnly note={LIBRARY_NOTE} />);
    expect(id("t-note").textContent).toBe("From the library — edit it under Message properties at the Tenant/Domain level");
  });

  it("is read-only whenever there is no onChange, even without the readOnly flag", () => {
    render(<PropertiesTable idPrefix="t" headers={cloudEventsHeaders} />);
    expect(missing("t-add")).toBe(true);
    expect(screen.getByTestId("t-row-id")).toBeDefined();
  });

  it("falls back to the loader's summary when there is no headers schema", () => {
    render(<PropertiesTable idPrefix="t" summary={[{ name: "traceparent", type: "string", required: true, description: "The trace" }, { name: "when", type: "string (date-time)", required: false }]} />);
    expect(id("t-row-traceparent-type").textContent).toBe("Text");
    expect(id("t-row-when-type").textContent).toBe("Date-time");
    expect(id("t-row-traceparent-description").textContent).toBe("The trace");
  });

  it("prefers the headers schema over the summary", () => {
    render(<PropertiesTable idPrefix="t" headers={{ type: "object", properties: { a: { type: "integer" } } }} summary={[{ name: "b", type: "string", required: false }]} />);
    expect(screen.queryByTestId("t-row-a")).not.toBeNull();
    expect(screen.queryByTestId("t-row-b")).toBeNull();
  });

  it("says there are no properties for an empty set", () => {
    render(<PropertiesTable idPrefix="t" headers={undefined} readOnly />);
    expect(id("t-empty").textContent).toBe("No properties.");
  });

  it("lists the rows in the same order whatever the key order of the stored object is", () => {
    const shuffled = { required: ["id", "type"], properties: { type: { type: "string" }, time: { type: "string" }, id: { type: "string" } }, type: "object" };
    render(<PropertiesTable idPrefix="t" headers={shuffled} readOnly />);
    expect(within(id("t-table")).getAllByRole("rowheader").map((h) => h.textContent)).toEqual(["id", "type", "time"]);
  });
});

describe("PropertiesTable: editable", () => {
  it("starts empty with an Add property button", () => {
    renderEditable(undefined);
    expect(id("t-empty").textContent).toContain("No properties yet");
    expect(id("t-add").textContent).toContain("Add property");
    expect(missing("t-table")).toBe(true);
  });

  it("adds a row, focuses its name and writes nothing until it has a name", () => {
    const { probe } = renderEditable(undefined);
    fireEvent.click(id("t-add"));
    expect(document.activeElement).toBe(input("t-name-0"));
    expect(probe.headers).toBeUndefined();
    expect(id("t-problem-0").textContent).toBe("Give it a name to save it.");
    expect(input("t-name-0").getAttribute("aria-invalid")).toBe("true");
  });

  it("generates spec.headers as an object schema with properties and required", () => {
    const { probe } = renderEditable(undefined);
    fireEvent.click(id("t-add"));
    type(input("t-name-0"), "correlationId");
    fireEvent.click(id("t-required-0"));
    type(input("t-description-0"), "Ties a request to its reply");
    expect(probe.headers).toEqual({
      type: "object", properties: { correlationId: { type: "string", description: "Ties a request to its reply" } }, required: ["correlationId"],
    });
    fireEvent.click(id("t-add"));
    type(input("t-name-1"), "attempt");
    type(select("t-type-1"), "integer");
    expect(probe.headers).toEqual({
      type: "object",
      properties: { correlationId: { type: "string", description: "Ties a request to its reply" }, attempt: { type: "integer" } },
      required: ["correlationId"],
    });
  });

  it("offers the six friendly types and writes each one", () => {
    const { probe } = renderEditable({ type: "object", properties: { a: { type: "string" } } });
    expect(Array.from(select("t-type-0").options).map((o) => o.textContent)).toEqual(["Text", "Whole number", "Decimal", "True/false", "Date-time", "Link"]);
    const expected: Record<string, JsonObject> = {
      integer: { type: "integer" }, number: { type: "number" }, boolean: { type: "boolean" },
      "date-time": { type: "string", format: "date-time" }, link: { type: "string", format: "uri" }, text: { type: "string" },
    };
    for (const [choice, schema] of Object.entries(expected)) {
      type(select("t-type-0"), choice);
      expect((probe.headers as { properties: { a: unknown } }).properties.a).toEqual(schema);
      expect(select("t-type-0").value).toBe(choice);
    }
  });

  it("shows a type it has no friendly name for, and keeps it until another is chosen", () => {
    const { probe } = renderEditable({ type: "object", properties: { tags: { type: "array", items: { type: "string" } } } });
    expect(select("t-type-0").value).toBe("other");
    expect(select("t-type-0").selectedOptions[0].textContent).toBe("List");
    type(id("t-description-0"), "Labels");
    expect((probe.headers as { properties: { tags: unknown } }).properties.tags).toEqual({ type: "array", items: { type: "string" }, description: "Labels" });
  });

  it("toggles required and keeps the row order", () => {
    const { probe } = renderEditable({ type: "object", properties: { a: { type: "string" }, b: { type: "string" } }, required: ["a"] });
    expect(input("t-required-0").checked).toBe(true);
    expect(input("t-required-1").checked).toBe(false);
    fireEvent.click(id("t-required-1"));
    expect((probe.headers as { required: string[] }).required).toEqual(["a", "b"]);
    fireEvent.click(id("t-required-0"));
    expect((probe.headers as { required: string[] }).required).toEqual(["b"]);
    fireEvent.click(id("t-required-1"));
    expect("required" in (probe.headers as object)).toBe(false);
  });

  it("removes a row, and removes `headers` when the last row goes", () => {
    const { probe } = renderEditable({ type: "object", properties: { a: { type: "string" }, b: { type: "string" } } });
    fireEvent.click(id("t-remove-0"));
    expect(probe.headers).toEqual({ type: "object", properties: { b: { type: "string" } } });
    expect(screen.getByTestId("t-remove-0").getAttribute("aria-label")).toBe("Remove property b");
    fireEvent.click(id("t-remove-0"));
    expect(probe.headers).toBeUndefined();
    expect(id("t-empty")).toBeDefined();
  });

  it("renames a property and moves its schema with it", () => {
    const { probe } = renderEditable({ type: "object", properties: { a: { type: "integer", description: "d" } }, required: ["a"] });
    type(input("t-name-0"), "count");
    expect(probe.headers).toEqual({ type: "object", properties: { count: { type: "integer", description: "d" } }, required: ["count"] });
  });

  it("writes allowed values as chips: Enter and comma add, a chip's remove button takes it off, an empty list removes the restriction", () => {
    const { probe } = renderEditable({ type: "object", properties: { level: { type: "string" } } });
    const field = input("t-allowed-0");
    type(field, "info");
    fireEvent.keyDown(field, { key: "Enter" });
    type(field, "warn");
    fireEvent.keyDown(field, { key: "," });
    type(field, "error");
    fireEvent.blur(field);
    expect((probe.headers as { properties: { level: unknown } }).properties.level).toEqual({ type: "string", enum: ["info", "warn", "error"] });
    expect(id("t-allowed-0-chip-1").textContent).toBe("warn");
    fireEvent.click(id("t-allowed-0-chip-1-remove"));
    expect((probe.headers as { properties: { level: unknown } }).properties.level).toEqual({ type: "string", enum: ["info", "error"] });
    fireEvent.click(id("t-allowed-0-chip-0-remove"));
    fireEvent.click(id("t-allowed-0-chip-0-remove"));
    expect((probe.headers as { properties: { level: unknown } }).properties.level).toEqual({ type: "string" });
  });

  it("splits pasted text on commas and ignores repeats", () => {
    const { probe } = renderEditable({ type: "object", properties: { level: { type: "string" } } });
    type(input("t-allowed-0"), "a, b, a,, c");
    fireEvent.keyDown(input("t-allowed-0"), { key: "Enter" });
    expect((probe.headers as { properties: { level: { enum: string[] } } }).properties.level.enum).toEqual(["a", "b", "c"]);
  });

  it("stores numbers for the allowed values of a whole number", () => {
    const { probe } = renderEditable({ type: "object", properties: { n: { type: "integer" } } });
    type(input("t-allowed-0"), "1, 2");
    fireEvent.blur(input("t-allowed-0"));
    expect((probe.headers as { properties: { n: { enum: number[] } } }).properties.n.enum).toEqual([1, 2]);
  });

  it("shows the allowed values a property already has as chips", () => {
    renderEditable({ type: "object", properties: { specversion: { type: "string", const: "1.0" } } });
    expect(id("t-allowed-0-chip-0").textContent).toBe("1.0");
  });

  it("does not store a row with a repeated name and says so", () => {
    const { probe } = renderEditable({ type: "object", properties: { id: { type: "string" } } });
    fireEvent.click(id("t-add"));
    type(input("t-name-1"), "id");
    expect(probe.headers).toEqual({ type: "object", properties: { id: { type: "string" } } });
    expect(id("t-problem-1").textContent).toBe('"id" is already used; this row is not saved.');
    expect(missing("t-problem-0")).toBe(true);
    type(input("t-name-1"), "other");
    expect(Object.keys((probe.headers as { properties: object }).properties)).toEqual(["id", "other"]);
    expect(missing("t-problem-1")).toBe(true);
  });

  it("does not call onChange for an edit that changes nothing it can store", () => {
    const { probe } = renderEditable(undefined);
    fireEvent.click(id("t-add"));
    type(input("t-name-0"), "  ");
    expect(probe.calls).toEqual([]);
  });
});

describe("PropertiesTable: nothing it does not understand is lost", () => {
  const rich: JsonObject = {
    type: "object", additionalProperties: false, title: "Envelope",
    properties: {
      specversion: { type: "string", const: "1.0", description: "Always 1.0" },
      source: { type: "string", format: "uri-reference", minLength: 1, "x-owner": "platform" },
      nested: { type: "object", properties: { deep: { type: "integer", minimum: 3 } }, required: ["deep"] },
    },
    required: ["specversion", "source"],
  };

  it("keeps const, format, minLength, extensions and nested keys when another property is edited", () => {
    const { probe } = renderEditable(rich);
    fireEvent.click(id("t-required-2"));
    const written = probe.headers as { properties: Record<string, unknown>; required: string[] };
    expect(written.properties.specversion).toEqual({ type: "string", const: "1.0", description: "Always 1.0" });
    expect(written.properties.source).toEqual({ type: "string", format: "uri-reference", minLength: 1, "x-owner": "platform" });
    expect(written.properties.nested).toEqual({ type: "object", properties: { deep: { type: "integer", minimum: 3 } }, required: ["deep"] });
    expect(written.required).toEqual(["specversion", "source", "nested"]);
  });

  it("keeps the keys of the headers object the table does not manage", () => {
    const { probe } = renderEditable(rich);
    fireEvent.click(id("t-remove-2"));
    expect(probe.headers).toMatchObject({ type: "object", additionalProperties: false, title: "Envelope" });
  });

  it("keeps const and the uri-reference format when only the description of that property changes", () => {
    const { probe } = renderEditable(rich);
    type(input("t-description-1"), "Where it came from");
    expect((probe.headers as { properties: { source: unknown } }).properties.source).toEqual({
      type: "string", format: "uri-reference", minLength: 1, "x-owner": "platform", description: "Where it came from",
    });
  });

  it("shows a link as Link and keeps uri-reference until the type is really changed", () => {
    const { probe } = renderEditable(rich);
    expect(select("t-type-1").value).toBe("link");
    type(select("t-type-1"), "link");
    expect((probe.headers as { properties: { source: { format: string } } }).properties.source.format).toBe("uri-reference");
    type(select("t-type-1"), "text");
    expect((probe.headers as { properties: { source: unknown } }).properties.source).toEqual({ type: "string", minLength: 1, "x-owner": "platform" });
  });

  it("round-trips the real CloudEvents definition through the table without writing anything", () => {
    const { probe } = renderEditable(cloudEventsHeaders);
    expect(probe.calls).toEqual([]);
    expect(screen.getAllByRole("row")).toHaveLength(9);
  });
});

describe("PropertiesTable: ordering and outside changes", () => {
  it("orders rows required first, then the rest, whatever order the stored object lists them", () => {
    renderEditable({ required: ["b"], type: "object", properties: { c: { type: "string" }, a: { type: "string" }, b: { type: "string" } } });
    expect([0, 1, 2].map((i) => input(`t-name-${i}`).value)).toEqual(["b", "c", "a"]);
  });

  it("shows new headers that arrive from outside, but keeps a row that is not stored yet", () => {
    const { setOutside } = renderEditable({ type: "object", properties: { a: { type: "string" } } });
    fireEvent.click(id("t-add"));
    expect(input("t-name-1").value).toBe("");
    setOutside({ type: "object", properties: { a: { type: "string" } } });
    expect(input("t-name-1").value).toBe("");
    setOutside({ type: "object", properties: { x: { type: "integer" }, y: { type: "integer" } } });
    expect([0, 1].map((i) => input(`t-name-${i}`).value)).toEqual(["x", "y"]);
    expect(missing("t-name-2")).toBe(true);
  });

  it("does not reset its rows when the same headers come back with their keys in another order", () => {
    const { probe, setOutside } = renderEditable({ type: "object", properties: { a: { type: "string" }, b: { type: "string" } } });
    fireEvent.click(id("t-remove-0"));
    fireEvent.click(id("t-add"));
    type(input("t-name-1"), "z");
    const written = probe.headers as { properties: Record<string, unknown> };
    setOutside({ properties: { z: written.properties.z, b: written.properties.b }, type: "object" });
    expect([0, 1].map((i) => input(`t-name-${i}`).value)).toEqual(["b", "z"]);
  });
});

describe("PropertiesTable: accessibility", () => {
  it("names every input with its row and column", () => {
    renderEditable({ type: "object", properties: { a: { type: "string" } } });
    expect(screen.getByLabelText("Property 1: name")).toBe(input("t-name-0"));
    expect(screen.getByLabelText("Property 1: type")).toBe(select("t-type-0"));
    expect(screen.getByLabelText("Property 1: required")).toBe(id("t-required-0"));
    expect(screen.getByLabelText("Property 1: description")).toBe(input("t-description-0"));
    expect(screen.getByLabelText("Property 1: allowed values")).toBe(input("t-allowed-0"));
  });

  it("uses real table markup with column headers and a caption", () => {
    renderEditable({ type: "object", properties: { a: { type: "string" } } });
    expect(within(id("t-table")).getAllByRole("columnheader").map((h) => h.textContent)).toEqual(["Name", "Type", "Required", "Description", "Remove"]);
    expect(id("t-table").querySelector("caption")?.textContent).toBe("Properties");
  });

  it("disables every input when asked", () => {
    const { rerender } = render(<PropertiesTable idPrefix="d" headers={{ type: "object", properties: { a: {} } }} onChange={() => undefined} disabled />);
    expect(Array.from(document.querySelectorAll("input, select, button")).every((e) => (e as HTMLInputElement).disabled)).toBe(true);
    rerender(<PropertiesTable idPrefix="d" headers={{ type: "object", properties: { a: {} } }} onChange={() => undefined} />);
    expect((screen.getByTestId("d-name-0") as HTMLInputElement).disabled).toBe(false);
  });
});
