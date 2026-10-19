/**
 * Small valid AsyncAPI 3.0 documents with ONE given name used as a key, in each place a user-controlled key can sit. Shared by the
 * guard tests and the sweep over `Object.prototype` names (so both look at the same positions).
 */
import type { Parser } from "@asyncapi/parser";
import { escapePointerSegment } from "@/lib/event-specs/json-pointer";
import { setOwn } from "@/lib/event-specs/own-property";
import type { JsonObject } from "@/lib/event-specs/types";

/** A valid document with nothing in it that depends on the probed name. */
export function baseDocument(): JsonObject {
  return {
    asyncapi: "3.0.0",
    info: { title: "Probe", version: "1.0.0" },
    servers: { prod: { host: "kafka.internal:9092", protocol: "kafka", variables: { port: { default: "9092" } } } },
    channels: { orders: { address: "orders.v1", messages: { created: { $ref: "#/components/messages/created" } } } },
    operations: {
      sendCreated: { action: "send", channel: { $ref: "#/channels/orders" }, messages: [{ $ref: "#/channels/orders/messages/created" }] },
    },
    components: {
      messages: { created: { payload: { type: "object", properties: { id: { type: "string" } } } } },
      schemas: {},
    },
  };
}

const at = (doc: JsonObject, ...path: string[]): JsonObject => {
  let node: unknown = doc;
  for (const segment of path) node = Array.isArray(node) ? node[Number(segment)] : (node as Record<string, unknown>)[segment];
  return node as JsonObject;
};

export interface KeyPosition {
  label: string;
  /** The document with `key` added in this position (as an OWN property, so `__proto__` survives). */
  build(key: string): JsonObject;
  /** The RFC 6901 pointer of `key` in it. */
  pointer(key: string): string;
}

const pointerTo = (...segments: string[]) => (key: string) => "/" + [...segments, key].map(escapePointerSegment).join("/");

/** `parent` is the path to the object that receives the key; `value` is what the key holds. */
function position(label: string, parent: string[], value: unknown = { type: "string" }, extra?: (doc: JsonObject) => void): KeyPosition {
  return {
    label,
    build(key) {
      const doc = baseDocument();
      extra?.(doc);
      setOwn(at(doc, ...parent), key, value);
      return doc;
    },
    pointer: pointerTo(...parent),
  };
}

export const KEY_POSITIONS: KeyPosition[] = [
  position("channel key", ["channels"], { address: "extra.v1" }),
  position("components.schemas name", ["components", "schemas"]),
  position("JSON Schema property of a message payload", ["components", "messages", "created", "payload", "properties"]),
  position("JSON Schema property of message headers", ["components", "messages", "created", "headers", "properties"], { type: "string" }, (doc) => {
    at(doc, "components", "messages", "created").headers = { type: "object", properties: {} };
  }),
  position("server key", ["servers"], { host: "other.internal:9092", protocol: "kafka" }),
  position("x- extension map key", ["x-ext"], 1, (doc) => {
    doc["x-ext"] = {};
  }),
  position("server variable name", ["servers", "prod", "variables"], { default: "1" }),
  position("binding object key", ["operations", "sendCreated", "bindings", "kafka"], "x", (doc) => {
    at(doc, "operations", "sendCreated").bindings = { kafka: {} };
  }),
  position("key of an object inside an array (a tag)", ["info", "tags", "0"], 1, (doc) => {
    at(doc, "info").tags = [{ name: "t" }];
  }),
];

/** A document as the parser's `validate` takes it (its `Input` type names the parser's own document model; a plain object is accepted). */
export const parserInput = (doc: object): Parameters<Parser["validate"]>[0] =>
  doc as unknown as Parameters<Parser["validate"]>[0];
