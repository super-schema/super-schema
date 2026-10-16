import { describe, expect, it } from "vitest";
import { parse as parseYaml } from "yaml";
import { toJson, toYaml } from "@/lib/event-specs/serialize";
import type { JsonObject } from "@/lib/event-specs/types";
import { validateAsyncApi3Structure } from "@/lib/event-specs/validator";
import { AsyncApiParserValidator } from "@/lib/event-specs/validation/asyncapi-parser-validator";
import { BUNDLED_TRAITS } from "@/lib/events/bundled-traits";
import { emptyEventDocument, type EventDocument } from "@/lib/events/document/types";
import type { FrozenTrait } from "@/lib/events/types";
import { artifact, runPipeline } from "./fixtures/compat-pipeline";

/**
 * A library trait whose message properties are INLINE (`spec.headers`, no entity pin) is emitted from the stored spec: the real
 * CloudEvents 1.0 and W3C Trace Context definitions go through resolve -> assemble -> both validators with no error, and the traits
 * that pin a headers entity (the demo's old `CloudEvents` library trait) keep emitting their rendered artifact.
 */
const def = (name: string) => {
  const found = BUNDLED_TRAITS.find((t) => t.name === name);
  if (!found) throw new Error(`no bundled trait ${name}`);
  return found;
};

/** What `event-snapshot` loads for a stored bundled trait (the row's `spec` comes back from the database as plain JSON). */
const frozen = (id: string, name: string, spec: JsonObject, over: Partial<FrozenTrait> = {}): FrozenTrait => ({
  id, name, kind: "MESSAGE", ownerSlug: "acme", spec: structuredClone(spec), headersEntityId: null, headersEntityVersionId: null, ...over,
});
const builtIns = () => new Map<string, FrozenTrait>([
  ["lib-ce", frozen("lib-ce", "CloudEvents", def("CloudEvents").spec)],
  ["lib-tc", frozen("lib-tc", "TraceContext", def("TraceContext").spec)],
]);

function document(traits: EventDocument["traits"], messageTraitKeys: string[]): EventDocument {
  return {
    ...emptyEventDocument("checkout-service"),
    servers: [{ key: "kafka-prod", protocol: "kafka", host: "kafka-prod.internal:9092" }],
    channels: [{ key: "orders", address: "payments.orders.v1", protocol: "kafka", serverKeys: ["kafka-prod"], format: "avro", messageKeys: ["OrderCreated"] }],
    messages: [{ key: "OrderCreated", payload: { entityId: "ent-order", entityVersionId: "ev-order" }, keyPin: { entityId: "ent-key", entityVersionId: "ev-key" }, traitKeys: messageTraitKeys }],
    traits,
    operations: [{ key: "publishOrderCreated", action: "send", channelKey: "orders", messageKeys: ["OrderCreated"], traitKeys: [] }],
  };
}
const withBuiltIns = () => document(
  [{ key: "CloudEvents", kind: "MESSAGE", libraryTraitId: "lib-ce" }, { key: "Trace", kind: "MESSAGE", libraryTraitId: "lib-tc" }],
  ["CloudEvents", "Trace"],
);

const messageTraits = (doc: JsonObject) => ((doc.components as JsonObject).messageTraits ?? {}) as Record<string, JsonObject>;
const errorsOf = <T extends { severity: string }>(list: T[]) => list.filter((d) => d.severity === "error");

