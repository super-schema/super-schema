import { describe, expect, it } from "vitest";
import { validateAsyncApi3Structure } from "@/lib/event-specs/validator";
import type { Diagnostic, JsonObject } from "@/lib/event-specs/types";
import { BUNDLED_TRAITS } from "@/lib/events/bundled-traits";
import {
  buildInstantAsyncApi, instantLibraryTraits, PLACEHOLDER_LIBRARY_TRAIT_KEY, type InstantLibraryTrait,
} from "@/lib/events/document/instant-asyncapi";
import { emptyEventDocument, type EventDocument } from "@/lib/events/document/types";

/**
 * The instant (browser-side) code uses the real definition of a library / built-in trait when it is given one, so the Code panel
 * shows the true CloudEvents properties right away instead of a stub; without one it keeps the stub it always had.
 */
const pin = (entityId: string, entityVersionId: string | null) => ({ entityId, entityVersionId });
const OPTS = { productSlug: "checkout", entityLabels: new Map([["ent-order", "Order"]]), versionLabels: new Map([["ver-order", "1.0"]]) };

const spec = (name: string) => BUNDLED_TRAITS.find((t) => t.name === name)!.spec;

function document(): EventDocument {
  return {
    ...emptyEventDocument("checkout-service"),
    servers: [{ key: "kafka-prod", protocol: "kafka", host: "kafka-prod.internal:9092" }],
    channels: [{ key: "orders", address: "payments.orders.v1", protocol: "kafka", serverKeys: ["kafka-prod"], format: "avro", messageKeys: ["OrderCreated"] }],
    messages: [{ key: "OrderCreated", payload: pin("ent-order", "ver-order"), traitKeys: ["CloudEvents", "Trace"] }],
    traits: [
      { key: "CloudEvents", kind: "MESSAGE", libraryTraitId: "lib-ce" },
      { key: "Trace", kind: "MESSAGE", libraryTraitId: "lib-tc" },
      { key: "Audited", kind: "OPERATION", libraryTraitId: "lib-audited" },
    ],
    operations: [{ key: "publishOrderCreated", action: "send", channelKey: "orders", messageKeys: ["OrderCreated"], traitKeys: ["Audited"] }],
  };
}

const LIBRARY = new Map<string, InstantLibraryTrait>([
  ["lib-ce", { name: "CloudEvents", kind: "MESSAGE", spec: spec("CloudEvents") }],
  ["lib-tc", { name: "TraceContext", kind: "MESSAGE", spec: spec("TraceContext") }],
  ["lib-audited", { name: "Audited", kind: "OPERATION", spec: { summary: "Operation is audited", tags: [{ name: "audited" }] } }],
]);

const errorsOf = (list: Diagnostic[]) => list.filter((d) => d.severity === "error");
const components = (doc: JsonObject | null) => (doc?.components ?? {}) as Record<string, Record<string, JsonObject>>;

