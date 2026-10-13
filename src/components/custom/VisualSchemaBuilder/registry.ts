import type { VisualFormat } from "./types";
import { JsonSchemaVisualEditor } from "./JsonSchemaVisualEditor";
import { AvroVisualEditor } from "./AvroVisualEditor";
import { ProtobufVisualEditor } from "./ProtobufVisualEditor";

/**
 * Registered visual editors, in display order. Each editor emits its format's
 * native text; the matching importer (avro.importer, protobuf.importer,
 * jsonschema importer) already exists and maps it into the IR.
 */
export const VISUAL_FORMATS: VisualFormat[] = [
  {
    id: "json-schema",
    label: "JSON Schema",
    enabled: true,
    Editor: JsonSchemaVisualEditor,
  },
  {
    id: "avro",
    label: "Avro",
    enabled: true,
    Editor: AvroVisualEditor,
  },
  {
    id: "protobuf",
    label: "Protobuf",
    enabled: true,
    Editor: ProtobufVisualEditor,
  },
];
