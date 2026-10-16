// tests/unit/lib/events/document/fixtures/slice1-documents.ts
// Event documents exactly as slice 1 could author them (no field added by WP-1a): the minimal document of the parser tests,
// the three demo events of `npm run db:seed-events-demo`, and a kitchen-sink document that uses every slice-1 field.
// `compat-pipeline.ts` runs them through parse → resolve → assemble; the emitted JSON/YAML are pinned as goldens that were
// generated from the code BEFORE WP-1a changed it.
import type { FrozenTrait } from "@/lib/events/types";
import { emptyEventDocument, type EventDocument } from "@/lib/events/document/types";

const pin = (id: string, v: string | null = "ev1") => ({ entityId: id, entityVersionId: v });

/** The `valid()` document of parse.test.ts: one Kafka server/channel, one message with a key pin, one library trait. */
export function slice1Minimal(): EventDocument {
  return {
    ...emptyEventDocument("checkout-service"),
    servers: [{ key: "kafka-prod", protocol: "kafka", host: "kafka-prod.internal:9092" }],
    channels: [{ key: "orders", address: "payments.orders.v1", protocol: "kafka", serverKeys: ["kafka-prod"], format: "avro", messageKeys: ["OrderCreated"] }],
    messages: [{ key: "OrderCreated", payload: pin("ent-order"), keyPin: pin("ent-key"), traitKeys: ["CloudEvents"] }],
    traits: [{ key: "CloudEvents", kind: "MESSAGE", libraryTraitId: "trait-1" }],
    operations: [{ key: "publishOrderCreated", action: "send", channelKey: "orders", messageKeys: ["OrderCreated"], traitKeys: [] }],
  };
}

/** Event 1 of the demo seed (scripts/seed-events-demo.ts), with fixed entity ids. */
export function demoCheckoutService(): EventDocument {
  return {
    documentVersion: 2,
    info: { title: "checkout-service", description: "Events published by the Checkout service." },
    externalRefs: [],
    defaultContentType: "application/json",
    servers: [
      { key: "kafka-prod", protocol: "kafka", host: "kafka-prod.internal:9092", description: "Production Kafka cluster" },
      { key: "pubsub-prod", protocol: "googlepubsub", host: "pubsub.googleapis.com", description: "Google Pub/Sub" },
    ],
    channels: [
      { key: "orders", address: "payments.orders.v1", protocol: "kafka", serverKeys: ["kafka-prod"], bindings: { kafka: { partitions: 12, replicas: 3 } },
        format: "avro", title: "Orders topic", description: "Every order lifecycle event, keyed by order id.", messageKeys: ["OrderCreated", "OrderCancelled"] },
      { key: "customer-orders", address: "payments.customers.{customerId}.orders.v1", protocol: "kafka", serverKeys: ["kafka-prod"],
        parameters: { customerId: { description: "Customer the orders belong to" } }, format: "avro", title: "Per-customer orders", messageKeys: ["OrderCreated"] },
      { key: "order-notifications", address: "order-notifications", protocol: "googlepubsub", serverKeys: ["pubsub-prod"],
        bindings: { googlepubsub: { messageRetentionDuration: "86400s", schemaSettings: { encoding: "json", name: "projects/acme-prod/schemas/order-notification" } } },
        format: "json-schema", formatDialect: "draft-07", title: "Customer notifications", messageKeys: ["OrderNotification"] },
    ],
    messages: [
      { key: "OrderCreated", title: "Order created", summary: "A customer placed an order.", contentType: "avro/binary",
        payload: pin("ent-order", "ev-order"), keyPin: pin("ent-order-key", "ev-order-key"), traitKeys: ["CloudEvents"] },
      { key: "OrderCancelled", title: "Order cancelled", summary: "An order was cancelled before shipping.", contentType: "avro/binary",
        payload: pin("ent-order", "ev-order"), keyPin: pin("ent-order-key", "ev-order-key"), traitKeys: ["CloudEvents"] },
      { key: "OrderNotification", title: "Order notification", summary: "A notification to send to the customer.", contentType: "application/json",
        payload: pin("ent-notification", "ev-notification"), traitKeys: [] },
    ],
    traits: [
      { key: "CloudEvents", kind: "MESSAGE", libraryTraitId: "lib-cloudevents" },
      { key: "Audited", kind: "OPERATION", libraryTraitId: "lib-audited" },
    ],
    operations: [
      { key: "publishOrderCreated", action: "send", channelKey: "orders", messageKeys: ["OrderCreated"], traitKeys: ["Audited"], summary: "Publish when an order is placed" },
      { key: "publishOrderCancelled", action: "send", channelKey: "orders", messageKeys: ["OrderCancelled"], traitKeys: [], summary: "Publish when an order is cancelled" },
      { key: "publishCustomerOrder", action: "send", channelKey: "customer-orders", messageKeys: ["OrderCreated"], traitKeys: [] },
      { key: "publishOrderNotification", action: "send", channelKey: "order-notifications", messageKeys: ["OrderNotification"], traitKeys: [] },
    ],
  };
}

