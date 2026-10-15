// @vitest-environment jsdom
import { afterEach, describe, expect, it, vi } from "vitest";
import { cleanup, render, screen } from "@testing-library/react";
import { JsonSchemaVisualEditor } from "@/components/custom/VisualSchemaBuilder/JsonSchemaVisualEditor";
import { AvroVisualEditor } from "@/components/custom/VisualSchemaBuilder/AvroVisualEditor";
import { ProtobufVisualEditor } from "@/components/custom/VisualSchemaBuilder/ProtobufVisualEditor";
import { serializeFormState, type FormState } from "@/lib/schema-workbench/form-state";

afterEach(cleanup);

const json: FormState = {
  format: "json-schema",
  title: "Hydrated",
  description: "",
  fields: [{ id: "f1", name: "email", type: "string", required: true, description: "" }],
};
const avro: FormState = {
  format: "avro",
  name: "Hydrated",
  namespace: "",
  doc: "",
  fields: [{ id: "f1", name: "id", type: "long", nullable: false, doc: "" }],
};
const proto: FormState = {
  format: "protobuf",
  name: "Hydrated",
  packageName: "",
  fields: [{ id: "f1", name: "id", type: "string", fieldNumber: 1, repeated: false, doc: "" }],
};

describe.each([
  ["json-schema", JsonSchemaVisualEditor, json, "email"],
  ["avro", AvroVisualEditor, avro, "id"],
  ["protobuf", ProtobufVisualEditor, proto, "id"],
] as const)("%s editor hydrate", (_name, Editor, state, fieldName) => {
  it("replaces its state when the nonce changes and emits the matching text", () => {
    const onContentChange = vi.fn();
    const { rerender } = render(<Editor onContentChange={onContentChange} />);
    rerender(<Editor onContentChange={onContentChange} hydrate={{ nonce: 1, state }} />);

    expect(screen.getByDisplayValue("Hydrated")).toBeDefined();
    expect(screen.getByDisplayValue(fieldName)).toBeDefined();
    expect(onContentChange).toHaveBeenLastCalledWith(serializeFormState(state));
  });

  it("does not re-apply the same nonce", () => {
    const onContentChange = vi.fn();
    const { rerender } = render(<Editor onContentChange={onContentChange} hydrate={{ nonce: 1, state }} />);
    const calls = onContentChange.mock.calls.length;
    rerender(<Editor onContentChange={onContentChange} hydrate={{ nonce: 1, state }} />);
    expect(onContentChange.mock.calls.length).toBe(calls);
  });

  it("ignores state of another format", () => {
    const other = state.format === "avro" ? json : avro;
    render(<Editor onContentChange={vi.fn()} hydrate={{ nonce: 1, state: other }} />);
    expect(screen.queryByDisplayValue("Hydrated")).toBeNull();
  });
});
