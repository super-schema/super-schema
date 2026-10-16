// tests/unit/lib/events/document/resolve-representation.test.ts
// WP-1b: effective representations drive the artifact plan, the resolved spec (message / channel profiles) and the emitted
// document; `emitAll` carries and emits everything the user defined; existing documents are untouched.
import { describe, expect, it } from "vitest";
import { assembleAsyncApi3 } from "@/lib/event-specs/assemble";
import { SCHEMA_FORMATS } from "@/lib/event-specs/schema-format";
import type { Diagnostic, JsonObject, PayloadFormat } from "@/lib/event-specs/types";
import { validateAsyncApi3Structure } from "@/lib/event-specs/validator";
import { AsyncApiParserValidator } from "@/lib/event-specs/validation/asyncapi-parser-validator";
import { planDocumentArtifacts, resolveDocument } from "@/lib/events/document/resolve";
import { emptyEventDocument, type DocChannel, type EventDocument } from "@/lib/events/document/types";
import { artifact, artifactsFor, resolveInput, runPipeline } from "./fixtures/compat-pipeline";
import { maximalArtifacts, maximalDocument } from "./fixtures/maximal-document";
import { demoCheckoutService, demoFraudScorer, demoReturnsService, slice1KitchenSink, slice1Minimal } from "./fixtures/slice1-documents";

const pin = (entityId: string) => ({ entityId, entityVersionId: `v-${entityId}` });
const formats = (entries: Array<[string, PayloadFormat | undefined]> = []): ReadonlyMap<string, PayloadFormat | undefined> => new Map(entries);
const at = (doc: unknown, ...path: string[]): unknown => path.reduce<unknown>((node, key) => (node as Record<string, unknown> | undefined)?.[key], doc);
const keys = (value: unknown): string[] => Object.keys((value ?? {}) as object);
const errorsOf = (list: Array<{ severity: string }>) => list.filter((d) => d.severity === "error");

/** A Kafka channel and a Pub/Sub channel, neither with a format (Auto), one message and one send operation each. */
function autoDoc(): EventDocument {
  return {
    ...emptyEventDocument("checkout-service"),
    servers: [{ key: "kafka", protocol: "kafka", host: "kafka.internal:9092" }, { key: "pubsub", protocol: "googlepubsub", host: "pubsub.googleapis.com" }],
    channels: [
      { key: "orders", address: "orders.v1", protocol: "kafka", serverKeys: ["kafka"], messageKeys: ["OrderCreated"] },
      { key: "notices", address: "projects/acme/topics/notices", protocol: "googlepubsub", serverKeys: ["pubsub"], messageKeys: ["Notice"] },
    ],
    messages: [
      { key: "OrderCreated", payload: pin("ent-order"), keyPin: pin("ent-order-key"), traitKeys: [] },
      { key: "Notice", payload: pin("ent-notice"), traitKeys: [] },
    ],
    operations: [
      { key: "publishOrderCreated", action: "send", channelKey: "orders", messageKeys: ["OrderCreated"], traitKeys: [] },
      { key: "publishNotice", action: "send", channelKey: "notices", messageKeys: ["Notice"], traitKeys: [] },
    ],
  };
}
const channelOf = (doc: EventDocument, key: string): DocChannel => doc.channels.find((c) => c.key === key) as DocChannel;

