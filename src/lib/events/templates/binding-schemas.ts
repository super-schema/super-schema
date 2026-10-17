// src/lib/events/templates/binding-schemas.ts
// The JSON Schema of a raw-JSON binding field (a Kafka group id, an SQS policy principal, the headers of a WebSocket channel ...),
// found from the JSON pointer of the control that edits it, so the editor can warn about a value that does not fit. The schemas are
// generated from the binding files of `@asyncapi/specs` (scripts/generate-asyncapi-templates.ts); nothing here depends on the
// package at runtime. Pure — client-safe.
import { BINDING_JSON_SCHEMAS } from "./binding-json-schemas.generated";
import type { BindingTarget } from "./types";

/** The collections of an event document that carry `bindings`, and the binding target of each. */
const TARGET_OF_COLLECTION: Record<string, BindingTarget> = { servers: "server", channels: "channel", operations: "operation", messages: "message" };

const INDEX = /^\d+$/;

/**
 * The inlined draft-07 schema of one raw-JSON binding field, from the pointer of its control, or `null` when the pointer is not such
 * a field: no validation. The pointer is `/<servers|channels|operations|messages>/<n>/bindings/<protocol>/<field path>`, the way a
 * control builds it (`/channels/0/bindings/ws/query`, `/operations/2/bindings/kafka/groupId`, `/servers/0/bindings/jms/properties/3/value`).
 * The collection says which binding it is (a channel's `ws` binding, an operation's `kafka` binding), and every number below
 * `bindings/<protocol>` is the index of a list item, which the schemas do not distinguish.
 * A protocol or field the catalog does not know (including the JSON fallback of an unknown protocol) has no schema.
 */
export function bindingFieldSchema(pointer: string): Record<string, unknown> | null {
  const [root, collection, index, bindings, protocol, ...field] = pointer.split("/");
  if (root !== "" || !Object.hasOwn(TARGET_OF_COLLECTION, collection) || !INDEX.test(index) || bindings !== "bindings" || !protocol || field.length === 0) return null;
  const key = [protocol, TARGET_OF_COLLECTION[collection], ...field.map((segment) => (INDEX.test(segment) ? "[]" : segment))].join(".");
  return Object.hasOwn(BINDING_JSON_SCHEMAS, key) ? BINDING_JSON_SCHEMAS[key] : null;
}