/** Event 2 of the demo seed: consumes Checkout's orders, publishes scores. */
export function demoFraudScorer(): EventDocument {
  return {
    documentVersion: 2,
    info: { title: "fraud-scorer", description: "Scores every order for fraud risk." },
    externalRefs: [],
    servers: [
      { key: "kafka-prod", protocol: "kafka", host: "kafka-prod.internal:9092" },
      { key: "pubsub-prod", protocol: "googlepubsub", host: "pubsub.googleapis.com" },
    ],
    channels: [
      { key: "orders", address: "payments.orders.v1", protocol: "kafka", serverKeys: ["kafka-prod"], format: "avro", title: "Orders (from Checkout)", messageKeys: ["OrderCreated"] },
      { key: "fraud-scores", address: "fraud-scores", protocol: "googlepubsub", serverKeys: ["pubsub-prod"], format: "json-schema", formatDialect: "draft-07", messageKeys: ["FraudScored"] },
    ],
    messages: [
      { key: "OrderCreated", title: "Order created", contentType: "avro/binary", payload: pin("ent-order", "ev-order"), keyPin: pin("ent-order-key", "ev-order-key"), traitKeys: ["CloudEvents"] },
      { key: "FraudScored", title: "Fraud scored", contentType: "application/json", payload: pin("ent-fraud", "ev-fraud"), traitKeys: [] },
    ],
    traits: [{ key: "CloudEvents", kind: "MESSAGE", libraryTraitId: "lib-cloudevents" }],
    operations: [
      { key: "receiveOrderCreated", action: "receive", channelKey: "orders", messageKeys: ["OrderCreated"], traitKeys: [], summary: "Consume new orders" },
      { key: "publishFraudScored", action: "send", channelKey: "fraud-scores", messageKeys: ["FraudScored"], traitKeys: [], summary: "Publish the score" },
    ],
  };
}

/** Event 3 of the demo seed: a deliberately incomplete draft (unpinned payload, no operations). */
export function demoReturnsService(): EventDocument {
  return {
    documentVersion: 2,
    info: { title: "returns-service", description: "Work in progress: shows that incomplete drafts save, and what the builder flags." },
    externalRefs: [],
    servers: [],
    channels: [{ key: "returns", address: "payments.returns.{region}.v1", protocol: "kafka", serverKeys: [], format: "avro",
      parameters: { region: { description: "Warehouse region" } }, messageKeys: ["ReturnRequested"] }],
    messages: [{ key: "ReturnRequested", title: "Return requested", payload: { entityId: "ent-draft-only", entityVersionId: null }, traitKeys: [] }],
    traits: [], operations: [],
  };
}

/**
 * Every field slice 1 could carry, including the loosely typed ones (`contact`, `license`, `tags`, `externalDocs`,
 * `correlationId`, `examples`, `bindings`, a local trait per kind, a reply, a message emitted in two formats).
 */