describe("a library trait with inline headers, through resolve -> assemble", () => {
  const out = runPipeline(withBuiltIns(), { libraryTraits: builtIns(), libraryTraitHeaders: new Map() });

  it("emits the CloudEvents headers from the stored spec, exactly as defined", () => {
    const ce = messageTraits(out.document).CloudEvents;
    expect(ce.headers).toEqual(def("CloudEvents").spec.headers);
    expect(ce.summary).toBe(def("CloudEvents").spec.summary);
    expect(ce.description).toBe(def("CloudEvents").spec.description);
    expect((ce.headers as JsonObject).required).toEqual(["specversion", "id", "source", "type"]);
    const properties = (ce.headers as { properties: Record<string, JsonObject> }).properties;
    expect(Object.keys(properties).sort()).toEqual(["datacontenttype", "dataschema", "id", "source", "specversion", "subject", "time", "type"]);
    expect(properties.specversion).toMatchObject({ type: "string", const: "1.0" });
    expect(properties.source).toMatchObject({ format: "uri-reference" });
  });

  it("emits the Trace Context headers too, and the message points at both traits", () => {
    expect(messageTraits(out.document).TraceContext.headers).toEqual(def("TraceContext").spec.headers);
    const messages = (out.document.components as JsonObject).messages as Record<string, JsonObject>;
    expect(messages.OrderCreated.traits).toEqual([
      { $ref: "#/components/messageTraits/CloudEvents" },
      { $ref: "#/components/messageTraits/TraceContext" },
    ]);
  });

  it("carries the built-in marker through as an x- specification extension (valid AsyncAPI) and nothing else extra", () => {
    const ce = messageTraits(out.document).CloudEvents;
    expect(ce["x-bundled"]).toBe("cloudevents@1.0");
    expect(Object.keys(ce).sort()).toEqual(["description", "headers", "summary", "x-bundled"]);
  });

  it("assembles without a diagnostic of any severity", () => {
    expect(out.diagnostics).toEqual([]);
  });

  it("passes the structural validator with 0 errors", () => {
    expect(errorsOf(validateAsyncApi3Structure(out.document))).toEqual([]);
  });

  it("passes the real @asyncapi/parser validator with 0 errors", async () => {
    const result = await new AsyncApiParserValidator().validate(out.document);
    expect(result.success).toBe(true);
    if (result.success) expect(errorsOf(result.data)).toEqual([]);
  }, 30_000);

  it("serialises to YAML and JSON that read back to the same document, with the properties visible", () => {
    const yaml = toYaml(out.document);
    expect(yaml).toContain("specversion:");
    expect(yaml).toMatch(/const: ['"]1\.0['"]/);
    expect(yaml).toContain("traceparent:");
    expect(parseYaml(yaml)).toEqual(JSON.parse(toJson(out.document)));
    expect(messageTraits(parseYaml(yaml) as JsonObject).CloudEvents.headers).toEqual(def("CloudEvents").spec.headers);
  });

  it("is the same document when the stored properties come back in another key order (a database round trip re-sorts keys)", () => {
    const shuffled = structuredClone(def("CloudEvents").spec) as { headers: { properties: Record<string, JsonObject> } };
    shuffled.headers.properties = Object.fromEntries(Object.entries(shuffled.headers.properties).reverse());
    const libraryTraits = builtIns();
    libraryTraits.set("lib-ce", frozen("lib-ce", "CloudEvents", shuffled as unknown as JsonObject));
    const again = runPipeline(withBuiltIns(), { libraryTraits, libraryTraitHeaders: new Map() });
    expect(messageTraits(again.document).CloudEvents.headers).toEqual(def("CloudEvents").spec.headers);
    expect(again.diagnostics).toEqual([]);
  });

  it("does not leak the definition into the document it was resolved for: the resolved spec is a copy", () => {
    const spec = def("CloudEvents").spec;
    const resolvedTrait = out.resolved.traits.find((t) => t.name === "CloudEvents");
    expect(resolvedTrait?.spec).toEqual(spec);
    expect(resolvedTrait?.spec).not.toBe(spec);
    expect(Object.isFrozen(resolvedTrait?.spec)).toBe(false);
  });
});

describe("traits that pin a headers entity keep working (the demo's old CloudEvents library trait)", () => {
  const pinned = () => new Map<string, FrozenTrait>([
    ["lib-ce", frozen("lib-ce", "CloudEvents", { summary: "CloudEvents envelope headers" }, { headersEntityId: "ent-ce-headers", headersEntityVersionId: "ev-ce-headers" })],
  ]);
  const doc = () => document([{ key: "CloudEvents", kind: "MESSAGE", libraryTraitId: "lib-ce" }], ["CloudEvents"]);

  it("emits the rendered headers artifact, with the trait's own summary", () => {
    const run = runPipeline(doc(), { libraryTraits: pinned(), libraryTraitHeaders: new Map([["lib-ce", artifact("json-schema", "CloudEventsHeaders")]]) });
    const ce = messageTraits(run.document).CloudEvents;
    expect(ce.summary).toBe("CloudEvents envelope headers");
    expect(ce.headers).toMatchObject({ title: "CloudEventsHeaders", type: "object", properties: { id: { type: "string" } } });
    expect(ce).not.toHaveProperty("x-bundled");
    expect(errorsOf(run.diagnostics)).toEqual([]);
    expect(errorsOf(validateAsyncApi3Structure(run.document))).toEqual([]);
  });

  it("the headers artifact wins over an inline spec.headers on the same trait", () => {
    const both = new Map<string, FrozenTrait>([
      ["lib-ce", frozen("lib-ce", "CloudEvents", { summary: "both", headers: { type: "object", properties: { inline: { type: "string" } } } }, { headersEntityId: "ent-ce-headers", headersEntityVersionId: "ev-ce-headers" })],
    ]);
    const run = runPipeline(doc(), { libraryTraits: both, libraryTraitHeaders: new Map([["lib-ce", artifact("json-schema", "CloudEventsHeaders")]]) });
    const headers = messageTraits(run.document).CloudEvents.headers as { properties: Record<string, unknown> };
    expect(Object.keys(headers.properties)).toEqual(["id"]);
    expect(headers.properties).not.toHaveProperty("inline");
  });

  it("a pinned trait whose artifact is missing still emits its spec (no headers), and a plain trait with neither emits just its spec", () => {
    const run = runPipeline(doc(), { libraryTraits: pinned(), libraryTraitHeaders: new Map() });
    expect(messageTraits(run.document).CloudEvents).toEqual({ summary: "CloudEvents envelope headers" });
  });
});

describe("a custom library trait with inline headers", () => {
  it("is emitted like the built-ins: the properties come from its stored spec, with 0 errors", async () => {
    const spec: JsonObject = { summary: "Tenant routing", headers: { type: "object", required: ["tenant"], properties: { tenant: { type: "string", description: "Owning tenant" }, retries: { type: "integer", minimum: 0 } } } };
    const run = runPipeline(
      document([{ key: "Tenant", kind: "MESSAGE", libraryTraitId: "lib-t" }], ["Tenant"]),
      { libraryTraits: new Map([["lib-t", frozen("lib-t", "TenantRouting", spec)]]), libraryTraitHeaders: new Map() },
    );
    expect(messageTraits(run.document).TenantRouting.headers).toEqual(spec.headers);
    expect(errorsOf(run.diagnostics)).toEqual([]);
    expect(errorsOf(validateAsyncApi3Structure(run.document))).toEqual([]);
    const parsed = await new AsyncApiParserValidator().validate(run.document);
    expect(parsed.success && errorsOf(parsed.data)).toEqual([]);
  }, 30_000);
});
