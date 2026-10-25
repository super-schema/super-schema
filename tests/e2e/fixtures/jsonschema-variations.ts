/**
 * The table of JSON Schema variations the lifecycle spec (jsonschema-lifecycle.spec.ts) runs through the real UI.
 *
 * `kind: "single"` schemas import as ONE entity (name prompt + Create entity). `kind: "multi"` ones have in-document `$ref`s to
 * `$defs`, so the importer yields several models (review screen: `Import N Asset(s)`) and every model is registered as an entity.
 *
 * `known` documents an accepted open defect per target: the spec then REQUIRES the failure (matching `match`) and fails once it is
 * fixed ("stale expectation"), so an entry can never hide a regression nor outlive its bug.
 */

import type { TargetKey } from "../helpers/lifecycle";

export interface KnownFailure {
  /** The error text the Schemas tab must show. */
  match: RegExp;
  why: string;
}

export interface Variation {
  id: string;
  title: string;
  kind: "single" | "multi";
  /** The entity the lifecycle opens (the root model). */
  entityName: string;
  /** The text pasted into the workbench (JSON, or YAML for the YAML case). */
  text: string;
  /** Substrings the single-entity review screen must show (expanded import details included); for `multi`, the model names. */
  review: string[];
  /** The review must flag unresolved references (dangling marker count), when set. */
  dangling?: number;
  /** Property names that must be `required` in the generated JSON Schema. */
  required?: string[];
  /** Substrings that must appear in the generated JSON Schema (extensions, enum values, formats, bounds), matched against its compact JSON form. */
  jsonSchema: string[];
  /** Substrings that must appear in the generated OpenAPI 3. */
  openapi: string[];
  /** Field renamed in the editor after the first round: [from, to]. */
  rename: [string, string];
  /** Extension / classification text that must still be in the JSON Schema after the TypeSpec edit + sync. */
  survives: string[];
  /** The key the BigQuery/Spanner/PostgreSQL dialog is answered with (the first offered field when absent). */
  primaryKey?: string[];
  known?: Partial<Record<TargetKey, KnownFailure>>;
}

const DRAFT = "https://json-schema.org/draft/2020-12/schema";

/**
 * The Protobuf emitter has no spelling for an array of arrays (`repeated repeated` does not exist). The documented sibling limitation
 * `protobuf-nested-array` (tests/fixtures/corpus/known-issues.ts): the Schemas tab shows exactly the emitter's diagnostic. The other
 * targets write the array of arrays.
 */
const PROTOBUF_NESTED_ARRAY: KnownFailure = {
  match: /@typespec\/protobuf\/nested-array[\s\S]*nested arrays are not supported/,
  why: "protobuf-nested-array: Protobuf cannot express an array of arrays",
};

const j = (o: unknown) => JSON.stringify(o);

