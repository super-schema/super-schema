// @vitest-environment jsdom
import { afterEach, describe, expect, it, vi } from "vitest";
import { cleanup, fireEvent, render, screen } from "@testing-library/react";
import { JsonSchemaVisualEditor } from "@/components/custom/VisualSchemaBuilder/JsonSchemaVisualEditor";
import type { JsonSchemaField } from "@/components/custom/VisualSchemaBuilder/serialize";

afterEach(cleanup);

/** The last document the editor reported, parsed. */
function lastDocument(onContentChange: ReturnType<typeof vi.fn>): Record<string, unknown> {
  const last = onContentChange.mock.calls.at(-1)?.[0] as string | null;
  if (!last) throw new Error("the editor reported no document");
  return JSON.parse(last) as Record<string, unknown>;
}

/** The editor's state with one field `age` of the given keywords. */
function hydrated(field: Omit<JsonSchemaField, "id" | "name" | "required" | "description">) {
  const age: JsonSchemaField = { id: "f1", name: "age", required: true, description: "", ...field };
  return { nonce: 1, state: { format: "json-schema" as const, title: "Ticket", description: "", fields: [age] } };
}

describe("JSON Schema visual editor: enum, const and default follow the field's type", () => {
  it("clears enum, const and default when the field's type changes", () => {
    const onContentChange = vi.fn();
    render(
      <JsonSchemaVisualEditor
        onContentChange={onContentChange}
        hydrate={hydrated({ type: "integer", enumValues: ["1", "2"], constValue: "1", defaultValue: "1" })}
      />
    );
    fireEvent.click(screen.getByTitle("Advanced options"));
    expect(screen.getByDisplayValue("1, 2")).toBeTruthy();

    fireEvent.change(screen.getByDisplayValue("integer"), { target: { value: "string" } });

    const property = (lastDocument(onContentChange).properties as Record<string, Record<string, unknown>>).age;
    expect(property).toEqual({ type: "string" });
    expect(screen.queryByDisplayValue("1, 2")).toBeNull();
  });

  it("reports an enum symbol that does not fit the field's type, and leaves it out of the schema", () => {
    const onContentChange = vi.fn();
    render(
      <JsonSchemaVisualEditor onContentChange={onContentChange} hydrate={hydrated({ type: "integer", enumValues: ["1", "two"] })} />
    );
    fireEvent.click(screen.getByTitle("Advanced options"));
    expect(screen.getByText(/Left out of the schema.*two/)).toBeTruthy();
    const property = (lastDocument(onContentChange).properties as Record<string, Record<string, unknown>>).age;
    expect(property.enum).toEqual([1]);
  });

  it("shows on the row, without opening Advanced options, that no enum value fits the type", () => {
    const onContentChange = vi.fn();
    render(
      <JsonSchemaVisualEditor onContentChange={onContentChange} hydrate={hydrated({ type: "boolean", enumValues: ["yes", "no"] })} />
    );
    expect(screen.getByText(/No enum value fits, so the property has no enum/)).toBeTruthy();
    const property = (lastDocument(onContentChange).properties as Record<string, Record<string, unknown>>).age;
    expect(property.enum).toBeUndefined();
  });
});