describe("planDocumentArtifacts with effective representations", () => {
  it("Auto on a Kafka channel without a format: Avro payload and Avro key", () => {
    expect(planDocumentArtifacts(autoDoc()).get("OrderCreated")).toEqual({ payloadFormats: ["avro"], keyFormats: ["avro"] });
  });

  it("Auto on a Pub/Sub channel without a format: JSON Schema payload, no key", () => {
    expect(planDocumentArtifacts(autoDoc()).get("Notice")).toEqual({ payloadFormats: ["json-schema"], keyFormats: [] });
  });

  it("Auto with an Avro-imported entity on a Pub/Sub channel: Avro payload (the entity beats the protocol default)", () => {
    expect(planDocumentArtifacts(autoDoc(), formats([["ent-notice", "avro"]])).get("Notice")).toEqual({ payloadFormats: ["avro"], keyFormats: [] });
  });

  it("an entity JSON Schema on a Kafka channel gives a JSON Schema payload and a JSON Schema key", () => {
    expect(planDocumentArtifacts(autoDoc(), formats([["ent-order", "json-schema"]])).get("OrderCreated")).toEqual({ payloadFormats: ["json-schema"], keyFormats: ["json-schema"] });
  });

  it("a message representation beats the channel's explicit format and the entity", () => {
    const d = autoDoc();
    d.channels[0].format = "avro";
    d.messages[0].representation = "protobuf";
    expect(planDocumentArtifacts(d, formats([["ent-order", "avro"]])).get("OrderCreated")).toEqual({ payloadFormats: ["protobuf"], keyFormats: ["json-schema"] });
  });

  it("an explicit channel format beats the entity", () => {
    const d = autoDoc();
    d.channels[1].format = "json-schema";
    expect(planDocumentArtifacts(d, formats([["ent-notice", "avro"]])).get("Notice")).toEqual({ payloadFormats: ["json-schema"], keyFormats: [] });
  });

  it("a message on two Auto channels is rendered once: the first channel's protocol decides for both", () => {
    const d = autoDoc();
    d.channels[1].messageKeys = ["Notice", "OrderCreated"];
    expect(planDocumentArtifacts(d).get("OrderCreated")).toEqual({ payloadFormats: ["avro"], keyFormats: ["avro"] });
  });

  it("a message on an explicit Avro channel and an Auto Pub/Sub channel with a JSON Schema entity is rendered in both formats", () => {
    const d = autoDoc();
    d.channels[0].format = "avro";
    d.channels[1].messageKeys = ["Notice", "OrderCreated"];
    expect(planDocumentArtifacts(d, formats([["ent-order", "json-schema"]])).get("OrderCreated")).toEqual({ payloadFormats: ["avro", "json-schema"], keyFormats: ["avro"] });
  });

  it("is what it always was for explicit formats without representations", () => {
    for (const build of [slice1Minimal, demoCheckoutService, demoFraudScorer, demoReturnsService, slice1KitchenSink]) {
      const doc = build();
      for (const [key, need] of planDocumentArtifacts(doc)) {
        const channels = doc.channels.filter((c) => c.messageKeys.includes(key) || doc.operations.some((o) => o.channelKey === c.key && o.messageKeys.includes(key)));
        expect(need.payloadFormats).toEqual([...new Set(channels.map((c) => c.format))].sort());
      }
    }
  });

  it("leaves out a message that no channel or operation carries — unless emitAll asks for it", () => {
    const d = autoDoc();
    d.messages.push({ key: "Orphan", payload: pin("ent-orphan"), traitKeys: [] });
    expect(planDocumentArtifacts(d).has("Orphan")).toBe(false);
    expect(planDocumentArtifacts(d, formats(), { emitAll: true }).get("Orphan")).toEqual({ payloadFormats: ["json-schema"], keyFormats: [] });
  });

  it("emitAll plans an orphan in its own representation, and never a Kafka key for it", () => {
    const d = autoDoc();
    d.messages.push({ key: "Orphan", payload: pin("ent-orphan"), keyPin: pin("ent-key"), representation: "avro", traitKeys: [] });
    expect(planDocumentArtifacts(d, formats(), { emitAll: true }).get("Orphan")).toEqual({ payloadFormats: ["avro"], keyFormats: [] });
    expect(planDocumentArtifacts(d, formats([["ent-orphan", "protobuf"]]), { emitAll: true }).get("Orphan")?.payloadFormats).toEqual(["avro"]);
    d.messages[2].representation = undefined;
    expect(planDocumentArtifacts(d, formats([["ent-orphan", "protobuf"]]), { emitAll: true }).get("Orphan")?.payloadFormats).toEqual(["protobuf"]);
  });

  it("emitAll does not change the plan of messages that are already carried", () => {
    const d = autoDoc();
    expect([...planDocumentArtifacts(d, formats(), { emitAll: true })]).toEqual([...planDocumentArtifacts(d)]);
  });

  it("keeps an entry for an external message key listed on a local channel (as before)", () => {
    const d = autoDoc();
    d.externalRefs = [{ key: "ext-msg", eventVersionId: "ev1", kind: "message", itemKey: "M" }];
    d.channels[0].messageKeys.push("ext-msg");
    expect(planDocumentArtifacts(d).get("ext-msg")).toEqual({ payloadFormats: ["avro"], keyFormats: ["avro"] });
  });
});