export const VARIATIONS: Variation[] = [
  {
    id: "paypal-address-ref-allof",
    title: "PayPal-style address: in-document $ref and allOf",
    kind: "multi",
    entityName: "Account",
    text: j({
      $schema: DRAFT,
      title: "Account",
      type: "object",
      "x-owner": "payments",
      properties: {
        account_id: { type: "string", minLength: 1, maxLength: 36 },
        address: { $ref: "#/$defs/Address" },
        billing: { allOf: [{ $ref: "#/$defs/Address" }], description: "billing address" },
        status: { type: "string", enum: ["open", "closed"] },
      },
      required: ["account_id", "address"],
      $defs: {
        Address: {
          type: "object",
          properties: {
            address_line_1: { type: "string", maxLength: 300 },
            country_code: { type: "string", minLength: 2, maxLength: 2, pattern: "^([A-Z][A-Z])|C2$" },
            postal_code: { type: "string", maxLength: 60 },
          },
          required: ["address_line_1", "country_code"],
        },
      },
    }),
    review: ["Account", "Address"],
    jsonSchema: ["x-owner", "account_id"],
    openapi: ["x-owner", "account_id"],
    rename: ["status", "account_status"],
    survives: ["x-owner"],
    primaryKey: ["account_id"],
  },
  {
    id: "oneof-union",
    title: "oneOf unions of scalars and of models",
    kind: "multi",
    entityName: "Payment",
    text: j({
      $schema: DRAFT,
      title: "Payment",
      type: "object",
      properties: {
        payment_id: { type: "string" },
        reference: { oneOf: [{ type: "string" }, { type: "integer" }] },
        instrument: { oneOf: [{ $ref: "#/$defs/Card" }, { $ref: "#/$defs/Bank" }] },
      },
      required: ["payment_id"],
      $defs: {
        Card: { type: "object", properties: { pan_last4: { type: "string", maxLength: 4 } }, required: ["pan_last4"] },
        Bank: { type: "object", properties: { iban: { type: "string" } }, required: ["iban"] },
      },
    }),
    review: ["Payment", "Card", "Bank"],
    jsonSchema: ["payment_id"],
    openapi: ["payment_id"],
    rename: ["payment_id", "id"],
    survives: ["payment_id"],
    primaryKey: ["payment_id"],
  },
  {
    id: "nullable-type-arrays",
    title: "nullable type arrays (type: [T, null])",
    kind: "single",
    entityName: "Profile",
    text: j({
      $schema: DRAFT,
      title: "Profile",
      type: "object",
      properties: {
        id: { type: "string" },
        nickname: { type: ["string", "null"], maxLength: 40 },
        age: { type: ["integer", "null"], minimum: 0, maximum: 150 },
        score: { type: ["number", "null"] },
        active: { type: ["boolean", "null"] },
      },
      required: ["id"],
    }),
    review: ["nickname", "age", "score", "active"],
    required: ["id"],
    jsonSchema: ["nickname", '"maxLength":40'],
    openapi: ["nickname"],
    rename: ["nickname", "display_name"],
    survives: ["maxLength"],
    primaryKey: ["id"],
  },
  {
    id: "enums",
    title: "string and integer enums, const",
    kind: "single",
    entityName: "Ticket",
    text: j({
      $schema: DRAFT,
      title: "Ticket",
      type: "object",
      properties: {
        ticket_id: { type: "string" },
        state: { type: "string", enum: ["new", "in_progress", "done"] },
        priority: { type: "integer", enum: [1, 2, 3] },
        kind: { type: "string", const: "support" },
      },
      required: ["ticket_id", "state"],
    }),
    review: ["state", "priority", "kind"],
    required: ["ticket_id", "state"],
    jsonSchema: ["in_progress", "done"],
    openapi: ["in_progress"],
    rename: ["state", "status"],
    survives: ["in_progress"],
    primaryKey: ["ticket_id"],
  },
  {
    id: "string-formats",
    title: "formats: date-time, date, uuid, bytes, email, uri, time",
    kind: "single",
    entityName: "Event",
    text: j({
      $schema: DRAFT,
      title: "Event",
      type: "object",
      properties: {
        event_id: { type: "string", format: "uuid" },
        occurred_at: { type: "string", format: "date-time" },
        birthday: { type: "string", format: "date" },
        at_time: { type: "string", format: "time" },
        payload: { type: "string", format: "byte" },
        contact: { type: "string", format: "email" },
        homepage: { type: "string", format: "uri" },
      },
      required: ["event_id", "occurred_at"],
    }),
    review: ["event_id", "occurred_at", "birthday", "payload"],
    required: ["event_id", "occurred_at"],
    jsonSchema: ["date-time", "uuid"],
    openapi: ["date-time", "uuid"],
    rename: ["birthday", "born_on"],
    survives: ["date-time"],
    primaryKey: ["event_id"],
  },
  {
    id: "numeric-bounds",
    title: "numeric bounds: min/max, exclusive, multipleOf, int64",
    kind: "single",
    entityName: "Measurement",
    text: j({
      $schema: DRAFT,
      title: "Measurement",
      type: "object",
      properties: {
        sample_id: { type: "integer", format: "int64" },
        count: { type: "integer", minimum: 0, maximum: 1000 },
        ratio: { type: "number", exclusiveMinimum: 0, exclusiveMaximum: 1 },
        step: { type: "number", multipleOf: 0.5 },
        tags: { type: "array", items: { type: "string" }, minItems: 1, maxItems: 5, uniqueItems: true },
      },
      required: ["sample_id", "count"],
    }),
    review: ["count", "ratio", "step", "tags"],
    required: ["sample_id", "count"],
    jsonSchema: ["1000", "maxItems"],
    openapi: ["1000"],
    rename: ["count", "total"],
    survives: ["1000"],
    primaryKey: ["sample_id"],
  },
  {
    id: "array-of-refs",
    title: "arrays of $ref models and of arrays",
    kind: "multi",
    entityName: "Order",
    text: j({
      $schema: DRAFT,
      title: "Order",
      type: "object",
      properties: {
        order_id: { type: "string" },
        lines: { type: "array", items: { $ref: "#/$defs/Line" }, minItems: 1 },
        matrix: { type: "array", items: { type: "array", items: { type: "integer" } } },
      },
      required: ["order_id", "lines"],
      $defs: {
        Line: { type: "object", properties: { sku: { type: "string" }, qty: { type: "integer", minimum: 1 } }, required: ["sku"] },
      },
    }),
    review: ["Order", "Line"],
    jsonSchema: ["order_id"],
    openapi: ["order_id"],
    rename: ["order_id", "id"],
    survives: ["order_id"],
    primaryKey: ["order_id"],
    // `matrix` is an array of arrays: every target writes it but Protobuf. Everything else, `lines` (an array of references) included, generates.
    known: { protobuf: PROTOBUF_NESTED_ARRAY },
  },
  {
    id: "additional-properties",
    title: "additionalProperties (typed map, closed object)",
    kind: "single",
    entityName: "Settings",
    text: j({
      $schema: DRAFT,
      title: "Settings",
      type: "object",
      properties: {
        owner: { type: "string" },
        labels: { type: "object", additionalProperties: { type: "string" } },
        limits: { type: "object", additionalProperties: { type: "integer" } },
      },
      required: ["owner"],
      additionalProperties: false,
    }),
    review: ["owner", "labels", "limits"],
    required: ["owner"],
    jsonSchema: ["labels"],
    openapi: ["labels"],
    rename: ["labels", "tags"],
    survives: ["tags"],
    primaryKey: ["owner"],
  },
  {
    id: "extensions-entity-and-field",
    title: "x-* extensions at entity and field level (scalar, object, array)",
    kind: "single",
    entityName: "Device",
    text: j({
      $schema: DRAFT,
      title: "Device",
      type: "object",
      "x-team": "iot-platform",
      "x-lifecycle": { stage: "beta", since: 2024 },
      properties: {
        device_id: { type: "string", "x-pii": false, "x-source": "registry" },
        model: { type: "string", "x-labels": ["hardware", "catalog"] },
        firmware: { type: "string", "x-meta": { owner: "fw-team", review: true } },
      },
      required: ["device_id"],
    }),
    review: ["device_id", "x-source", "x-labels", "x-meta"],
    required: ["device_id"],
    jsonSchema: ["x-team", "iot-platform", "x-lifecycle", "x-source", "x-labels", "x-meta", "fw-team"],
    openapi: ["x-team", "iot-platform", "x-source", "x-labels"],
    rename: ["model", "hw_model"],
    survives: ["x-team", "iot-platform", "x-source", "x-labels", "fw-team"],
    primaryKey: ["device_id"],
  },
  {
    id: "classification",
    title: "x-securityClassification on fields (class levels + categories)",
    kind: "single",
    entityName: "Customer",
    text: j({
      $schema: DRAFT,
      title: "Customer",
      type: "object",
      properties: {
        customer_id: {
          type: "string",
          "x-securityClassification": { data_class: "class3", data_category: "Intrinsic" },
        },
        email: {
          type: "string",
          format: "email",
          "x-securityClassification": { data_class: "class4", data_category: "PayPalCompany" },
        },
        nickname: { type: "string" },
      },
      required: ["customer_id"],
    }),
    review: ["customer_id", "class3", "class4", "PayPalCompany"],
    required: ["customer_id"],
    jsonSchema: ["x-securityClassification", "PayPalCompany", "class4"],
    openapi: ["x-securityClassification", "class4"],
    rename: ["nickname", "alias"],
    survives: ["x-securityClassification", "PayPalCompany", "class4"],
    primaryKey: ["customer_id"],
  },
  {
    id: "deep-nesting",
    title: "five levels of nested objects",
    kind: "single",
    entityName: "Tree",
    text: j({
      $schema: DRAFT,
      title: "Tree",
      type: "object",
      properties: {
        tree_id: { type: "string" },
        l1: {
          type: "object",
          properties: {
            l2: {
              type: "object",
              properties: {
                l3: {
                  type: "object",
                  properties: { l4: { type: "object", properties: { leaf: { type: "string", maxLength: 7 } } } },
                },
              },
            },
          },
        },
      },
      required: ["tree_id"],
    }),
    review: ["tree_id", "l1"],
    required: ["tree_id"],
    jsonSchema: ["l1"],
    openapi: ["l1"],
    rename: ["tree_id", "id"],
    survives: ["l1"],
    primaryKey: ["tree_id"],
  },
  {
    id: "reserved-words",
    title: "reserved-word and awkward property names",
    kind: "single",
    entityName: "Reserved",
    text: j({
      $schema: DRAFT,
      title: "Reserved",
      type: "object",
      properties: {
        class: { type: "string" },
        public: { type: "string" },
        int: { type: "integer" },
        select: { type: "string" },
        order: { type: "integer" },
        from: { type: "string" },
        default: { type: "string" },
        "with-dash": { type: "string" },
        "1st": { type: "string" },
      },
      required: ["class", "select"],
    }),
    review: ["class", "public", "select", "with-dash"],
    jsonSchema: ["class", "select"],
    openapi: ["class"],
    rename: ["public", "visibility"],
    survives: ["class"],
    primaryKey: ["class"],
  },
  {
    id: "long-names",
    title: "long property and description text",
    kind: "single",
    entityName: "LongNames",
    text: j({
      $schema: DRAFT,
      title: "LongNames",
      type: "object",
      description: "An entity whose fields have very long names and descriptions. ".repeat(6).trim(),
      properties: {
        id: { type: "string" },
        [`field_${"x".repeat(90)}`]: { type: "string", description: "d".repeat(400) },
        [`another_${"y".repeat(60)}_property`]: { type: "integer" },
      },
      required: ["id"],
    }),
    review: ["id", `field_${"x".repeat(20)}`],
    required: ["id"],
    jsonSchema: [`field_${"x".repeat(30)}`],
    openapi: [`field_${"x".repeat(30)}`],
    rename: ["id", "identifier"],
    survives: [`field_${"x".repeat(30)}`],
    primaryKey: ["id"],
  },
  {
    id: "yaml-input",
    title: "YAML input with extensions, constraints and an enum",
    kind: "single",
    entityName: "Invoice",
    text: [
      `$schema: ${DRAFT}`,
      "title: Invoice",
      "type: object",
      "x-domain: billing",
      "properties:",
      "  invoice_id:",
      "    type: string",
      "    minLength: 3",
      "    maxLength: 20",
      "    x-source: erp",
      "  currency:",
      "    type: string",
      "    enum: [USD, EUR, GBP]",
      "  total:",
      "    type: number",
      "    minimum: 0",
      "required:",
      "  - invoice_id",
      "  - total",
      "",
    ].join("\n"),
    review: ["invoice_id", "currency", "total"],
    required: ["invoice_id", "total"],
    jsonSchema: ["x-domain", "billing", "x-source", "EUR"],
    openapi: ["x-domain", "billing", "EUR"],
    rename: ["currency", "ccy"],
    survives: ["x-domain", "billing", "x-source"],
    primaryKey: ["invoice_id"],
  },
  {
    id: "defaults-descriptions",
    title: "defaults, deprecated, readOnly, quotes and unicode in descriptions",
    kind: "single",
    entityName: "Widget",
    text: j({
      $schema: DRAFT,
      title: "Widget",
      type: "object",
      description: 'A "quoted" widget — café ☃',
      properties: {
        widget_id: { type: "string", readOnly: true },
        color: { type: "string", default: "red", description: "Say \"hello\"\nnew line" },
        retries: { type: "integer", default: 3 },
        legacy: { type: "string", deprecated: true },
      },
      required: ["widget_id"],
    }),
    review: ["widget_id", "color", "retries", "legacy"],
    required: ["widget_id"],
    jsonSchema: ["red", "widget_id"],
    openapi: ["red"],
    rename: ["color", "colour"],
    survives: ["widget_id"],
    primaryKey: ["widget_id"],
  },
];
