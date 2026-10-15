/**
 * Form state for the three visual builders, plus a single serialize entry point.
 * The Schema Workbench uses this to keep the Detail Panel text and the form in sync.
 */

import type { AvroField } from "@/components/custom/VisualSchemaBuilder/avro-serialize";
import { serializeAvroSchema } from "@/components/custom/VisualSchemaBuilder/avro-serialize";
import type { ProtoField } from "@/components/custom/VisualSchemaBuilder/protobuf-serialize";
import { serializeProtobufSchema } from "@/components/custom/VisualSchemaBuilder/protobuf-serialize";
import type { JsonSchemaField } from "@/components/custom/VisualSchemaBuilder/serialize";
import { serializeJsonSchema } from "@/components/custom/VisualSchemaBuilder/serialize";

export type WorkbenchFormat = "json-schema" | "avro" | "protobuf";

export type FormState =
  | { format: "json-schema"; title: string; description: string; fields: JsonSchemaField[] }
  | { format: "avro"; name: string; namespace: string; doc: string; fields: AvroField[] }
  | { format: "protobuf"; name: string; packageName: string; fields: ProtoField[] };

export function isWorkbenchFormat(value: string | null | undefined): value is WorkbenchFormat {
  return value === "json-schema" || value === "avro" || value === "protobuf";
}

/** Native text for a form state, or null when the state is incomplete. */
export function serializeFormState(state: FormState): string | null {
  switch (state.format) {
    case "json-schema":
      return serializeJsonSchema(state.title, state.description, state.fields);
    case "avro":
      return serializeAvroSchema(state.name, state.namespace, state.doc, state.fields);
    case "protobuf":
      return serializeProtobufSchema(state.name, state.packageName, state.fields);
  }
}
