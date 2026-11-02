/**
 * Event snapshots for the event services' unit tests (no database). `paymentsDocument` has four renders in one resolve: OrderCreated's payload and
 * its key (a Kafka key on an Avro channel), OrderShipped's payload, and the headers pin of the CloudEvents trait.
 */
import type { EventSnapshot } from "@/services/events/event-snapshot";
import { emptyEventDocument, type EventDocument } from "@/lib/events/document/types";

export const PAYMENTS_RENDERS = 4;

export function paymentsDocument(): EventDocument {
  return {
    ...emptyEventDocument("checkout-service"),
    servers: [{ key: "kafka-prod", protocol: "kafka", host: "kafka-prod.internal:9092" }],
    channels: [{ key: "orders", address: "payments.orders.v1", protocol: "kafka", serverKeys: ["kafka-prod"], format: "avro", messageKeys: ["OrderCreated", "OrderShipped"] }],
    messages: [
      { key: "OrderCreated", contentType: "avro/binary", payload: { entityId: "e1", entityVersionId: "v1" }, keyPin: { entityId: "e2", entityVersionId: "v2" }, traitKeys: ["CloudEvents"] },
      { key: "OrderShipped", contentType: "avro/binary", payload: { entityId: "e1", entityVersionId: "v1" }, traitKeys: [] },
    ],
    traits: [{ key: "CloudEvents", kind: "MESSAGE", spec: {}, headers: { entityId: "e3", entityVersionId: "v3" } }],
    operations: [{ key: "publishOrderCreated", action: "send", channelKey: "orders", messageKeys: ["OrderCreated", "OrderShipped"], traitKeys: [] }],
  };
}

/** A snapshot of `document` with nothing published and no library traits or external references. */
export function snapshotOf(document: EventDocument): EventSnapshot {
  return {
    event: { id: "ev1", name: "Checkout", tenantId: "t1", domainId: "d1", productId: "p1", productSlug: "checkout", specType: "asyncapi" },
    document,
    latest: null,
    libraryTraits: new Map(),
    external: new Map(),
    externalMajors: {},
    entityFormats: new Map(),
  };
}
