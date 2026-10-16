// src/lib/events/bundled-traits.ts
// Built-in Message properties (library traits every tenant gets) and the helpers that read a trait's properties. Pure — client-safe.
//
// A "bundled" trait is an ordinary library trait (`traits` row, tenant level) whose `spec` carries the marker `"x-bundled": "<id>@<version>"`.
// The properties it defines are an INLINE headers schema, `spec.headers` (a JSON Schema object): nothing is an entity, nothing is pinned, so
// the assembler emits `components.messageTraits.<key>.headers` straight from the stored spec. The trait service refuses to update or delete
// a trait that carries the marker and refuses to create one that claims it (`isBundledTrait`), so a built-in definition cannot be changed
// or forged through the API; `ensureBundledTraits` (services/events/bundled-traits.service.ts) is the only writer.
//
// Changing a definition = a NEW id (`cloudevents@1.1`) and a new name, never an edit: events pin trait rows by id and published versions
// freeze what they used, and `ensureBundledTraits` never edits a row it already created.
import type { JsonObject } from "@/lib/event-specs/types";
import { isJsonObject } from "@/lib/events/inputs";

/** The `spec` key that marks a trait as built in. The value is the definition's `id` (`cloudevents@1.0`). */
export const BUNDLED_MARKER_KEY = "x-bundled";

/** One built-in definition. `id` is the marker value stored in `spec["x-bundled"]`; `name` becomes the library trait's name. */
export interface BundledTrait {
  /** `<product>@<version>`, e.g. `cloudevents@1.0`: stored as `spec["x-bundled"]`, never reused for a different definition. */
  id: string;
  /** The library trait's name at tenant level (an AsyncAPI component key: letters, digits, `.`, `_`, `-`). */
  name: string;
  kind: "MESSAGE";
  /** The AsyncAPI Message Trait object stored in the row: `summary`, `description`, `headers` (JSON Schema object) and the marker. */
  spec: JsonObject;
}

/** One property of a trait's inline headers schema, as a table row. */
export interface PropertySummaryRow {
  name: string;
  /** The JSON Schema `type` (`string`, `integer`, `string | null`), followed by the `format` in brackets when there is one (`string (date-time)`); `any` when the schema has no type. */
  type: string;
  /** Listed in the headers schema's `required`. */
  required: boolean;
  description?: string;
}

function deepFreeze<T>(value: T): T {
  if (typeof value === "object" && value !== null && !Object.isFrozen(value)) {
    Object.freeze(value);
    for (const child of Object.values(value)) deepFreeze(child);
  }
  return value;
}

const CLOUDEVENTS_ID = "cloudevents@1.0";
const TRACE_CONTEXT_ID = "w3c-trace-context@1";

/**
 * CloudEvents 1.0 context attributes (CNCF CloudEvents spec v1.0.2, "Context Attributes"): the four REQUIRED ones
 * (`specversion`, `id`, `source`, `type`) and the four OPTIONAL ones that are not extensions.
 */
const cloudEvents: BundledTrait = {
  id: CLOUDEVENTS_ID,
  name: "CloudEvents",
  kind: "MESSAGE",
  spec: {
    summary: "CloudEvents 1.0 context attributes",
    description:
      "The CNCF CloudEvents 1.0 envelope: every event carries these context attributes next to its data, so any consumer can route and trace it without knowing the payload. Built in: the properties are defined by the CloudEvents specification and cannot be changed.",
    headers: {
      type: "object",
      required: ["specversion", "id", "source", "type"],
      properties: {
        specversion: {
          type: "string",
          const: "1.0",
          description: 'The version of the CloudEvents specification the event uses. Always "1.0".',
        },
        id: {
          type: "string",
          minLength: 1,
          description: "Identifies the event. Producers must make source + id unique for every distinct event.",
        },
        source: {
          type: "string",
          format: "uri-reference",
          description: "Identifies the context in which the event happened, such as the system or service that produced it.",
        },
        type: {
          type: "string",
          description: "The kind of event, related to the originating occurrence (for example com.acme.order.created).",
        },
        subject: {
          type: "string",
          description: "Identifies what the event is about, in the context of the producer (for example the order id).",
        },
        time: {
          type: "string",
          format: "date-time",
          description: "When the occurrence happened (RFC 3339 timestamp).",
        },
        datacontenttype: {
          type: "string",
          description: "The media type of the event data (for example application/json).",
        },
        dataschema: {
          type: "string",
          format: "uri",
          description: "A link to the schema the event data adheres to.",
        },
      },
    },
    [BUNDLED_MARKER_KEY]: CLOUDEVENTS_ID,
  },
};

/** W3C Trace Context (Level 1): the two HTTP-header names, used as message headers so a trace can follow an event across services. */
const traceContext: BundledTrait = {
  id: TRACE_CONTEXT_ID,
  name: "TraceContext",
  kind: "MESSAGE",
  spec: {
    summary: "W3C Trace Context headers",
    description:
      "The W3C Trace Context headers: they carry the distributed trace across services, so an event can be followed from the producer to every consumer. Built in: the properties are defined by the W3C recommendation and cannot be changed.",
    headers: {
      type: "object",
      required: ["traceparent"],
      properties: {
        traceparent: {
          type: "string",
          pattern: "^[0-9a-f]{2}-[0-9a-f]{32}-[0-9a-f]{16}-[0-9a-f]{2}$",
          description: "Identifies the trace and the calling span: version-traceid-parentid-flags, all lowercase hex (for example 00-4bf92f3577b34da6a3ce929d0e0e4736-00f067aa0ba902b7-01).",
        },
        tracestate: {
          type: "string",
          description: "Vendor-specific trace information, a comma-separated list of key=value members.",
        },
      },
    },
    [BUNDLED_MARKER_KEY]: TRACE_CONTEXT_ID,
  },
};

