// src/lib/events/import/payloads.ts
// Every payload and headers schema of every message of an AsyncAPI 3.0 document, ready to become an entity. Pure — client-safe.
import { err, ok, type Result } from "@/types/result";
import { boundText } from "./bound";
import { createRefResolver, type RefResolver } from "./refs";
import { indexMessages, isBag, type IndexedMessage } from "./message-index";
import type { ExtractedPayload, RawAsyncApi3 } from "./types";

type Format = ExtractedPayload["format"];

/** What a message's `payload` / `headers` value is. */
export interface PayloadDescription {
  format: Format;
  /** The `schemaFormat` string of a multi-format payload, as written. */
  schemaFormat?: string;
  /** The schema with every local `$ref` inlined (a protobuf source is text); `undefined` for `unsupported` and `none`. */
  raw?: unknown;
  /** Set when the schema refers to itself (a recursive type): the chain of references that closes the loop. The format is then `unsupported`. */
  recursive?: string[];
}

/** MIME types of the schema formats the importer reads, without parameters (`;version=…`) and with or without the `+json` / `+yaml` suffix. */
const FORMATS: ReadonlyArray<{ format: "json-schema" | "avro" | "protobuf"; mimeTypes: readonly string[] }> = [
  { format: "json-schema", mimeTypes: ["application/vnd.aai.asyncapi", "application/schema"] },
  { format: "avro", mimeTypes: ["application/vnd.apache.avro"] },
  { format: "protobuf", mimeTypes: ["application/vnd.google.protobuf"] },
];

/** AsyncAPI `schemaFormat` string → the importer's format; anything else (OpenAPI, RAML, …) is `unsupported`. */
export function detectSchemaFormat(schemaFormat: string): "json-schema" | "avro" | "protobuf" | "unsupported" {
  const mime = schemaFormat.split(";")[0].trim().toLowerCase().replace(/\+(json|yaml)$/, "");
  return FORMATS.find((entry) => entry.mimeTypes.includes(mime))?.format ?? "unsupported";
}

/** "order created" / "orderCreated" / "order.created" → "OrderCreated": letters and digits only, starts with a letter, at most 64 characters. */
export function pascalName(text: string): string {
  const words = text.match(/[A-Za-z0-9]+/g) ?? [];
  const joined = words.map((word) => word.charAt(0).toUpperCase() + word.slice(1)).join("");
  const name = joined === "" ? "Message" : /^[A-Za-z]/.test(joined) ? joined : `Message${joined}`;
  return name.slice(0, 64);
}

const nonBlank = (v: unknown): string | undefined => (typeof v === "string" && v.trim() !== "" ? v.trim() : undefined);

/** The entity name for a message: its `name`, else its `title`, else its key. */
export function suggestPayloadName(message: IndexedMessage, role: "payload" | "headers"): string {
  const base = pascalName(nonBlank(message.node.name) ?? nonBlank(message.node.title) ?? message.key);
  return role === "headers" ? `${base.slice(0, 57)}Headers` : base;
}

/**
 * What a message's field (`payload` or `headers`) holds: nothing, a schema in a format the importer reads (inlined, so it is self-contained),
 * or one it cannot use. A schema that refers to itself cannot become an entity: it is `unsupported` with `recursive` set, and ONLY that schema
 * is affected (any other broken reference still fails). `null` = the field is absent.
 * Headers are always JSON Schema (the assembler emits nothing else as headers), so headers in Avro or Protobuf are `unsupported`.
 */
