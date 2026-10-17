// tests/unit/features/events/builder/references.test.ts
// The reference context the template forms read: every `refersTo` target the catalog uses must have an options list.
import { describe, expect, it } from "vitest";
import { buildReferenceContext } from "@/features/events/builder/references";
import { EXTERNAL_SUFFIX, externalItemLabel } from "@/features/events/builder/labels";
import { TEMPLATES, bindingTemplate, BINDING_PROTOCOLS, type FieldTemplate } from "@/lib/events/templates";
import { emptyEventDocument } from "@/lib/events/document/types";
import { maximalDocument } from "../../../lib/events/document/fixtures/maximal-document";

const ENTITY_OPTIONS = [{ id: "ent-1", name: "Order", ownerLabel: "Payments", latestVersionId: "v1", latestVersionLabel: "v1.0" }];

/** Every `refersTo` anywhere in `fields`, nested objects and list items included. */
function collectTargets(fields: FieldTemplate[], into = new Set<string>()): Set<string> {
  for (const f of fields) {
    if (f.refersTo) into.add(f.refersTo);
    if (f.fields) collectTargets(f.fields, into);
  }
  return into;
}

const allTargets = (): Set<string> => {
  const targets = new Set<string>();
  for (const template of Object.values(TEMPLATES)) collectTargets(template.fields, targets);
  for (const protocol of BINDING_PROTOCOLS) {
    for (const target of ["server", "channel", "operation", "message"] as const) {
      const t = bindingTemplate(protocol, target);
      if (t) collectTargets(t.fields, targets);
    }
  }
  return targets;
};

const values = (options: Array<{ value: string }> | undefined) => (options ?? []).map((o) => o.value);
const labels = (options: Array<{ label: string }> | undefined) => (options ?? []).map((o) => o.label);

describe("buildReferenceContext: coverage of the catalog", () => {
  it("the catalog really refers to every kind of part (guards the test below against an empty set)", () => {
    expect([...allTargets()].sort()).toEqual(["channel", "message", "messageTrait", "operationTrait", "securityScheme", "server"]);
  });

  it("has an entry for every `refersTo` of every template, built from a maximal document", () => {
    const context = buildReferenceContext(maximalDocument(), { entityOptions: ENTITY_OPTIONS });
    for (const target of allTargets()) {
      expect(context.references?.[target], `references.${target}`).toBeDefined();
      expect(context.references?.[target].length, `references.${target} is empty`).toBeGreaterThan(0);
    }
  });

  it("also offers the operations of the document", () => {
    const context = buildReferenceContext(maximalDocument(), { entityOptions: [] });
    expect(values(context.references?.operation)).toEqual(["createOrder", "receiveOrderCreated"]);
  });

  it("has an (empty) entry for every target even when the document has nothing yet, so a form can say 'none defined yet'", () => {
    const context = buildReferenceContext(emptyEventDocument("Orders"), { entityOptions: [] });
    for (const target of [...allTargets(), "operation"]) expect(context.references?.[target], target).toEqual([]);
  });

  it("passes the entity options and the version loader through", () => {
    const loadVersions = async () => [];
    const context = buildReferenceContext(emptyEventDocument("Orders"), { entityOptions: ENTITY_OPTIONS, loadVersions });
    expect(context.entityOptions).toBe(ENTITY_OPTIONS);
    expect(context.loadVersions).toBe(loadVersions);
  });
});

describe("buildReferenceContext: the options of each target", () => {
  const context = buildReferenceContext(maximalDocument(), { entityOptions: [] });
  const refs = context.references!;

  it("server: the key is the value, the label is the title, else the host", () => {
    expect(values(refs.server)).toEqual(["kafka-prod", "kafka-stage"]);
    expect(labels(refs.server)).toEqual(["Kafka (production)", "kafka-stage.example.com:9092"]);
  });

  it("server: falls back to the key when it has neither title nor host", () => {
    const doc = emptyEventDocument("x");
    doc.servers = [{ key: "server", protocol: "kafka", host: "" }];
    expect(labels(buildReferenceContext(doc, { entityOptions: [] }).references?.server)).toEqual(["server"]);
  });

  it("securityScheme: exactly the keys of components.securitySchemes", () => {
    const keys = Object.keys(maximalDocument().components?.securitySchemes ?? {});
    expect(keys.length).toBeGreaterThan(10);
    expect(values(refs.securityScheme)).toEqual(keys);
    expect(labels(refs.securityScheme)).toEqual(keys);
  });

  it("securityScheme: empty when the document defines none", () => {
    const doc = maximalDocument();
    delete doc.components;
    expect(buildReferenceContext(doc, { entityOptions: [] }).references?.securityScheme).toEqual([]);
  });

  it("messageTrait / operationTrait: split by the kind of the trait", () => {
    expect(values(refs.messageTrait)).toEqual(["Envelope"]);
    expect(values(refs.operationTrait)).toEqual(["Audited"]);
  });

  it("traits from the library are marked '(library)'", () => {
    const doc = maximalDocument();
    doc.traits.push({ key: "Shared", kind: "OPERATION", libraryTraitId: "lib-1" });
    const next = buildReferenceContext(doc, { entityOptions: [] }).references!;
    expect(labels(next.operationTrait)).toEqual(["Audited", "Shared (library)"]);
    expect(values(next.operationTrait)).toEqual(["Audited", "Shared"]);
  });

  it("channel and message: the local ones, then the external references of that kind", () => {
    const doc = maximalDocument();
    doc.externalRefs = [
      { key: "remote-orders", eventVersionId: "v1", kind: "channel", itemKey: "orders" },
      { key: "remote-summary", eventVersionId: "v1", kind: "message", itemKey: "OrderSummary" },
    ];
    const next = buildReferenceContext(doc, { entityOptions: [] }).references!;
    expect(values(next.channel)).toEqual(["orders", "replies", "remote-orders"]);
    expect(labels(next.channel)).toEqual(["orders", "replies", "remote-orders (external)"]);
    expect(values(next.message)).toEqual(["OrderCreated", "OrderSummary", "remote-summary"]);
    expect(labels(next.message)).toEqual(["OrderCreated", "OrderSummary", "remote-summary (external)"]);
  });

  it("marks an external reference with the very label the pick lists use: one suffix, defined once in labels", () => {
    const doc = emptyEventDocument("svc");
    doc.externalRefs = [{ key: "remote-orders", eventVersionId: "v1", kind: "channel", itemKey: "orders" }];
    const next = buildReferenceContext(doc, { entityOptions: [] }).references!;
    expect(labels(next.channel)).toEqual([externalItemLabel("remote-orders")]);
    expect(externalItemLabel("remote-orders")).toBe(`remote-orders ${EXTERNAL_SUFFIX}`);
    expect(EXTERNAL_SUFFIX).toBe("(external)");
  });
});
