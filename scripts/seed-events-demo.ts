// Demo data for the Events builder (spec 2026-10-15-events-self-contained-design): Payments/Checkout and Risk/Fraud
// products, published entities, the built-in message properties (CloudEvents, W3C Trace Context), an Audited operation
// trait and four events. CloudEvents is a built-in library trait (`ensureBundledTraits`), not an entity: events use it
// through `traitKeys: ["CloudEvents"]`.
// Idempotent: re-running reuses what exists and re-applies the event documents.   npm run db:seed-events-demo
//
// A database seeded by an earlier version of this script holds a custom `CloudEvents` library trait that pins a
// `CloudEventsHeaders` entity. This run installs the built-in one next to it (the legacy trait gives up the name, see
// `retireLegacyCloudEvents`), points the events it owns at the built-in trait, and removes the legacy trait and entity
// when nothing else uses them; whatever is still used (by an event this script does not own) is kept and reported.
//
// Bundled with esbuild and run with node (like migrate-typespec-source.ts): the services pull in @typespec/compiler,
// which tsx cannot load.
import "dotenv/config";
import type { Prisma } from "@/generated/prisma/client";
import { prisma } from "@/lib/db";
import { bundledMarker, isBundledTrait } from "@/lib/events/bundled-traits";
import type { EventDocument } from "@/lib/events/document/types";
import type { JsonObject } from "@/lib/events/types";
import { deleteEntity } from "@/services/entity.service";
import { publishEntity } from "@/services/entity-version.service";
import { ensureBundledTraits } from "@/services/events/bundled-traits.service";
import { emitEventDraft } from "@/services/events/event-emit.service";
import { findEntityEventReferrers } from "@/services/events/event-guards";
import { createEvent, updateEventDocument } from "@/services/events/event.service";
import { createTrait, deleteTrait, updateTrait } from "@/services/events/trait.service";
import type { ServiceContext } from "@/types/service-context";

const TENANT = "tenant_default";
const TENANT_OWNER = { level: "TENANT", tenantId: TENANT } as const;
const unwrap = <T>(r: { success: true; data: T } | { success: false; error: { code: string; message: string; details?: unknown } }, what: string): T => {
  if (!r.success) throw new Error(`${what}: ${r.error.code} ${r.error.message} ${JSON.stringify(r.error.details ?? {})}`);
  return r.data;
};

interface Field { name: string; type: string }
/** What the clean-up of the legacy CloudEvents trait / entity did, printed at the end. */
const cleanupNotes: string[] = [];