describe("buildInstantAsyncApi: library traits with their real definition", () => {
  const out = buildInstantAsyncApi(document(), { ...OPTS, libraryTraits: LIBRARY });

  it("emits the real CloudEvents and Trace Context properties, not a stub", () => {
    const traits = components(out.document).messageTraits;
    expect(traits.CloudEvents.headers).toEqual(spec("CloudEvents").headers);
    expect(traits.TraceContext.headers).toEqual(spec("TraceContext").headers);
    expect(traits.CloudEvents.summary).toBe(spec("CloudEvents").summary);
    expect(JSON.stringify(out.document)).not.toContain(PLACEHOLDER_LIBRARY_TRAIT_KEY);
    expect(out.yaml).toContain("specversion:");
    expect(out.yaml).toContain("traceparent:");
  });

  it("names each trait component by the library trait's name, as the server render does (not by the document key)", () => {
    const d = document();
    d.traits[0] = { key: "ce", kind: "MESSAGE", libraryTraitId: "lib-ce" };
    d.messages[0] = { ...d.messages[0], traitKeys: ["ce", "Trace"] };
    const r = buildInstantAsyncApi(d, { ...OPTS, libraryTraits: LIBRARY });
    expect(Object.keys(components(r.document).messageTraits).sort()).toEqual(["CloudEvents", "TraceContext"]);
    expect(errorsOf(r.diagnostics)).toEqual([]);
  });

  it("points the message at both traits and carries an operation library trait's spec too", () => {
    const messages = components(out.document).messages;
    expect(messages.OrderCreated.traits).toEqual([{ $ref: "#/components/messageTraits/CloudEvents" }, { $ref: "#/components/messageTraits/TraceContext" }]);
    expect(components(out.document).operationTraits.Audited).toMatchObject({ summary: "Operation is audited", tags: [{ name: "audited" }] });
  });

  it("is a valid document: no error diagnostic and the structural validator agrees", () => {
    expect(errorsOf(out.diagnostics)).toEqual([]);
    expect(errorsOf(validateAsyncApi3Structure(out.document as JsonObject))).toEqual([]);
  });

  it("copies the definition: the (frozen) built-in spec is never shared with the emitted document", () => {
    const traits = components(out.document).messageTraits;
    expect(traits.CloudEvents).not.toBe(spec("CloudEvents"));
    expect(Object.isFrozen(traits.CloudEvents)).toBe(false);
    expect(Object.isFrozen(spec("CloudEvents"))).toBe(true); // and it is still untouched
  });

  it("is deterministic and does not mutate the options it was given", () => {
    const again = buildInstantAsyncApi(document(), { ...OPTS, libraryTraits: LIBRARY });
    expect(again.yaml).toBe(out.yaml);
    expect(LIBRARY.get("lib-ce")?.spec).toBe(spec("CloudEvents"));
  });
});

describe("buildInstantAsyncApi: without the library definitions", () => {
  const stubbed = buildInstantAsyncApi(document(), OPTS);

  it("keeps the stub that carries the trait's key (the server render replaces it)", () => {
    const traits = components(stubbed.document).messageTraits;
    expect(traits.CloudEvents).toEqual({ [PLACEHOLDER_LIBRARY_TRAIT_KEY]: "CloudEvents" });
    expect(traits.Trace).toEqual({ [PLACEHOLDER_LIBRARY_TRAIT_KEY]: "Trace" });
    expect(errorsOf(stubbed.diagnostics)).toEqual([]);
  });

  it("an empty map is the same as none", () => {
    expect(buildInstantAsyncApi(document(), { ...OPTS, libraryTraits: new Map() }).yaml).toBe(stubbed.yaml);
  });

  it("a trait the map does not know stays a stub while the known ones are real", () => {
    const partial = new Map([["lib-ce", LIBRARY.get("lib-ce")!]]);
    const r = buildInstantAsyncApi(document(), { ...OPTS, libraryTraits: partial });
    const traits = components(r.document).messageTraits;
    expect(traits.CloudEvents.headers).toEqual(spec("CloudEvents").headers);
    expect(traits.Trace).toEqual({ [PLACEHOLDER_LIBRARY_TRAIT_KEY]: "Trace" });
  });

  it("a definition of the wrong kind is reported like the server does, instead of being used", () => {
    const wrong = new Map(LIBRARY);
    wrong.set("lib-ce", { name: "CloudEvents", kind: "OPERATION", spec: spec("CloudEvents") });
    const r = buildInstantAsyncApi(document(), { ...OPTS, libraryTraits: wrong });
    expect(r.document).toBeNull();
    const text = errorsOf(r.diagnostics).map((d) => d.message).join("\n");
    expect(text).toMatch(/Library "lib-ce" is a set of operation properties, but "[^"]+" is declared as a set of message properties/);
    expect(text).not.toMatch(/\btraits?\b/i);
  });
});

describe("instantLibraryTraits", () => {
  it("turns the builder's library options into the map the instant build takes, keeping only those that carry a spec", () => {
    const map = instantLibraryTraits([
      { id: "lib-ce", name: "CloudEvents", kind: "MESSAGE", spec: spec("CloudEvents") },
      { id: "lib-old", name: "Old", kind: "MESSAGE" },
      { id: "lib-audited", name: "Audited", kind: "OPERATION", spec: { summary: "x" } },
    ]);
    expect([...map.keys()]).toEqual(["lib-ce", "lib-audited"]);
    expect(map.get("lib-ce")).toEqual({ name: "CloudEvents", kind: "MESSAGE", spec: spec("CloudEvents") });
    expect(instantLibraryTraits([]).size).toBe(0);
  });
});