/** Every built-in definition, deeply frozen. Clone `spec` before storing or editing it. */
export const BUNDLED_TRAITS: readonly BundledTrait[] = deepFreeze([cloudEvents, traceContext]);

/** The marker value of a trait's stored `spec` (`cloudevents@1.0`), or null when the spec does not carry a usable one. */
export function bundledMarker(spec: unknown): string | null {
  if (!isJsonObject(spec)) return null;
  const marker = spec[BUNDLED_MARKER_KEY];
  return typeof marker === "string" && marker.trim() !== "" ? marker : null;
}

/** True when the stored `spec` marks the trait as built in (any non-empty `x-bundled` string): such a trait is read-only. */
export function isBundledTrait(spec: unknown): boolean {
  return bundledMarker(spec) !== null;
}

function typeLabel(schema: unknown): string {
  if (!isJsonObject(schema)) return "any";
  const { type, format } = schema;
  let base = "any";
  if (typeof type === "string" && type !== "") base = type;
  else if (Array.isArray(type) && type.length > 0 && type.every((t) => typeof t === "string")) base = type.join(" | ");
  else if (schema.const !== undefined) base = schema.const === null ? "null" : typeof schema.const;
  else if (Array.isArray(schema.enum)) base = "enum";
  return typeof format === "string" && format !== "" ? `${base} (${format})` : base;
}

/**
 * The property names of the built-in definition `spec` claims to be, in the definition's order; [] for a custom trait or an unknown marker.
 * PostgreSQL `jsonb` does not keep object key order (it returns keys by length, then alphabetically), so a stored built-in's
 * `properties` come back shuffled; the definition is where its intended order lives.
 */
function builtInOrder(spec: Record<string, unknown>): string[] {
  const marker = bundledMarker(spec);
  const headers = BUNDLED_TRAITS.find((t) => t.id === marker)?.spec.headers;
  const properties = isJsonObject(headers) ? headers.properties : undefined;
  return isJsonObject(properties) ? Object.keys(properties) : [];
}

/**
 * The properties of a trait's INLINE headers schema (`spec.headers.properties`) as table rows. Order: the required properties first,
 * in the order of the schema's `required` list (arrays keep their order everywhere); then the optional ones — in the built-in
 * definition's order for a built-in trait, otherwise in the order the object lists them (which a database round trip may have changed:
 * `jsonb` re-sorts keys, so do not expect a custom trait's optional properties back in the order they were typed).
 * Works for built-in and custom traits alike; a spec without a headers schema (or with a malformed one) has no properties — never throws.
 * Properties defined by a pinned headers ENTITY are not in the spec and are not listed.
 */
export function propertySummary(spec: unknown): PropertySummaryRow[] {
  if (!isJsonObject(spec) || !isJsonObject(spec.headers)) return [];
  const { properties, required } = spec.headers;
  if (!isJsonObject(properties)) return [];
  const requiredList = Array.isArray(required) ? required.filter((r): r is string => typeof r === "string") : [];
  const requiredNames = new Set(requiredList);
  const hint = builtInOrder(spec);
  const rank = (name: string) => (hint.includes(name) ? hint.indexOf(name) : hint.length); // names the definition does not know sort after, stably
  const names = Object.keys(properties);
  const ordered = [
    ...new Set(requiredList.filter((name) => Object.hasOwn(properties, name))),
    ...names.filter((name) => !requiredNames.has(name)).sort((a, b) => rank(a) - rank(b)),
  ];
  return ordered.map((name): PropertySummaryRow => {
    const schema = properties[name];
    const description = isJsonObject(schema) && typeof schema.description === "string" && schema.description !== "" ? schema.description : undefined;
    return { name, type: typeLabel(schema), required: requiredNames.has(name), ...(description !== undefined && { description }) };
  });
}

/**
 * The first problem with a trait's inline headers schema, or null when it is fine. The shape is the one `propertySummary` and the
 * assembler rely on: an object schema (`type: "object"`), `properties` an object whose values are schemas (objects, or the
 * booleans JSON Schema allows), `required` a list of property names that are all declared in `properties`.
 */
export function inlineHeadersProblem(headers: unknown): string | null {
  if (!isJsonObject(headers)) return "Headers must be a JSON Schema object";
  if (headers.type !== "object") return 'Headers must be an object schema ("type": "object")';
  const { properties, required } = headers;
  if (properties !== undefined) {
    if (!isJsonObject(properties)) return 'Headers "properties" must be an object of schemas';
    for (const [name, schema] of Object.entries(properties)) {
      if (!isJsonObject(schema) && typeof schema !== "boolean") return `Headers property "${name}" must be a schema (an object)`;
    }
  }
  if (required !== undefined) {
    if (!Array.isArray(required) || !required.every((r) => typeof r === "string")) return 'Headers "required" must be a list of property names';
    const declared = isJsonObject(properties) ? properties : {};
    const missing = required.find((r) => !Object.hasOwn(declared, r));
    if (missing !== undefined) return `Headers "required" lists "${missing}", which is not one of the headers properties`;
  }
  return null;
}
