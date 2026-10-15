/**
 * Spec §6.2 worked example as in-memory fixtures: Checkout publishes
 * `OrderCreated@1.3` on Kafka topic `payments.orders.v1`; Fraud consumes it.
 * Pre-rendered artifacts stand in for EntityVersionArtifact outputs.
 */
import type {
  EventSpecDocument,
  EventSpecServer,
  ResolvedChannel,
  ResolvedEventSpec,
  ResolvedMessage,
  ResolvedTrait,
} from "@/lib/event-specs/types";
import type { EventSpecCatalog } from "@/lib/event-specs/resolve";

export const ordersChannel: ResolvedChannel = {
  id: "ch-checkout-orders",
  name: "orders",
  productSlug: "checkout",
  address: "payments.orders.v1",
  protocol: "kafka",
  profile: { format: "avro" },
  bindings: { kafka: { partitions: 12 } },
};

/** Tenant-level `CloudEvents` trait; headers → `CloudEventsHeaders@1.0` (JSON Schema). */
export const cloudEventsTrait: ResolvedTrait = {
  id: "trait-cloudevents",
  name: "CloudEvents",
  kind: "MESSAGE",
  ownerSlug: "acme",
  spec: {},
  headers: {
    format: "json-schema",
    dialect: "draft-07",
    schema: {
      type: "object",
      properties: { ce_id: { type: "string" }, ce_type: { type: "string" }, ce_source: { type: "string" } },
    },
  },
};

/** `OrderCreated@1.3`: payload → `Order@2.1`, key → `OrderKey@1.0`, traits [CloudEvents]. */
export const orderCreatedV13: ResolvedMessage = {
  id: "msgv-ordercreated-1.3",
  name: "OrderCreated",
  productSlug: "checkout",
  contentType: "avro/binary",
  traitRefs: ["trait-cloudevents"],
  payloads: [
    { format: "avro", schema: { type: "record", name: "Order", namespace: "acme.payments.checkout", fields: [] } },
    {
      format: "json-schema",
      dialect: "draft-07",
      schema: { $schema: "http://json-schema.org/draft-07/schema#", title: "Order", type: "object", properties: {} },
    },
  ],
  keys: [
    { format: "avro", schema: { type: "string" } },
    { format: "json-schema", dialect: "draft-07", schema: { type: "string" } },
  ],
};

export const kafkaProd: EventSpecServer = { key: "kafka-prod", protocol: "kafka", host: "kafka-prod.internal:9092" };

export const checkoutServiceSpec: ResolvedEventSpec = {
  productSlug: "checkout",
  info: { title: "checkout-service", version: "2.0" },
  servers: [kafkaProd],
  operations: [
    {
      key: "publishOrderCreated",
      action: "send",
      channelRef: ordersChannel.id,
      messageRefs: [orderCreatedV13.id],
      traitRefs: [],
    },
  ],
  channels: [ordersChannel],
  messages: [orderCreatedV13],
  traits: [cloudEventsTrait],
  components: {},
};

/** Fraud product consumes Checkout's channel cross-product (frozen copies, read-only). */
export const fraudScorerSpec: ResolvedEventSpec = {
  productSlug: "fraud",
  info: { title: "fraud-scorer", version: "1.0" },
  servers: [kafkaProd],
  operations: [
    {
      key: "consumeOrderCreated",
      action: "receive",
      channelRef: ordersChannel.id,
      messageRefs: [orderCreatedV13.id],
      traitRefs: [],
    },
  ],
  channels: [ordersChannel],
  messages: [orderCreatedV13],
  traits: [cloudEventsTrait],
  components: {},
};

/** The stored §6.1 draft document for `checkout-service` (IDs only). */
export const checkoutServiceDocument: EventSpecDocument = {
  info: { title: "checkout-service" },
  servers: [kafkaProd],
  operations: [
    {
      key: "publishOrderCreated",
      action: "send",
      channelId: ordersChannel.id,
      messageVersionIds: [orderCreatedV13.id],
      traitIds: [],
    },
  ],
};

/** Catalog snapshot the DB-backed resolver will load (Story 18.4); includes unrelated rows. */
export const workedExampleCatalog: EventSpecCatalog = {
  channels: [ordersChannel, { ...ordersChannel, id: "ch-unused", name: "refunds", address: "payments.refunds.v1" }],
  messages: [orderCreatedV13],
  traits: [cloudEventsTrait],
};

/** Spec §6.2 `checkout-service@2.0` YAML, verbatim. */
export const SPEC_6_2_CHECKOUT_YAML = `asyncapi: 3.0.0
info:
  title: checkout-service
  version: '2.0'
servers:
  kafka-prod:
    host: kafka-prod.internal:9092
    protocol: kafka
channels:
  orders:
    address: payments.orders.v1
    messages:
      OrderCreated:
        $ref: '#/components/messages/OrderCreated'
    bindings:
      kafka: { partitions: 12 }
operations:
  publishOrderCreated:
    action: send
    channel: { $ref: '#/channels/orders' }
    messages:
      - $ref: '#/channels/orders/messages/OrderCreated'
components:
  messages:
    OrderCreated:
      contentType: avro/binary
      traits:
        - $ref: '#/components/messageTraits/CloudEvents'
      payload:
        schemaFormat: application/vnd.apache.avro+json;version=1.9.0
        schema: { type: record, name: Order, namespace: acme.payments.checkout, fields: [] }
      bindings:
        kafka:
          key:
            schemaFormat: application/vnd.apache.avro+json;version=1.9.0
            schema: { type: string }
  messageTraits:
    CloudEvents:
      headers:
        type: object
        properties: { ce_id: {type: string}, ce_type: {type: string}, ce_source: {type: string} }
`;
