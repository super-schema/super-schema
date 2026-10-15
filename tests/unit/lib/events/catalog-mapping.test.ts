import { describe, it, expect } from "vitest";
import {
  messageSourceFromDraft, messageSourceFromVersion, planArtifacts, toFrozenTrait, toResolvedChannel, toResolvedMessage, toResolvedTrait, traitHeadersSubject,
} from "@/lib/events/catalog-mapping";

const channel = (over: Record<string, unknown> = {}) =>
  toResolvedChannel({ id: "c1", name: "orders", address: "payments.orders.v1", protocol: "kafka", format: "avro", formatDialect: null, spec: { bindings: { kafka: { partitions: 12 } } }, product: { slug: "checkout" }, ...over });

describe("catalog mapping", () => {
  it("maps channel rows to ResolvedChannel (JSON Schema defaults to draft-07)", () => {
    expect(channel()).toEqual({
      id: "c1", name: "orders", productSlug: "checkout", address: "payments.orders.v1", protocol: "kafka",
      profile: { format: "avro" }, bindings: { kafka: { partitions: 12 } },
    });
    expect(channel({ format: "json-schema" }).profile).toEqual({ format: "json-schema", dialect: "draft-07" });
    expect(channel({ format: "json-schema", formatDialect: "2020-12" }).profile).toEqual({ format: "json-schema", dialect: "2020-12" });
  });

  it("builds message sources from versions (frozen pins) and drafts (pins or draft entities)", () => {
    expect(
      messageSourceFromVersion({
        id: "mv1", messageId: "m1", major: 1, minor: 3,
        resolvedSpec: {
          name: "OrderCreated", spec: { contentType: "avro/binary", traitIds: ["t1"] },
          payload: { entityId: "e1", entityName: "Order", entityVersionId: "v21", label: "2.1", major: 2 }, headers: null,
          key: { entityId: "e2", entityName: "OrderKey", entityVersionId: "vk", label: "1.0", major: 1 },
        },
        message: { name: "OrderCreated", product: { slug: "checkout" } },
      })
    ).toEqual({
      id: "mv1", messageId: "m1", name: "OrderCreated", productSlug: "checkout", spec: { contentType: "avro/binary", traitIds: ["t1"] },
      payload: { kind: "version", entityVersionId: "v21" }, headers: null, key: { kind: "version", entityVersionId: "vk" }, unpublished: false,
    });
    expect(messageSourceFromVersion({ id: "x", messageId: "m", major: 1, minor: 0, resolvedSpec: {}, message: { name: "M", product: null } })).toBeNull();
    expect(
      messageSourceFromDraft({
        id: "m2", name: "OrderCancelled", spec: {}, payloadEntityId: "e1", payloadEntityVersionId: null,
        headersEntityId: "e3", headersEntityVersionId: "vh", keyEntityId: null, keyEntityVersionId: null, product: { slug: "checkout" },
      })
    ).toMatchObject({ id: "m2", payload: { kind: "draft", entityId: "e1" }, headers: { kind: "version", entityVersionId: "vh" }, key: null, unpublished: true });
  });

  it("plans payload formats per channel and Kafka keys (Avro on Avro channels, else JSON Schema)", () => {
    const channels = new Map([
      ["c1", channel()],
      ["c2", channel({ id: "c2", format: "json-schema", protocol: "kafka" })],
      ["c3", channel({ id: "c3", format: "json-schema", protocol: "pulsar" })],
    ]);
    const plan = planArtifacts(
      {
        info: { title: "x" }, servers: [],
        operations: [
          { key: "a", action: "send", channelId: "c1", messageVersionIds: ["mv1"], traitIds: [] },
          { key: "b", action: "send", channelId: "c2", messageVersionIds: ["mv1"], traitIds: [], reply: { channelId: "c3", messageVersionIds: ["mv2"] } },
        ],
      },
      channels
    );
    expect(plan.get("mv1")).toEqual({ payloadFormats: ["avro", "json-schema"], keyFormats: ["avro", "json-schema"] });
    expect(plan.get("mv2")).toEqual({ payloadFormats: ["json-schema"], keyFormats: [] });
  });

  it("plans artifact formats for reply messages even when they lack a dedicated reply channel (fallback to op channel)", () => {
    const channels = new Map([["ch1", { id: "ch1", profile: { format: "avro" as const } } as ResolvedChannel]]);
    const doc: EventSpecDocument = {
      info: { title: "t" },
      servers: [],
      operations: [
        {
          key: "op1",
          action: "receive",
          channelId: "ch1",
          messageVersionIds: ["mv1"],
          traitIds: [],
          reply: { messageVersionIds: ["mv2"] }, // reply messages, NO reply channel
        },
      ],
    };
    const needs = planArtifacts(doc, channels);
    // mv2 should get its format from the operation's own channel as fallback
    expect(needs.get("mv2")).toEqual({ payloadFormats: ["avro"], keyFormats: [] });
  });

  it("maps messages and traits to resolved shapes", () => {
    const source = messageSourceFromDraft({
      id: "m2", name: "OrderCancelled", spec: { summary: "s", traitIds: ["t1"] }, payloadEntityId: "e1", payloadEntityVersionId: "v1",
      headersEntityId: null, headersEntityVersionId: null, keyEntityId: null, keyEntityVersionId: null, product: { slug: "checkout" },
    });
    const payload = { format: "avro" as const, schema: { type: "record", name: "Order", fields: [] } };
    expect(toResolvedMessage(source, { payloads: [payload], keys: [] })).toEqual({
      id: "m2", name: "OrderCancelled", productSlug: "checkout", summary: "s", traitRefs: ["t1"], payloads: [payload], unpublished: true,
    });
    const trait = toFrozenTrait({
      id: "t1", name: "CloudEvents", kind: "MESSAGE", spec: { summary: "ce" }, headersEntityId: "e9", headersEntityVersionId: null,
      tenant: { slug: "acme" }, domain: null, product: null,
    });
    expect(trait).toEqual({ id: "t1", name: "CloudEvents", kind: "MESSAGE", ownerSlug: "acme", spec: { summary: "ce" }, headersEntityId: "e9", headersEntityVersionId: null });
    expect(traitHeadersSubject(trait)).toEqual({ kind: "draft", entityId: "e9" });
    expect(toResolvedTrait(trait)).toEqual({ id: "t1", name: "CloudEvents", kind: "MESSAGE", ownerSlug: "acme", spec: { summary: "ce" } });
  });
});