describe("resolveDocument + assembler: the effective representation is what is emitted", () => {
  it("a Kafka channel without a format emits Avro, with an Avro key", () => {
    const { document, diagnostics, resolved } = runPipeline(autoDoc());
    expect(at(document, "components", "messages", "OrderCreated", "payload", "schemaFormat")).toBe(SCHEMA_FORMATS.avro);
    expect(at(document, "components", "messages", "OrderCreated", "contentType")).toBe("avro/binary");
    expect(at(document, "components", "messages", "OrderCreated", "bindings", "kafka", "key", "schemaFormat")).toBe(SCHEMA_FORMATS.avro);
    expect(resolved.messages.find((m) => m.id === "OrderCreated")?.profile).toEqual({ format: "avro" });
    expect(resolved.channels.find((c) => c.id === "orders")?.profile).toEqual({ format: "avro" });
    expect(diagnostics).toEqual([]);
  });

  it("a Pub/Sub channel without a format and no recorded entity format emits JSON Schema draft-07", () => {
    const { document, resolved } = runPipeline(autoDoc());
    expect(at(document, "components", "messages", "Notice", "payload", "schemaFormat")).toBe(SCHEMA_FORMATS.jsonSchemaDraft07);
    expect(resolved.messages.find((m) => m.id === "Notice")?.profile).toEqual({ format: "json-schema", dialect: "draft-07" });
    expect(resolved.channels.find((c) => c.id === "notices")?.profile).toEqual({ format: "json-schema", dialect: "draft-07" });
  });

  it("Auto with an Avro-imported entity on a Pub/Sub channel emits Avro", () => {
    const { document, diagnostics, resolved } = runPipeline(autoDoc(), { entityFormats: formats([["ent-notice", "avro"]]) });
    expect(at(document, "components", "messages", "Notice", "payload", "schemaFormat")).toBe(SCHEMA_FORMATS.avro);
    expect(at(document, "components", "messages", "Notice", "contentType")).toBe("avro/binary");
    expect(resolved.channels.find((c) => c.id === "notices")?.profile).toEqual({ format: "avro" });
    expect(diagnostics).toEqual([]);
  });

  it("an explicit message representation picks the artifact and the key profile: protobuf payload, JSON Schema key on Kafka", () => {
    const d = autoDoc();
    d.messages[0].representation = "protobuf";
    const { document, diagnostics } = runPipeline(d);
    expect(at(document, "components", "messages", "OrderCreated", "payload", "schemaFormat")).toBe(SCHEMA_FORMATS.protobuf);
    expect(typeof at(document, "components", "messages", "OrderCreated", "payload", "schema")).toBe("string");
    const key = at(document, "components", "messages", "OrderCreated", "bindings", "kafka", "key") as JsonObject;
    expect(key).not.toHaveProperty("schemaFormat");
    expect(key.title).toBe("OrderCreatedKey");
    expect(diagnostics).toEqual([]);
  });

  it("a message representation overrides an explicit channel format", () => {
    const d = autoDoc();
    d.channels[0].format = "avro";
    d.messages[0].representation = "json-schema";
    const { document, resolved, diagnostics } = runPipeline(d);
    expect(at(document, "components", "messages", "OrderCreated", "payload", "schemaFormat")).toBe(SCHEMA_FORMATS.jsonSchemaDraft07);
    expect(at(document, "components", "messages", "OrderCreated", "contentType")).toBe("application/json");
    expect(keys(at(document, "components", "messages"))).toEqual(["Notice", "OrderCreated"]);
    expect(resolved.channels.find((c) => c.id === "orders")?.profile).toEqual({ format: "avro" });
    expect(diagnostics).toEqual([]);
  });

  it("an explicit Avro channel without any representation is emitted as before: no message profile, no per-channel entries", () => {
    const d = autoDoc();
    d.channels[0].format = "avro";
    const { resolved } = runPipeline(d);
    expect(resolved.messages.find((m) => m.id === "OrderCreated")).not.toHaveProperty("profile");
    expect(resolved.channels.find((c) => c.id === "orders")).not.toHaveProperty("messageProfiles");
  });

  it("a channel dialect without a format applies to JSON Schema messages on it", () => {
    const d = autoDoc();
    d.channels[1].formatDialect = "2020-12";
    const input = resolveInput(d);
    input.artifacts = new Map([...input.artifacts, ["Notice", { payloads: [artifact("json-schema", "Notice"), { ...artifact("json-schema", "Notice"), dialect: "2020-12" as const }], keys: [] }]]);
    const r = resolveDocument(input);
    expect(r.success).toBe(true);
    if (!r.success) return;
    expect(r.data.channels.find((c) => c.id === "notices")?.profile).toEqual({ format: "json-schema", dialect: "2020-12" });
    expect(r.data.messages.find((m) => m.id === "Notice")?.profile).toEqual({ format: "json-schema", dialect: "2020-12" });
    const out = assembleAsyncApi3(r.data);
    expect(at(out.document, "components", "messages", "Notice", "payload", "schemaFormat")).toBe(SCHEMA_FORMATS.jsonSchema202012);
  });

  describe("a channel without a format takes the profile of its messages' majority (first message on a tie)", () => {
    function pubsubWith(entities: Array<[string, PayloadFormat]>): EventDocument {
      const d = autoDoc();
      d.channels = [{ key: "mixed", address: "m", protocol: "googlepubsub", serverKeys: [], messageKeys: entities.map(([k]) => k) }];
      d.messages = entities.map(([k]) => ({ key: k, payload: pin(`ent-${k}`), traitKeys: [] }));
      d.operations = [{ key: "publishAll", action: "send", channelKey: "mixed", messageKeys: entities.map(([k]) => k), traitKeys: [] }];
      return d;
    }
    const profileOfMixed = (entities: Array<[string, PayloadFormat]>) => {
      const { resolved } = runPipeline(pubsubWith(entities), { entityFormats: formats(entities.map(([k, f]) => [`ent-${k}`, f])) });
      return resolved.channels[0].profile;
    };

    it("the majority wins", () => {
      expect(profileOfMixed([["A", "avro"], ["B", "protobuf"], ["C", "protobuf"]])).toEqual({ format: "protobuf" });
    });

    it("the first message wins a tie", () => {
      expect(profileOfMixed([["A", "protobuf"], ["B", "avro"]])).toEqual({ format: "protobuf" });
      expect(profileOfMixed([["A", "avro"], ["B", "protobuf"]])).toEqual({ format: "avro" });
    });

    it("every message is still emitted in ITS format, with a per-channel entry where it differs from the channel's", () => {
      const entities: Array<[string, PayloadFormat]> = [["A", "avro"], ["B", "protobuf"], ["C", "protobuf"]];
      const { resolved, document, diagnostics } = runPipeline(pubsubWith(entities), { entityFormats: formats(entities.map(([k, f]) => [`ent-${k}`, f])) });
      expect(resolved.messages.map((m) => [m.id, m.profile])).toEqual([["A", { format: "avro" }], ["B", { format: "protobuf" }], ["C", { format: "protobuf" }]]);
      expect(resolved.channels[0]).not.toHaveProperty("messageProfiles"); // each message's own profile already says it
      expect(at(document, "components", "messages", "A", "payload", "schemaFormat")).toBe(SCHEMA_FORMATS.avro);
      expect(at(document, "components", "messages", "B", "payload", "schemaFormat")).toBe(SCHEMA_FORMATS.protobuf);
      expect(at(document, "components", "messages", "C", "payload", "schemaFormat")).toBe(SCHEMA_FORMATS.protobuf);
      expect(errorsOf(diagnostics)).toEqual([]);
    });
  });

  describe("one message on an explicit Avro channel and an Auto channel", () => {
    function mixedDoc(): EventDocument {
      const d = autoDoc();
      d.channels = [
        { key: "fixed", address: "fixed.v1", protocol: "kafka", serverKeys: [], format: "avro", messageKeys: ["M"] },
        { key: "auto", address: "auto.v1", protocol: "googlepubsub", serverKeys: [], messageKeys: ["M", "N", "O"] },
      ];
      d.messages = ["M", "N", "O"].map((k) => ({ key: k, payload: pin(`ent-${k}`), traitKeys: [] }));
      d.operations = [
        { key: "sendFixed", action: "send", channelKey: "fixed", messageKeys: ["M"], traitKeys: [] },
        { key: "sendAuto", action: "send", channelKey: "auto", messageKeys: ["M", "N", "O"], traitKeys: [] },
      ];
      return d;
    }
    const entityFormats = formats([["ent-M", "json-schema"], ["ent-N", "avro"], ["ent-O", "avro"]]);

    it("keeps the channel's format on the explicit channel and the entity's on the Auto one", () => {
      const { resolved, document, diagnostics } = runPipeline(mixedDoc(), { entityFormats });
      expect(resolved.messages.find((m) => m.id === "M")).not.toHaveProperty("profile"); // its channel decides where one is explicit
      expect(resolved.channels.find((c) => c.id === "auto")?.profile).toEqual({ format: "avro" });
      expect(resolved.channels.find((c) => c.id === "auto")?.messageProfiles).toEqual({ M: { format: "json-schema", dialect: "draft-07" } });
      expect(keys(at(document, "components", "messages"))).toEqual(["M_avro", "M_json", "N", "O"]);
      expect(at(document, "operations", "sendFixed", "messages")).toEqual([{ $ref: "#/channels/fixed/messages/M_avro" }]);
      expect((at(document, "operations", "sendAuto", "messages") as JsonObject[])[0]).toEqual({ $ref: "#/channels/auto/messages/M_json" });
      expect(errorsOf(diagnostics)).toEqual([]);
    });

    it("renders it in both formats", () => {
      expect(planDocumentArtifacts(mixedDoc(), entityFormats).get("M")?.payloadFormats).toEqual(["avro", "json-schema"]);
    });
  });

  it("a JSON Schema message on channels with different dialects gets a per-channel entry for the other dialect", () => {
    const d = autoDoc();
    d.channels = [
      { key: "p1", address: "p1", protocol: "googlepubsub", serverKeys: [], messageKeys: ["M"] },
      { key: "p2", address: "p2", protocol: "googlepubsub", serverKeys: [], formatDialect: "2020-12", messageKeys: ["M"] },
    ];
    d.messages = [{ key: "M", payload: pin("ent-m"), representation: "json-schema", traitKeys: [] }];
    d.operations = [{ key: "send", action: "send", channelKey: "p1", messageKeys: ["M"], traitKeys: [] }];
    const r = resolveDocument(resolveInput(d, { emitAll: true }));
    expect(r.success).toBe(true);
    if (!r.success) return;
    expect(r.data.messages[0].profile).toEqual({ format: "json-schema", dialect: "draft-07" });
    expect(r.data.channels.find((c) => c.id === "p1")).not.toHaveProperty("messageProfiles");
    expect(r.data.channels.find((c) => c.id === "p2")?.messageProfiles).toEqual({ M: { format: "json-schema", dialect: "2020-12" } });
  });
});

