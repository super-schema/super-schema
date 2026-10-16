// tests/unit/lib/events/document/fixtures/maximal-document.ts
// An event document that uses EVERY AsyncAPI 3.0 property the document model can carry (info, server, channel, operation,
// reply, message, message trait, operation trait, correlation id, example, parameter, variable, every security scheme type).
import type { EventDocument } from "@/lib/events/document/types";
import { artifact } from "./compat-pipeline";
import type { MessageArtifacts } from "@/lib/events/document/resolve";
import type { SchemaArtifact } from "@/lib/event-specs/types";

const pin = (id: string, v: string | null = "ev1") => ({ entityId: id, entityVersionId: v });

export function maximalDocument(): EventDocument {
  return {
    documentVersion: 2,
    info: {
      title: "checkout-service", description: "Everything the checkout service emits.", termsOfService: "https://example.com/terms",
      contact: { name: "Platform team", url: "https://example.com/support", email: "platform@example.com" },
      license: { name: "Apache 2.0", url: "https://www.apache.org/licenses/LICENSE-2.0.html" },
      tags: [{ name: "payments", description: "Payments domain", externalDocs: { url: "https://example.com/payments", description: "Payments handbook" } }, { name: "core" }],
      externalDocs: { url: "https://example.com/docs", description: "Documentation" },
    },
    defaultContentType: "application/json",
    servers: [
      {
        key: "kafka-prod", protocol: "kafka", host: "{env}.kafka.example.com:9092", pathname: "/{region}", protocolVersion: "3.7",
        description: "The production cluster", title: "Kafka (production)", summary: "Production Kafka",
        variables: {
          env: { enum: ["prod", "stage"], default: "prod", description: "Environment", examples: ["prod"] },
          region: { enum: ["eu", "us"], default: "eu", description: "Region" },
        },
        security: ["basic", "oauth", "apiKeyUser"],
        tags: [{ name: "prod", description: "Production", externalDocs: { url: "https://example.com/prod" } }],
        externalDocs: { url: "https://example.com/kafka", description: "Runbook" },
        bindings: { kafka: { schemaRegistryUrl: "https://registry.example.com", schemaRegistryVendor: "confluent", bindingVersion: "0.5.0" } },
      },
      { key: "kafka-stage", protocol: "kafka", host: "kafka-stage.example.com:9092", origin: { provider: "infra", ref: "k-2", syncedAt: "2026-10-15T00:00:00Z" } },
    ],
    channels: [
      {
        key: "orders", address: "orders.{region}.v1", protocol: "kafka", serverKeys: ["kafka-prod", "kafka-stage"], format: "avro",
        title: "Orders", summary: "Order events", description: "Every order lifecycle event.",
        parameters: { region: { description: "Region of the order", enum: ["eu", "us"], default: "eu", examples: ["eu"], location: "$message.payload#/region" } },
        tags: [{ name: "orders", description: "Orders", externalDocs: { url: "https://example.com/orders" } }],
        externalDocs: { url: "https://example.com/orders-channel", description: "Channel docs" },
        bindings: { kafka: { topic: "orders.eu.v1", partitions: 12, replicas: 3, bindingVersion: "0.5.0" } },
        messageKeys: ["OrderCreated", "OrderSummary"],
      },
      { key: "replies", address: "orders.replies.v1", protocol: "kafka", serverKeys: ["kafka-prod"], format: "json-schema", formatDialect: "draft-07", messageKeys: ["OrderSummary"] },
    ],
    messages: [
      {
        key: "OrderCreated", name: "order.created", title: "Order created", summary: "A customer placed an order.", description: "Emitted once per order.",
        contentType: "avro/binary", correlationId: { location: "$message.header#/correlationId", description: "Correlates a reply with its request" },
        tags: [{ name: "created", description: "Creation", externalDocs: { url: "https://example.com/created" } }],
        externalDocs: { url: "https://example.com/order-created", description: "Message docs" }, deprecated: true,
        bindings: { kafka: { schemaIdLocation: "payload", schemaIdPayloadEncoding: "4", schemaLookupStrategy: "TopicIdStrategy", bindingVersion: "0.5.0" } },
        examples: [
          { name: "small", summary: "A small order", headers: { traceparent: "00-0af7651916cd43dd8448eb211c80319c-b7ad6b7169203331-01" }, payload: { id: "o-1" } },
          { payload: { id: "o-2" } },
        ],
        payload: pin("ent-order", "ev-order"), headers: pin("ent-headers", "ev-headers"), keyPin: pin("ent-order-key", "ev-order-key"), traitKeys: ["Envelope"],
      },
      { key: "OrderSummary", title: "Order summary", payload: pin("ent-summary", "ev-summary"), traitKeys: [] },
    ],
    traits: [
      {
        key: "Envelope", kind: "MESSAGE",
        spec: {
          name: "envelope", title: "Envelope", summary: "Standard envelope", description: "Carries tracing headers.", contentType: "application/json",
          correlationId: { location: "$message.header#/id", description: "Envelope id" },
          tags: [{ name: "envelope", description: "Envelope", externalDocs: { url: "https://example.com/envelope" } }],
          externalDocs: { url: "https://example.com/envelope-docs", description: "Envelope docs" }, deprecated: false,
          examples: [{ name: "e", summary: "An envelope", headers: { id: "1" } }],
          bindings: { kafka: { schemaIdLocation: "header", bindingVersion: "0.5.0" } },
        },
        headers: pin("ent-envelope-headers", "ev-envelope-headers"),
      },
      {
        key: "Audited", kind: "OPERATION",
        spec: {
          title: "Audited", summary: "The operation is audited", description: "Audit trail entry per call.", security: ["basic"],
          tags: [{ name: "audited", description: "Audited", externalDocs: { url: "https://example.com/audited" } }],
          externalDocs: { url: "https://example.com/audit", description: "Audit policy" },
          bindings: { kafka: { groupId: { type: "string", enum: ["audit"] }, bindingVersion: "0.5.0" } },
        },
      },
    ],
    operations: [
      {
        key: "createOrder", action: "send", channelKey: "orders", messageKeys: ["OrderCreated"], traitKeys: ["Audited"],
        title: "Create order", summary: "Publish an order", description: "Publishes OrderCreated when an order is placed.", security: ["apiKeyUser", "gss"],
        tags: [{ name: "orders", description: "Orders", externalDocs: { url: "https://example.com/orders-op" } }],
        externalDocs: { url: "https://example.com/create-order", description: "Operation docs" },
        bindings: { kafka: { groupId: { type: "string", enum: ["checkout"] }, clientId: { type: "string", enum: ["checkout-1"] }, bindingVersion: "0.5.0" } },
        reply: { address: { location: "$message.header#/replyTo", description: "Where the reply goes" }, channelKey: "replies", messageKeys: ["OrderSummary"] },
      },
      { key: "receiveOrderCreated", action: "receive", channelKey: "orders", messageKeys: ["OrderCreated", "OrderSummary"], traitKeys: [] },
    ],
    externalRefs: [],
    components: {
      correlationIds: { requestId: { location: "$message.header#/requestId", description: "Request id" } },
      securitySchemes: {
        basic: { type: "userPassword", description: "Username and password" },
        apiKeyUser: { type: "apiKey", in: "user", description: "API key as user" },
        apiKeyPassword: { type: "apiKey", in: "password" },
        cert: { type: "X509", description: "Client certificate" },
        sym: { type: "symmetricEncryption", description: "Shared secret" },
        asym: { type: "asymmetricEncryption", description: "Key pair" },
        headerKey: { type: "httpApiKey", name: "X-Api-Key", in: "header", description: "API key header" },
        queryKey: { type: "httpApiKey", name: "api_key", in: "query" },
        cookieKey: { type: "httpApiKey", name: "sid", in: "cookie" },
        bearer: { type: "http", scheme: "bearer", bearerFormat: "JWT", description: "Bearer token" },
        httpBasic: { type: "http", scheme: "basic", description: "HTTP basic" },
        oauth: {
          type: "oauth2", description: "OAuth 2.0", scopes: ["orders:write"],
          flows: {
            implicit: { authorizationUrl: "https://auth.example.com/authorize", refreshUrl: "https://auth.example.com/refresh", availableScopes: { "orders:write": "Write orders" } },
            password: { tokenUrl: "https://auth.example.com/token", availableScopes: { "orders:write": "Write orders" } },
            clientCredentials: { tokenUrl: "https://auth.example.com/token", availableScopes: { "orders:write": "Write orders" } },
            authorizationCode: { authorizationUrl: "https://auth.example.com/authorize", tokenUrl: "https://auth.example.com/token", availableScopes: { "orders:write": "Write orders" } },
          },
        },
        oidc: { type: "openIdConnect", description: "OpenID Connect", openIdConnectUrl: "https://auth.example.com/.well-known/openid-configuration", scopes: ["openid", "profile"] },
        plain: { type: "plain", description: "SASL PLAIN" },
        scram256: { type: "scramSha256", description: "SCRAM-SHA-256" },
        scram512: { type: "scramSha512", description: "SCRAM-SHA-512" },
        gss: { type: "gssapi", description: "Kerberos" },
      },
    },
  };
}

/** Rendered stand-ins for the entities the maximal document pins. */
export function maximalArtifacts(): { artifacts: Map<string, MessageArtifacts>; localTraitHeaders: Map<string, SchemaArtifact> } {
  const headers = (title: string): SchemaArtifact => ({ format: "json-schema", dialect: "draft-07", schema: { title, type: "object", properties: { traceparent: { type: "string" } } } });
  return {
    artifacts: new Map<string, MessageArtifacts>([
      ["OrderCreated", { payloads: [artifact("avro", "OrderCreated")], headers: headers("OrderCreatedHeaders"), keys: [artifact("avro", "OrderCreatedKey")] }],
      ["OrderSummary", { payloads: [artifact("avro", "OrderSummary"), artifact("json-schema", "OrderSummary")], keys: [] }],
    ]),
    localTraitHeaders: new Map<string, SchemaArtifact>([["Envelope", headers("EnvelopeHeaders")]]),
  };
}