export function describeSchemaField(refs: RefResolver, value: unknown, at: string, role: "payload" | "headers" = "payload"): Result<PayloadDescription | null> {
  if (value === undefined || value === null) return ok(null);
  const field = refs.deref(value, at);
  if (!field.success) return field;
  const node = field.data.value;
  if (node === undefined || node === null) return ok(null);

  let format: Format;
  let schemaNode: unknown;
  let schemaAt = field.data.pointer;
  const wrapped = isBag(node) && typeof node.schemaFormat === "string";
  if (wrapped) {
    // Multi Format Schema Object: { schemaFormat, schema }
    if (node.schema === undefined || node.schema === null) return ok({ format: "none", schemaFormat: node.schemaFormat as string });
    const schema = refs.deref(node.schema, `${field.data.pointer}/schema`);
    if (!schema.success) return schema;
    const detected = detectSchemaFormat(node.schemaFormat as string);
    const detectedForRole = role === "headers" && (detected === "avro" || detected === "protobuf") ? "unsupported" : detected;
    const usable = detectedForRole === "protobuf" ? typeof schema.data.value === "string" : (detectedForRole === "json-schema" || detectedForRole === "avro") && isBag(schema.data.value);
    format = usable ? detectedForRole : "unsupported";
    schemaNode = usable ? node.schema : undefined;
    schemaAt = `${field.data.pointer}/schema`;
  } else {
    // A bare Schema Object is the AsyncAPI schema format (JSON Schema)
    format = isBag(node) ? "json-schema" : "unsupported";
    schemaNode = isBag(node) ? node : undefined;
  }
  const schemaFormat = wrapped ? (node as { schemaFormat: string }).schemaFormat : undefined;
  const written = schemaFormat === undefined ? {} : { schemaFormat };
  if (schemaNode === undefined) return ok({ format, ...written });

  const inlined = refs.inlineSchema(schemaNode, schemaAt);
  if (!inlined.success) return inlined;
  if ("recursive" in inlined.data) return ok({ format: "unsupported", ...written, recursive: inlined.data.recursive });
  return ok({ format, ...written, raw: inlined.data.value });
}

/** The payload and the headers of one message, in that order; `headers` is absent when the message has none. */
export function describeMessageSchemas(refs: RefResolver, message: IndexedMessage): Result<{ payload: PayloadDescription; headers: PayloadDescription | null }> {
  const payload = describeSchemaField(refs, message.node.payload, `${message.pointer}/payload`, "payload");
  if (!payload.success) return payload;
  const headers = describeSchemaField(refs, message.node.headers, `${message.pointer}/headers`, "headers");
  if (!headers.success) return headers;
  return ok({ payload: payload.data ?? { format: "none" }, headers: headers.data });
}

/**
 * Every payload and headers schema of every message (component or inline), local `$ref`s inlined so each schema is self-contained.
 * A message without a payload still gets an entry (format `none`) so the event can pin a placeholder; headers are listed only when
 * the message has them. `messageKey` is the key the message gets in the event document (see `mapAsyncApiToEventDocument`).
 * A schema that refers to itself is listed as `unsupported` (no `raw`). An external or missing reference anywhere in the document, and a loop through a
 * chain of `$ref` wrappers in a payload or headers field, are errors. This reads schemas only: a loop through a trait, a binding, a message or an
 * example is found by the mapper (`mapAsyncApiToEventDocument`), not here.
 */
export function extractPayloads(raw: RawAsyncApi3): Result<ExtractedPayload[]> {
  try {
    const refs = createRefResolver(raw);
    const checked = refs.check({ tolerateCycles: true }); // a recursive SCHEMA is reported per payload below; other loops fail when they are read
    if (!checked.success) return checked;
    const index = indexMessages(raw, refs);
    if (!index.success) return index;
    const out: ExtractedPayload[] = [];
    for (const message of index.data.messages) {
      const described = describeMessageSchemas(refs, message);
      if (!described.success) return described;
      const roles: Array<["payload" | "headers", PayloadDescription | null]> = [["payload", described.data.payload], ["headers", described.data.headers]];
      for (const [role, description] of roles) {
        if (!description || (role === "headers" && description.format === "none")) continue; // no headers = no entry; no payload still needs a placeholder
        out.push({ messageKey: message.key, role, sourcePointer: `${message.pointer}/${role}`, format: description.format, raw: description.raw, suggestedName: suggestPayloadName(message, role) });
      }
    }
    return ok(out);
  } catch (e) {
    return err({ code: "IMPORT_FAILED", message: "The AsyncAPI document could not be processed; it is probably too large or too deeply nested.", details: { reason: boundText(e instanceof Error ? e.message : e, 200) } });
  }
}