describe("existing documents resolve exactly as before", () => {
  const FIXTURES: Array<[string, () => EventDocument]> = [
    ["minimal", slice1Minimal], ["demo-checkout-service", demoCheckoutService], ["demo-fraud-scorer", demoFraudScorer],
    ["demo-returns-service", demoReturnsService], ["kitchen-sink", slice1KitchenSink],
  ];

  it.each(FIXTURES)("%s: no message profile, no per-channel profiles, no message refs, no emitAll marker", (_name, build) => {
    const { resolved } = runPipeline(build());
    for (const m of resolved.messages) expect(m).not.toHaveProperty("profile");
    for (const c of resolved.channels) {
      expect(c).not.toHaveProperty("messageProfiles");
      expect(c).not.toHaveProperty("messageRefs");
    }
    expect(resolved).not.toHaveProperty("emitAll");
  });

  it.each(FIXTURES)("%s: every channel keeps its explicit profile", (_name, build) => {
    const doc = build();
    const { resolved } = runPipeline(doc);
    for (const c of resolved.channels) {
      const authored = channelOf(doc, c.id);
      expect(c.profile).toEqual(authored.formatDialect ? { format: authored.format, dialect: authored.formatDialect } : { format: authored.format });
    }
  });
});

describe("emitAll: everything the user defined is carried and emitted", () => {
  /** autoDoc + a channel nothing operates, a message on it, a message on nothing, an unused message trait and an unused operation trait. */
  function sprawling(): EventDocument {
    const d = autoDoc();
    d.channels.push({ key: "idle", address: "idle.v1", protocol: "kafka", serverKeys: ["kafka"], messageKeys: ["Cancelled"] });
    d.messages.push({ key: "Cancelled", payload: pin("ent-cancelled"), traitKeys: ["Audited"] }, { key: "Orphan", payload: pin("ent-orphan"), traitKeys: [] });
    d.traits.push({ key: "Audited", kind: "MESSAGE", spec: { summary: "Audited" } }, { key: "Retry", kind: "OPERATION", spec: { summary: "Retried" } });
    d.channels[0].messageKeys.push("Cancelled");
    return d;
  }
  const resolve = (doc: EventDocument, overrides: Parameters<typeof resolveInput>[1] = {}) => {
    const r = resolveDocument(resolveInput(doc, overrides));
    if (!r.success) throw new Error(JSON.stringify(r.error.details));
    return r.data;
  };

  it("by default carries only what operations use (unchanged)", () => {
    const r = resolve(sprawling());
    expect(r.channels.map((c) => c.id)).toEqual(["orders", "notices"]);
    expect(r.messages.map((m) => m.id)).toEqual(["OrderCreated", "Notice"]);
    expect(r.traits).toEqual([]);
    expect(r).not.toHaveProperty("emitAll");
  });

  it("carries every local channel — those operations reach first, in first-reference order, then the rest in document order", () => {
    expect(resolve(sprawling(), { emitAll: true }).channels.map((c) => c.id)).toEqual(["orders", "notices", "idle"]);
  });

  it("carries every local message, including the allowed ones no operation uses and the ones no channel carries", () => {
    expect(resolve(sprawling(), { emitAll: true }).messages.map((m) => m.id)).toEqual(["OrderCreated", "Notice", "Cancelled", "Orphan"]);
  });

  it("carries every local trait, used or not", () => {
    const r = resolve(sprawling(), { emitAll: true });
    expect(r.traits.map((t) => [t.id, t.kind])).toEqual([["Audited", "MESSAGE"], ["Retry", "OPERATION"]]);
  });

  it("marks the spec emitAll and gives every channel the messages it allows", () => {
    const r = resolve(sprawling(), { emitAll: true });
    expect(r.emitAll).toBe(true);
    expect(r.channels.map((c) => [c.id, c.messageRefs])).toEqual([["orders", ["OrderCreated", "Cancelled"]], ["notices", ["Notice"]], ["idle", ["Cancelled"]]]);
  });

  it("does not give a channel that allows no message an empty messageRefs", () => {
    const d = sprawling();
    d.channels.push({ key: "empty", address: "e", protocol: "kafka", serverKeys: [], messageKeys: [] });
    expect(resolve(d, { emitAll: true }).channels.find((c) => c.id === "empty")).not.toHaveProperty("messageRefs");
  });

  it("carries channel server references only when emitChannelServers is on as well", () => {
    expect(resolve(sprawling(), { emitAll: true }).channels.find((c) => c.id === "idle")).not.toHaveProperty("serverRefs");
    expect(resolve(sprawling(), { emitAll: true, emitChannelServers: true }).channels.find((c) => c.id === "idle")?.serverRefs).toEqual(["kafka"]);
  });

  it("reports an allowed message that was not rendered at that message", () => {
    const d = sprawling();
    const input = resolveInput(d, { emitAll: true });
    input.artifacts = new Map([...input.artifacts].filter(([k]) => k !== "Orphan"));
    const r = resolveDocument(input);
    expect(r.success).toBe(false);
    if (r.success) return;
    const problems = (r.error.details as { problems: Array<{ pointer: string; message: string }> }).problems;
    expect(problems).toEqual([{ pointer: "/messages/3", message: 'Message "Orphan" has no rendered payload' }]);
  });

  it("an unreferenced message is not required to be rendered without emitAll (unchanged)", () => {
    const d = sprawling();
    const input = resolveInput(d);
    input.artifacts = new Map([...input.artifacts].filter(([k]) => k !== "Orphan" && k !== "Cancelled"));
    expect(resolveDocument(input).success).toBe(true);
  });

  it("reports a channel message key that resolves to nothing, at its pointer", () => {
    const d = sprawling();
    d.channels[2].messageKeys = ["Ghost"];
    const r = resolveDocument(resolveInput(d, { emitAll: true }));
    expect(r.success).toBe(false);
    if (r.success) return;
    expect((r.error.details as { problems: Array<{ pointer: string }> }).problems.map((p) => p.pointer)).toEqual(["/channels/2/messageKeys/0"]);
  });

  it("carries an external message a local channel lists, with its traits", () => {
    const d = sprawling();
    d.externalRefs = [{ key: "ext-msg", eventVersionId: "ev9", kind: "message", itemKey: "Settled" }];
    d.channels[2].messageKeys = ["ext-msg"];
    const external = new Map([["ext-msg", {
      message: { id: "Settled", name: "Settled", productSlug: "pay", traitRefs: ["Ext"], payloads: [artifact("avro", "Settled")] },
      traits: [{ id: "Ext", name: "Ext", kind: "MESSAGE" as const, ownerSlug: "pay", spec: {} }],
    }]]);
    const r = resolve(d, { emitAll: true, external });
    expect(r.messages.map((m) => m.id)).toContain("ext-msg");
    expect(r.traits.map((t) => t.id)).toContain("ev9:Ext");
  });

  it("does not report a library trait that failed to resolve twice (once for the trait, never for emitAll)", () => {
    const d = sprawling();
    d.traits.push({ key: "Gone", kind: "MESSAGE", libraryTraitId: "missing" });
    const r = resolveDocument(resolveInput(d, { emitAll: true }));
    expect(r.success).toBe(false);
    if (r.success) return;
    expect((r.error.details as { problems: unknown[] }).problems).toHaveLength(1);
  });

  it("does not mutate or alias the draft document", () => {
    const d = sprawling();
    const before = JSON.stringify(d);
    const r = resolve(d, { emitAll: true });
    expect(JSON.stringify(d)).toBe(before);
    expect(r.channels[2].messageRefs).not.toBe(d.channels[2].messageKeys);
  });

  describe("emitted", () => {
    const emit = (doc: EventDocument, overrides: Parameters<typeof runPipeline>[1] = {}) => runPipeline(doc, { emitAll: true, emitChannelServers: true, ...overrides });

    it("a channel without an operation appears, with the messages it allows", () => {
      const { document, diagnostics } = emit(sprawling());
      expect(keys(at(document, "channels"))).toEqual(["idle", "notices", "orders"]);
      expect(keys(at(document, "channels", "idle", "messages"))).toEqual(["Cancelled"]);
      expect(at(document, "channels", "idle", "messages", "Cancelled")).toEqual({ $ref: "#/components/messages/Cancelled" });
      expect(diagnostics).toEqual([]);
    });

    it("the messages a channel allows appear next to those operations use", () => {
      const { document } = emit(sprawling());
      expect(keys(at(document, "channels", "orders", "messages"))).toEqual(["Cancelled", "OrderCreated"]);
    });

    it("a message no channel carries appears in components only", () => {
      const { document } = emit(sprawling());
      expect(keys(at(document, "components", "messages"))).toEqual(["Cancelled", "Notice", "OrderCreated", "Orphan"]);
      expect(at(document, "components", "messages", "Orphan", "payload", "schemaFormat")).toBe(SCHEMA_FORMATS.jsonSchemaDraft07);
      expect(JSON.stringify(at(document, "channels"))).not.toContain("Orphan");
    });

    it("an orphan follows its entity's format", () => {
      const { document } = emit(sprawling(), { entityFormats: formats([["ent-orphan", "avro"]]) });
      expect(at(document, "components", "messages", "Orphan", "payload", "schemaFormat")).toBe(SCHEMA_FORMATS.avro);
    });

    it("unused traits appear in components", () => {
      const { document } = emit(sprawling());
      expect(at(document, "components", "messageTraits", "Audited")).toEqual({ summary: "Audited" });
      expect(at(document, "components", "operationTraits", "Retry")).toEqual({ summary: "Retried" });
      expect(at(document, "components", "messages", "Cancelled", "traits")).toEqual([{ $ref: "#/components/messageTraits/Audited" }]);
    });

    it("server references appear on channels", () => {
      const { document } = emit(sprawling());
      expect(at(document, "channels", "idle", "servers")).toEqual([{ $ref: "#/servers/kafka" }]);
      expect(at(document, "channels", "orders", "servers")).toEqual([{ $ref: "#/servers/kafka" }]);
      expect(at(document, "channels", "notices", "servers")).toEqual([{ $ref: "#/servers/pubsub" }]);
    });

    it("an Auto message listed on a Kafka channel gets the Avro Kafka key even without an operation", () => {
      const d = sprawling();
      d.messages.find((m) => m.key === "Cancelled")!.keyPin = pin("ent-cancel-key");
      const { document } = emit(d);
      expect(at(document, "components", "messages", "Cancelled", "bindings", "kafka", "key", "schemaFormat")).toBe(SCHEMA_FORMATS.avro);
    });

    it("passes the structural validator with no errors", () => {
      expect(errorsOf(validateAsyncApi3Structure(emit(sprawling()).document))).toEqual([]);
    });

    it("emits the same bytes whatever the order of the document's lists", () => {
      const a = emit(sprawling()).document;
      const d = sprawling();
      d.channels.reverse(); d.messages.reverse(); d.traits.reverse();
      expect(JSON.stringify(emit(d).document)).toBe(JSON.stringify(a));
    });

    it("without emitAll the same document emits only what operations use (unchanged)", () => {
      const { document } = runPipeline(sprawling());
      expect(keys(at(document, "channels"))).toEqual(["notices", "orders"]);
      expect(keys(at(document, "components", "messages"))).toEqual(["Notice", "OrderCreated"]);
      expect(at(document, "components", "messageTraits")).toBeUndefined();
    });
  });
});