async function main() {
  const user =
    (await prisma.user.findFirst({ where: { email: "jayesh.senjaliya@gmail.com" } })) ?? (await prisma.user.findFirstOrThrow());
  const ctx: ServiceContext = { userId: user.id, userRole: "AUTHOR", assignments: [{ role: "ADMIN", scope: { kind: "GLOBAL" } }], prisma };

  async function domain(slug: string, name: string) {
    return (await prisma.domain.findFirst({ where: { slug, tenantId: TENANT } })) ?? prisma.domain.create({ data: { name, slug, tenantId: TENANT } });
  }
  async function product(domainId: string, slug: string, name: string) {
    return (await prisma.product.findFirst({ where: { domainId, slug } })) ?? prisma.product.create({ data: { domainId, name, slug } });
  }
  /** Creates (if missing) and publishes an entity; `scope` null = tenant level. */
  async function entity(name: string, fields: Field[], scope: { domainId: string; productId: string } | null) {
    const where = { tenantId: TENANT, name, domainId: scope?.domainId ?? null, productId: scope?.productId ?? null };
    let row = await prisma.entity.findFirst({ where });
    if (!row) {
      const body = fields.map((f) => `  ${f.name}: ${f.type};`).join("\n");
      row = await prisma.entity.create({
        data: {
          name, slug: name.toLowerCase(), tenantId: TENANT, ownerId: user.id, domainId: where.domainId, productId: where.productId,
          typespecSource: `model ${name} {\n${body}\n}\n`,
          fields: { create: fields.map((f, i) => ({ name: f.name, slug: f.name, type: f.type, nullable: false, sortOrder: i, fieldNumber: i + 1, decorators: {} as Prisma.InputJsonValue })) },
        },
      });
    }
    if (!row.latestVersionId) unwrap(await publishEntity(row.id, {}, ctx), `publish ${name}`);
    return prisma.entity.findFirstOrThrow({ where: { id: row.id } });
  }
  async function libraryTrait(name: string, kind: "MESSAGE" | "OPERATION", input: { spec?: Record<string, unknown>; headersEntityId?: string }) {
    const existing = await prisma.trait.findFirst({ where: { tenantId: TENANT, domainId: null, productId: null, name } });
    if (existing) return existing;
    const created = unwrap(
      await createTrait(
        { level: "TENANT", tenantId: TENANT },
        { name, kind, spec: (input.spec ?? {}) as never, headers: input.headersEntityId ? { entityId: input.headersEntityId } : undefined },
        ctx
      ),
      `trait ${name}`
    );
    return prisma.trait.findFirstOrThrow({ where: { id: created.id } });
  }

  /** The tenant-level MESSAGE traits that are not built in and are called "CloudEvents" (or were renamed out of the way by an earlier run). */
  const legacyCloudEventsTraits = async () =>
    (await prisma.trait.findMany({
      where: { tenantId: TENANT, domainId: null, productId: null, kind: "MESSAGE" },
      select: { id: true, name: true, spec: true, headersEntityId: true, headersEntityVersionId: true },
    })).filter((t) => !isBundledTrait(t.spec) && /^cloudevents(-legacy(-\d+)?)?$/i.test(t.name));

  /**
   * Makes room for the built-in CloudEvents trait. An earlier seed created a custom tenant-level `CloudEvents` library trait (headers pinned
   * to the `CloudEventsHeaders` entity) and the name is line-unique, so the built-in one cannot be installed while it holds it. It is renamed
   * `CloudEvents-legacy` (events point at a trait by id, so every document that uses it keeps working; only the component name of its headers
   * changes) and retired later by `retireLegacyCloudEvents`, once the events this script owns point at the built-in trait.
   */
  async function makeRoomForBuiltInCloudEvents() {
    const holder = (await legacyCloudEventsTraits()).find((t) => t.name.toLowerCase() === "cloudevents");
    if (!holder) return;
    const taken = new Set((await prisma.trait.findMany({ where: { tenantId: TENANT, domainId: null, productId: null }, select: { name: true } })).map((t) => t.name.toLowerCase()));
    let name = "CloudEvents-legacy";
    for (let n = 2; taken.has(name.toLowerCase()); n++) name = `CloudEvents-legacy-${n}`;
    unwrap(
      await updateTrait(
        holder.id,
        {
          name, spec: holder.spec as JsonObject,
          headers: holder.headersEntityId ? { entityId: holder.headersEntityId, entityVersionId: holder.headersEntityVersionId } : null,
        },
        TENANT_OWNER, ctx
      ),
      "rename the legacy CloudEvents trait"
    );
    cleanupNotes.push(`legacy library trait "${holder.name}" (${holder.id}) renamed to "${name}" so the built-in CloudEvents trait can take the name`);
  }

  /** The built-in trait with this marker (`cloudevents@1.0`), found by what it says it is, never by its name. */
  async function builtInTrait(marker: string) {
    const rows = await prisma.trait.findMany({ where: { tenantId: TENANT, domainId: null, productId: null } });
    const found = rows.find((t) => bundledMarker(t.spec) === marker);
    if (!found) throw new Error(`the built-in trait ${marker} is not installed in ${TENANT}: its name is held by something that is not it`);
    return found;
  }

  /**
   * Retires the legacy custom CloudEvents trait and the `CloudEventsHeaders` entity it pinned, once nothing uses them: the trait through
   * `deleteTrait` (refuses while any event document references it), then the entity through `deleteEntity` after the event-edge guard
   * (`findEntityEventReferrers`) shows no event pins it. Whatever is still used stays, and is reported.
   */
  async function retireLegacyCloudEvents() {
    for (const legacy of await legacyCloudEventsTraits()) {
      const deleted = await deleteTrait(legacy.id, TENANT_OWNER, ctx);
      cleanupNotes.push(deleted.success
        ? `legacy library trait "${legacy.name}" deleted`
        : `legacy library trait "${legacy.name}" kept: ${deleted.error.code} ${deleted.error.message}`);
    }
    const entityRow = await prisma.entity.findFirst({ where: { tenantId: TENANT, name: "CloudEventsHeaders", domainId: null, productId: null } });
    if (!entityRow) return;
    const referrers = await findEntityEventReferrers(prisma, entityRow);
    if (referrers.length > 0) {
      cleanupNotes.push(`entity CloudEventsHeaders kept: pinned by event(s) ${referrers.map((r) => r.eventName).join(", ")}`);
      return;
    }
    const deleted = await deleteEntity(entityRow.id, ctx);
    cleanupNotes.push(deleted.success ? "entity CloudEventsHeaders deleted" : `entity CloudEventsHeaders kept: ${deleted.error.code} ${deleted.error.message}`);
  }

  // ── Org structure ──
  const payments = await domain("payments", "Payments");
  const risk = await domain("risk", "Risk");
  const checkout = await product(payments.id, "checkout", "Checkout");
  const fraud = await product(risk.id, "fraud", "Fraud");
  const checkoutScope = { domainId: payments.id, productId: checkout.id };
  const fraudScope = { domainId: risk.id, productId: fraud.id };

  // ── Entities (published, so they can be pinned) ──
  const order = await entity("Order", [
    { name: "id", type: "string" }, { name: "customerId", type: "string" }, { name: "status", type: "string" },
    { name: "total", type: "float64" }, { name: "currency", type: "string" }, { name: "createdAt", type: "utcDateTime" },
  ], checkoutScope);
  const orderKey = await entity("OrderKey", [{ name: "orderId", type: "string" }], checkoutScope);
  const notification = await entity("OrderNotification", [
    { name: "orderId", type: "string" }, { name: "customerId", type: "string" }, { name: "channel", type: "string" }, { name: "message", type: "string" },
  ], checkoutScope);
  const fraudScore = await entity("FraudScore", [
    { name: "orderId", type: "string" }, { name: "score", type: "float64" }, { name: "decision", type: "string" }, { name: "scoredAt", type: "utcDateTime" },
  ], fraudScope);
  const draftOnly = await entity("ReturnRequest", [{ name: "id", type: "string" }, { name: "orderId", type: "string" }, { name: "reason", type: "string" }], checkoutScope);
  const payment = await entity("Payment", [
    { name: "id", type: "string" }, { name: "orderId", type: "string" }, { name: "amount", type: "float64" },
    { name: "currency", type: "string" }, { name: "method", type: "string" }, { name: "capturedAt", type: "utcDateTime" },
  ], checkoutScope);
  const quoteRequest = await entity("QuoteRequest", [
    { name: "requestId", type: "string" }, { name: "sku", type: "string" }, { name: "quantity", type: "int32" }, { name: "requestedAt", type: "utcDateTime" },
  ], checkoutScope);
  const quoteResponse = await entity("QuoteResponse", [
    { name: "requestId", type: "string" }, { name: "unitPrice", type: "float64" }, { name: "currency", type: "string" },
    { name: "available", type: "boolean" }, { name: "validUntil", type: "utcDateTime" },
  ], checkoutScope);
  const shipment = await entity("Shipment", [
    { name: "id", type: "string" }, { name: "orderId", type: "string" }, { name: "carrier", type: "string" },
    { name: "trackingNumber", type: "string" }, { name: "dispatchedAt", type: "utcDateTime" },
  ], checkoutScope);

  // ── Tenant-level trait library: the built-in message properties and a custom operation trait ──
  await makeRoomForBuiltInCloudEvents();
  const installed = unwrap(await ensureBundledTraits(prisma, TENANT), "built-in message properties");
  if (installed.skipped.length > 0) throw new Error(`built-in message properties not installed, the name is taken by something else: ${installed.skipped.join(", ")}`);
  const cloudEvents = await builtInTrait("cloudevents@1.0");
  const audited = await libraryTrait("Audited", "OPERATION", { spec: { summary: "Operation is audited", tags: [{ name: "audited" }] } });

  const pin = (e: { id: string; latestVersionId: string | null }) => ({ entityId: e.id, entityVersionId: e.latestVersionId });
  const base = (title: string, description: string): Pick<EventDocument, "documentVersion" | "info" | "externalRefs" | "components"> => ({
    documentVersion: 2, info: { title, description }, externalRefs: [],
  });

  // ── Event 1: checkout-service (Kafka avro + parameterised address + Pub/Sub json-schema) ──
  const checkoutService: EventDocument = {
    ...base("checkout-service", "Events published by the Checkout service."),
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
        bindings: { googlepubsub: { messageRetentionDuration: "86400s", schemaSettings: { encoding: "json", name: "projects/acme-prod/schemas/order-notification" } } }, format: "json-schema", formatDialect: "draft-07",
        title: "Customer notifications", messageKeys: ["OrderNotification"] },
    ],
    messages: [
      { key: "OrderCreated", title: "Order created", summary: "A customer placed an order.", contentType: "avro/binary",
        payload: pin(order), keyPin: pin(orderKey), traitKeys: ["CloudEvents"] },
      { key: "OrderCancelled", title: "Order cancelled", summary: "An order was cancelled before shipping.", contentType: "avro/binary",
        payload: pin(order), keyPin: pin(orderKey), traitKeys: ["CloudEvents"] },
      { key: "OrderNotification", title: "Order notification", summary: "A notification to send to the customer.", contentType: "application/json",
        payload: pin(notification), traitKeys: [] },
    ],
    traits: [
      { key: "CloudEvents", kind: "MESSAGE", libraryTraitId: cloudEvents.id },
      { key: "Audited", kind: "OPERATION", libraryTraitId: audited.id },
    ],
    operations: [
      { key: "publishOrderCreated", action: "send", channelKey: "orders", messageKeys: ["OrderCreated"], traitKeys: ["Audited"], summary: "Publish when an order is placed" },
      { key: "publishOrderCancelled", action: "send", channelKey: "orders", messageKeys: ["OrderCancelled"], traitKeys: [], summary: "Publish when an order is cancelled" },
      { key: "publishCustomerOrder", action: "send", channelKey: "customer-orders", messageKeys: ["OrderCreated"], traitKeys: [] },
      { key: "publishOrderNotification", action: "send", channelKey: "order-notifications", messageKeys: ["OrderNotification"], traitKeys: [] },
    ],
  };

  // ── Event 2: fraud-scorer (consumes Checkout's orders, publishes scores) ──
  const fraudScorer: EventDocument = {
    ...base("fraud-scorer", "Scores every order for fraud risk."),
    servers: [
      { key: "kafka-prod", protocol: "kafka", host: "kafka-prod.internal:9092" },
      { key: "pubsub-prod", protocol: "googlepubsub", host: "pubsub.googleapis.com" },
    ],
    channels: [
      { key: "orders", address: "payments.orders.v1", protocol: "kafka", serverKeys: ["kafka-prod"], format: "avro", title: "Orders (from Checkout)", messageKeys: ["OrderCreated"] },
      { key: "fraud-scores", address: "fraud-scores", protocol: "googlepubsub", serverKeys: ["pubsub-prod"], format: "json-schema", formatDialect: "draft-07", messageKeys: ["FraudScored"] },
    ],
    messages: [
      { key: "OrderCreated", title: "Order created", contentType: "avro/binary", payload: pin(order), keyPin: pin(orderKey), traitKeys: ["CloudEvents"] },
      { key: "FraudScored", title: "Fraud scored", contentType: "application/json", payload: pin(fraudScore), traitKeys: [] },
    ],
    traits: [{ key: "CloudEvents", kind: "MESSAGE", libraryTraitId: cloudEvents.id }],
    operations: [
      { key: "receiveOrderCreated", action: "receive", channelKey: "orders", messageKeys: ["OrderCreated"], traitKeys: [], summary: "Consume new orders" },
      { key: "publishFraudScored", action: "send", channelKey: "fraud-scores", messageKeys: ["FraudScored"], traitKeys: [], summary: "Publish the score" },
    ],
  };

  // ── Event 3: returns-service — deliberately incomplete draft (unpinned payload, no operations) ──
  const returnsService: EventDocument = {
    ...base("returns-service", "Work in progress: shows that incomplete drafts save, and what the builder flags."),
    servers: [],
    channels: [{ key: "returns", address: "payments.returns.{region}.v1", protocol: "kafka", serverKeys: [], format: "avro",
      parameters: { region: { description: "Warehouse region" } }, messageKeys: ["ReturnRequested"] }],
    messages: [{ key: "ReturnRequested", title: "Return requested", payload: { entityId: draftOnly.id, entityVersionId: null }, traitKeys: [] }],
    traits: [], operations: [],
  };

  // ── Event 4: order-platform — the showcase: every part of an AsyncAPI document in one event ──
  const orderExample = { id: "o-1001", customerId: "c-42", status: "PLACED", total: 129.9, currency: "EUR", createdAt: "2026-10-15T10:15:30Z" };
  const ceExample = { specversion: "1.0", id: "3f1c9d1e-7b52-4a45-9b8a-0d8f3c2a1e10", source: "/checkout", type: "com.acme.order.created", time: "2026-10-15T10:15:30Z" };
  const showcase: EventDocument = {
    documentVersion: 2,
    info: {
      title: "order-platform",
      termsOfService: "https://example.com/terms",
      description:
        "Showcase event: every part of an AsyncAPI document in one place — several servers and protocols, parameterised and per-format channels, request/reply, message and operation traits, bindings, examples and security.\n\nOpen each section of the builder to see how it looks.",
      contact: { name: "Checkout Platform Team", url: "https://example.com/teams/checkout", email: "checkout-platform@example.com" },
      license: { name: "Apache 2.0", url: "https://www.apache.org/licenses/LICENSE-2.0.html" },
      tags: [{ name: "orders", description: "Order lifecycle events" }, { name: "payments", description: "Payment capture and settlement" }],
      externalDocs: { description: "Order platform runbook", url: "https://example.com/docs/order-platform" },
    },
    defaultContentType: "application/json",
    servers: [
      { key: "kafka-prod", protocol: "kafka", protocolVersion: "3.6", host: "kafka-prod.{region}.internal:9092", title: "Kafka production", summary: "Primary event backbone",
        description: "Production Kafka cluster, one per region.",
        variables: { region: { enum: ["eu", "us"], default: "eu", description: "Region the cluster runs in", examples: ["eu"] } },
        security: ["kafkaSasl"], tags: [{ name: "production" }],
        externalDocs: { description: "Cluster runbook", url: "https://example.com/docs/kafka" },
        bindings: { kafka: { schemaRegistryUrl: "https://schema-registry.internal", schemaRegistryVendor: "confluent" } } },
      { key: "kafka-staging", protocol: "kafka", host: "kafka-staging.internal:9092", title: "Kafka staging", description: "Staging Kafka cluster", security: ["kafkaSasl"] },
      { key: "pubsub-prod", protocol: "googlepubsub", host: "pubsub.googleapis.com", title: "Pub/Sub", description: "Google Cloud Pub/Sub", security: ["pubsubOauth"] },
      { key: "pulsar-prod", protocol: "pulsar", host: "pulsar.internal:6650", pathname: "/orders", description: "Apache Pulsar (archive tier)", security: ["gatewayApiKey"] },
    ],
    channels: [
      { key: "orders", address: "payments.orders.v1", protocol: "kafka", serverKeys: ["kafka-prod", "kafka-staging"],
        bindings: { kafka: { partitions: 12, replicas: 3, topicConfiguration: { "cleanup.policy": ["delete"], "retention.ms": 604800000 } } },
        format: "avro", title: "Orders", summary: "Order lifecycle topic",
        description: "Every order lifecycle event, keyed by order id so a single order is always consumed in order.",
        tags: [{ name: "orders" }], externalDocs: { description: "Topic ownership", url: "https://example.com/docs/topics/orders" },
        messageKeys: ["OrderCreated", "OrderCancelled", "PaymentCaptured"] },
      { key: "customer-orders", address: "payments.customers.{customerId}.orders.v1", protocol: "kafka", serverKeys: ["kafka-prod"],
        parameters: { customerId: { description: "Customer the orders belong to", examples: ["c-42"] } },
        format: "avro", title: "Per-customer orders", summary: "Orders fanned out per customer", messageKeys: ["OrderCreated"] },
      { key: "order-notifications", address: "order-notifications", protocol: "googlepubsub", serverKeys: ["pubsub-prod"],
        bindings: { googlepubsub: { messageRetentionDuration: "86400s", schemaSettings: { encoding: "json", name: "projects/acme-prod/schemas/order-notification" } } },
        format: "json-schema", formatDialect: "draft-07", title: "Customer notifications", summary: "What to tell the customer", messageKeys: ["OrderNotification"] },
      { key: "quotes-request", address: "pricing.quotes.requests.v1", protocol: "kafka", serverKeys: ["kafka-prod"],
        format: "json-schema", formatDialect: "draft-07", title: "Quote requests", messageKeys: ["QuoteRequested"] },
      { key: "quotes-reply", address: "pricing.quotes.replies.v1", protocol: "kafka", serverKeys: ["kafka-prod"],
        format: "json-schema", formatDialect: "draft-07", title: "Quote replies", messageKeys: ["QuoteProvided"] },
      { key: "order-archive", address: "persistent://acme/orders/archive", protocol: "pulsar", serverKeys: ["pulsar-prod"],
        bindings: { pulsar: { namespace: "acme/orders", persistence: "persistent" } },
        format: "json-schema", formatDialect: "draft-07", title: "Order archive", summary: "Long-term order archive", messageKeys: ["OrderCreated"] },
      { key: "shipments", address: "logistics.shipments.v1", protocol: "kafka", serverKeys: ["kafka-prod"],
        format: "protobuf", title: "Shipments", summary: "Dispatch notifications (Protobuf)", messageKeys: ["ShipmentDispatched"] },
    ],
    messages: [
      { key: "OrderCreated", name: "OrderCreated", title: "Order created", summary: "A customer placed an order.",
        description: "Published once, after payment authorisation succeeds. Consumers must treat it as at-least-once.",
        contentType: "avro/binary", payload: pin(order), keyPin: pin(orderKey), traitKeys: ["CloudEvents", "Traced"],
        correlationId: { location: "$message.header#/id", description: "The CloudEvents id" },
        tags: [{ name: "orders" }], externalDocs: { description: "Event catalogue entry", url: "https://example.com/docs/events/order-created" },
        bindings: { kafka: { schemaIdLocation: "header" } },
        examples: [{ name: "standardOrder", summary: "A typical order", payload: orderExample, headers: ceExample }] },
      { key: "OrderCancelled", title: "Order cancelled", summary: "An order was cancelled before shipping.",
        contentType: "avro/binary", payload: pin(order), keyPin: pin(orderKey), traitKeys: ["CloudEvents"],
        examples: [{ name: "cancelled", payload: { ...orderExample, status: "CANCELLED" }, headers: { ...ceExample, type: "com.acme.order.cancelled" } }] },
      { key: "PaymentCaptured", title: "Payment captured", summary: "Funds were captured for an order.",
        contentType: "avro/binary", payload: pin(payment), keyPin: pin(orderKey), traitKeys: ["CloudEvents"] },
      { key: "OrderNotification", title: "Order notification", summary: "A notification to send to the customer.",
        contentType: "application/json", payload: pin(notification), traitKeys: ["Traced"] },
      { key: "QuoteRequested", title: "Quote requested", summary: "Ask pricing for a quote.", contentType: "application/json",
        payload: pin(quoteRequest), traitKeys: ["Traced"], correlationId: { location: "$message.payload#/requestId", description: "Matches the reply to the request" } },
      { key: "QuoteProvided", title: "Quote provided", summary: "Pricing's answer to a quote request.", contentType: "application/json",
        payload: pin(quoteResponse), traitKeys: [], correlationId: { location: "$message.payload#/requestId" } },
      { key: "ShipmentDispatched", title: "Shipment dispatched", summary: "A parcel left the warehouse.",
        contentType: "application/x-protobuf", payload: pin(shipment), traitKeys: [] },
    ],
    traits: [
      { key: "CloudEvents", kind: "MESSAGE", libraryTraitId: cloudEvents.id },
      { key: "Audited", kind: "OPERATION", libraryTraitId: audited.id },
      { key: "Traced", kind: "MESSAGE", spec: { summary: "Distributed tracing", description: "Carries the W3C trace context so a message can be followed across services.",
        correlationId: { location: "$message.header#/traceparent", description: "W3C trace context" }, tags: [{ name: "observability" }] } },
      { key: "Idempotent", kind: "OPERATION", spec: { summary: "Safe to retry", description: "Re-delivering this operation has no additional effect.",
        tags: [{ name: "idempotent" }], externalDocs: { description: "Idempotency rules", url: "https://example.com/docs/idempotency" } } },
    ],
    operations: [
      { key: "publishOrderCreated", action: "send", channelKey: "orders", messageKeys: ["OrderCreated"], traitKeys: ["Audited", "Idempotent"],
        title: "Publish order created", summary: "Publish when an order is placed", description: "Sent exactly once per order after payment authorisation.",
        security: ["kafkaSasl"], tags: [{ name: "orders" }, { name: "critical" }],
        externalDocs: { description: "Publishing guide", url: "https://example.com/docs/publishing/order-created" } },
      { key: "publishOrderCancelled", action: "send", channelKey: "orders", messageKeys: ["OrderCancelled"], traitKeys: ["Audited"], summary: "Publish when an order is cancelled" },
      { key: "publishPaymentCaptured", action: "send", channelKey: "orders", messageKeys: ["PaymentCaptured"], traitKeys: [], summary: "Publish when funds are captured" },
      { key: "publishCustomerOrder", action: "send", channelKey: "customer-orders", messageKeys: ["OrderCreated"], traitKeys: [], summary: "Fan the order out to the customer's own topic" },
      { key: "publishOrderNotification", action: "send", channelKey: "order-notifications", messageKeys: ["OrderNotification"], traitKeys: [] },
      { key: "archiveOrder", action: "receive", channelKey: "order-archive", messageKeys: ["OrderCreated"], traitKeys: [], summary: "Archive every order" },
      { key: "requestQuote", action: "receive", channelKey: "quotes-request", messageKeys: ["QuoteRequested"], traitKeys: ["Idempotent"],
        summary: "Answer quote requests", description: "Request/reply: the answer goes to the reply channel, matched by requestId.",
        bindings: { kafka: { groupId: { type: "string", enum: ["quote-workers"] }, clientId: { type: "string" } } },
        reply: { channelKey: "quotes-reply", messageKeys: ["QuoteProvided"] } },
      { key: "publishShipment", action: "send", channelKey: "shipments", messageKeys: ["ShipmentDispatched"], traitKeys: [], summary: "Publish when a parcel is dispatched" },
    ],
    externalRefs: [],
    components: {
      securitySchemes: {
        kafkaSasl: { type: "scramSha512", description: "SASL/SCRAM-SHA-512 credentials issued per service account." },
        pubsubOauth: { type: "oauth2", description: "Google service-account OAuth 2.0 (client credentials).",
          flows: { clientCredentials: { tokenUrl: "https://oauth2.googleapis.com/token", availableScopes: { "https://www.googleapis.com/auth/pubsub": "Publish and subscribe to topics" } } } },
        gatewayApiKey: { type: "httpApiKey", name: "X-Api-Key", in: "header", description: "API key issued by the gateway team." },
      },
    },
  };

  const results: Array<{ name: string; url: string; diagnostics: string }> = [];
  for (const [prod, slugs, doc] of [
    [checkout, { d: payments.slug, p: checkout.slug }, checkoutService],
    [fraud, { d: risk.slug, p: fraud.slug }, fraudScorer],
    [checkout, { d: payments.slug, p: checkout.slug }, returnsService],
    [checkout, { d: payments.slug, p: checkout.slug }, showcase],
  ] as const) {
    const name = doc.info.title;
    const existing = await prisma.eventSpec.findFirst({ where: { name, productId: prod.id }, select: { id: true } });
    const id = existing?.id ?? unwrap(await createEvent(prod.id, { name, description: doc.info.description }, ctx), `create ${name}`).id;
    unwrap(await updateEventDocument(id, doc, { level: "PRODUCT", productId: prod.id }, ctx), `save ${name}`);
    const emitted = await emitEventDraft(id, prod.id, ctx);
    let diagnostics: string;
    if (!emitted.success) diagnostics = `EMIT FAILED: ${emitted.error.code} ${emitted.error.message}`;
    else {
      const d = emitted.data.diagnostics;
      const by = (s: string) => d.filter((x) => x.severity === s).length;
      diagnostics = `${emitted.data.document ? "AsyncAPI document produced" : "no document"}; ${by("error")} error(s), ${by("warning")} warning(s), ${by("info")} info`;
      for (const x of d.filter((x) => x.severity === "error")) diagnostics += `\n      error ${x.code} @ ${x.pointer}: ${x.message}`;
    }
    results.push({ name, url: `/schemas/${slugs.d}/${slugs.p}/events/${id}`, diagnostics });
  }

  // The events now point at the built-in CloudEvents trait: the legacy custom trait / entity can go once nothing else uses them.
  await retireLegacyCloudEvents();

  console.log("\nEvents demo data ready:");
  for (const r of results) console.log(`  ${r.name}\n    ${r.url}\n    ${r.diagnostics}`);
  console.log(`\nDomains: Payments (checkout), Risk (fraud). Library traits: CloudEvents (built in), TraceContext (built in), Audited. Entities: ${[order, orderKey, notification, fraudScore, draftOnly, payment, quoteRequest, quoteResponse, shipment].map((e) => e.name).join(", ")}`);
  console.log(cleanupNotes.length > 0 ? `\nLegacy CloudEvents clean-up:\n${cleanupNotes.map((n) => `  - ${n}`).join("\n")}` : "\nLegacy CloudEvents clean-up: nothing to do.");
}

main()
  .then(() => prisma.$disconnect())
  .catch(async (e) => { console.error(e); await prisma.$disconnect(); process.exit(1); });