export function slice1KitchenSink(): EventDocument {
  return {
    documentVersion: 2,
    info: {
      title: "kitchen-sink", description: "Uses every slice-1 field.",
      contact: { name: "Platform team", url: "https://example.com/support", email: "platform@example.com" },
      license: { name: "Apache 2.0", url: "https://www.apache.org/licenses/LICENSE-2.0.html" },
      tags: [{ name: "payments", description: "Payments domain" }, { name: "core" }],
      externalDocs: { url: "https://docs.example.com/events" },
    },
    defaultContentType: "application/json",
    servers: [
      { key: "kafka-prod", protocol: "kafka", host: "kafka-prod.internal:9092", protocolVersion: "3.7", pathname: "/prod", description: "Prod", externalRef: "https://wiki.example.com/kafka" },
      { key: "kafka-stage", protocol: "kafka", host: "kafka-stage.internal:9092", origin: { provider: "infra", ref: "k-2", syncedAt: "2026-10-15T00:00:00Z" } },
    ],
    channels: [
      { key: "orders", address: "orders.{region}.v1", protocol: "kafka", serverKeys: ["kafka-prod", "kafka-stage"], format: "avro",
        title: "Orders", summary: "Order events", description: "All order events.", parameters: { region: { description: "Region", enum: ["eu", "us"], default: "eu" } },
        tags: [{ name: "orders", description: "Orders" }], externalDocs: { url: "https://docs.example.com/orders" },
        bindings: { kafka: { partitions: 3 } }, messageKeys: ["OrderCreated", "OrderSummary"] },
      { key: "replies", address: "orders.replies.v1", protocol: "kafka", serverKeys: ["kafka-prod"], format: "json-schema", formatDialect: "draft-07", messageKeys: ["OrderSummary"] },
    ],
    messages: [
      { key: "OrderCreated", title: "Order created", summary: "s", description: "d", contentType: "avro/binary",
        correlationId: { location: "$message.header#/correlationId", description: "Correlates a reply" },
        tags: [{ name: "created" }], externalDocs: { url: "https://docs.example.com/created" }, bindings: { kafka: { schemaIdLocation: "payload" } },
        examples: [{ name: "small", summary: "A small order", headers: { traceparent: "00-abc" }, payload: { id: "o-1" } }],
        payload: pin("ent-order", "ev-order"), keyPin: pin("ent-order-key", "ev-order-key"), traitKeys: ["Envelope"] },
      { key: "OrderSummary", title: "Order summary", payload: pin("ent-summary", "ev-summary"), traitKeys: [] },
    ],
    traits: [
      { key: "Envelope", kind: "MESSAGE", spec: { summary: "Envelope", tags: [{ name: "envelope" }] } },
      { key: "Audited", kind: "OPERATION", spec: { summary: "Audited", description: "Operation is audited", tags: [{ name: "audited" }], bindings: { kafka: { groupId: "audit" } } } },
    ],
    operations: [
      { key: "createOrder", action: "send", channelKey: "orders", messageKeys: ["OrderCreated"], traitKeys: ["Audited"], summary: "Create", description: "Creates an order",
        bindings: { kafka: { clientId: "checkout" } }, reply: { channelKey: "replies", messageKeys: ["OrderSummary"] } },
      { key: "receiveOrderCreated", action: "receive", channelKey: "orders", messageKeys: ["OrderCreated", "OrderSummary"], traitKeys: [] },
    ],
    externalRefs: [],
    components: {
      correlationIds: { requestId: { location: "$message.header#/requestId" } },
      parameters: { region: { description: "Region" } },
      securitySchemes: { basic: { type: "userPassword", description: "Username and password" } },
    },
  };
}

/** The library traits the demo documents refer to (what `event-snapshot` loads for `libraryTraitId`s). */
export function libraryTraits(): Map<string, FrozenTrait> {
  return new Map<string, FrozenTrait>([
    ["trait-1", { id: "trait-1", name: "CloudEvents", kind: "MESSAGE", ownerSlug: "acme", spec: { summary: "CloudEvents envelope headers" }, headersEntityId: "ent-ce-headers", headersEntityVersionId: "ev-ce-headers" }],
    ["lib-cloudevents", { id: "lib-cloudevents", name: "CloudEvents", kind: "MESSAGE", ownerSlug: "acme", spec: { summary: "CloudEvents envelope headers" }, headersEntityId: "ent-ce-headers", headersEntityVersionId: "ev-ce-headers" }],
    ["lib-audited", { id: "lib-audited", name: "Audited", kind: "OPERATION", ownerSlug: "acme", spec: { summary: "Operation is audited", tags: [{ name: "audited" }] }, headersEntityId: null, headersEntityVersionId: null }],
  ]);
}