describe("emitAll on the maximal document", () => {
  const maximalWithExtras = (): EventDocument => {
    const d = maximalDocument();
    d.channels.push({ key: "audit", address: "orders.audit.v1", protocol: "kafka", serverKeys: ["kafka-prod"], format: "avro", messageKeys: ["AuditNote"] });
    d.messages.push(
      { key: "AuditNote", title: "Audit note", payload: { entityId: "ent-audit", entityVersionId: "ev-audit" }, traitKeys: ["Unused"] },
      { key: "Draft", representation: "protobuf", payload: { entityId: "ent-draft", entityVersionId: null }, traitKeys: [] },
    );
    d.traits.push({ key: "Unused", kind: "MESSAGE", spec: { summary: "Never used" } }, { key: "UnusedOp", kind: "OPERATION", spec: { summary: "Never used either" } });
    return d;
  };
  const emit = (doc: EventDocument) => {
    const base = resolveInput(doc, { emitAll: true, emitChannelServers: true });
    const { artifacts, localTraitHeaders } = maximalArtifacts();
    for (const [key, value] of base.artifacts) if (!artifacts.has(key)) artifacts.set(key, value);
    const r = resolveDocument({ ...base, artifacts, localTraitHeaders });
    if (!r.success) throw new Error(JSON.stringify(r.error.details));
    return assembleAsyncApi3(r.data);
  };

  it("assembles without a diagnostic and passes the structural validator", () => {
    const { document, diagnostics } = emit(maximalWithExtras());
    expect(diagnostics).toEqual([]);
    expect(errorsOf(validateAsyncApi3Structure(document))).toEqual([]);
  });

  it("passes the real @asyncapi/parser with no errors", async () => {
    const result = await new AsyncApiParserValidator().validate(emit(maximalWithExtras()).document);
    expect(result.success).toBe(true);
    if (!result.success) return;
    const errors: Diagnostic[] = result.data.filter((d) => d.severity === "error");
    expect(errors).toEqual([]);
  }, 60_000);

  it("contains the channel, the messages and the traits that no operation reaches", () => {
    const { document } = emit(maximalWithExtras());
    expect(keys(at(document, "channels"))).toContain("audit");
    expect(at(document, "channels", "audit", "messages", "AuditNote")).toEqual({ $ref: "#/components/messages/AuditNote" });
    expect(keys(at(document, "components", "messages"))).toEqual(expect.arrayContaining(["AuditNote", "Draft", "OrderCreated", "OrderSummary_avro", "OrderSummary_json"]));
    expect(keys(at(document, "components", "messageTraits"))).toEqual(expect.arrayContaining(["Envelope", "Unused"]));
    expect(keys(at(document, "components", "operationTraits"))).toEqual(expect.arrayContaining(["Audited", "UnusedOp"]));
    expect(at(document, "components", "messages", "Draft", "payload", "schemaFormat")).toBe(SCHEMA_FORMATS.protobuf);
  });

  it("when every item is already reachable, emitAll adds nothing to the maximal document", () => {
    const plain = runPipeline(maximalDocument(), { ...maximalArtifacts(), emitChannelServers: true });
    const all = runPipeline(maximalDocument(), { ...maximalArtifacts(), emitChannelServers: true, emitAll: true });
    expect(JSON.stringify(all.document)).toBe(JSON.stringify(plain.document));
    expect(artifactsFor(maximalDocument(), undefined, { emitAll: true }).size).toBe(2);
  });
});
