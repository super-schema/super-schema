import { describe, expect, it } from "vitest";
import { buildOutline } from "@/features/events/builder/outline";
import { BUILDER_SECTIONS } from "@/features/events/builder/sections";
import { parseEventDocument } from "@/lib/events/document/parse";
import { emptyEventDocument, type DocumentProblem, type EventDocument } from "@/lib/events/document/types";

const pin = { entityId: "e1", entityVersionId: "v1" };

/** One server, two broken channels (no protocol; an address expression with no parameter), two messages, one operation. */
function brokenDoc(): EventDocument {
  return {
    ...emptyEventDocument("Orders"),
    servers: [{ key: "kafka-prod", protocol: "kafka", host: "h:9092" }],
    channels: [
      { key: "orders", address: "orders", protocol: "", serverKeys: [], format: "avro", messageKeys: ["OrderCreated"] },
      { key: "tenant", address: "t.{tenantId}", protocol: "kafka", serverKeys: [], format: "avro", messageKeys: [] },
    ],
    messages: [
      { key: "OrderCreated", payload: pin, traitKeys: [] },
      { key: "OrderCancelled", payload: pin, traitKeys: [] },
    ],
    operations: [{ key: "publishOrder", action: "send", channelKey: "orders", messageKeys: ["OrderCreated"], traitKeys: [] }],
  };
}

function problemsOf(doc: EventDocument): DocumentProblem[] {
  const result = parseEventDocument(doc);
  if (result.success) return [];
  return (result.error.details as { problems: DocumentProblem[] }).problems;
}

describe("buildOutline", () => {
  it("returns one node per builder section, in order, with the display labels", () => {
    const outline = buildOutline(emptyEventDocument("Orders"), []);
    expect(outline.map((n) => n.section)).toEqual([...BUILDER_SECTIONS]);
    expect(outline.map((n) => n.label)).toEqual(["Metadata", "Servers", "Channels", "Messages", "Operations", "Traits", "Advanced"]);
  });

  it("has seven sections", () => {
    expect([...BUILDER_SECTIONS]).toEqual(["metadata", "servers", "channels", "messages", "operations", "traits", "advanced"]);
    expect(buildOutline(emptyEventDocument("Orders"), [])).toHaveLength(7);
  });

  it("counts the items of list sections and gives Metadata a null count", () => {
    const outline = buildOutline(brokenDoc(), []);
    expect(outline.map((n) => n.count)).toEqual([null, 1, 2, 2, 1, 0, 0]);
  });

  it("counts traits (local and library alike) and security schemes", () => {
    const doc = brokenDoc();
    doc.traits = [
      { key: "idempotent", kind: "MESSAGE", spec: {} },
      { key: "audited", kind: "OPERATION", libraryTraitId: "lib-1" },
      { key: "retry", kind: "OPERATION", spec: {} },
    ];
    doc.components = { securitySchemes: { "api-key": { type: "httpApiKey", name: "X-Key", in: "header" }, basic: { type: "http", scheme: "basic" } } };
    const outline = buildOutline(doc, []);
    expect(outline.find((n) => n.section === "traits")?.count).toBe(3);
    expect(outline.find((n) => n.section === "advanced")?.count).toBe(2);
    expect(outline.find((n) => n.section === "traits")?.items.map((i) => i.key)).toEqual(["idempotent", "audited", "retry"]);
    expect(outline.find((n) => n.section === "advanced")?.items.map((i) => i.key)).toEqual(["api-key", "basic"]);
  });

  it("Advanced counts zero for a document with components but no security schemes", () => {
    const doc = brokenDoc();
    doc.components = { parameters: { id: {} } };
    expect(buildOutline(doc, []).find((n) => n.section === "advanced")?.count).toBe(0);
  });

  it("an empty document has zero items, zero problems and no outline items", () => {
    const outline = buildOutline(emptyEventDocument("Orders"), []);
    expect(outline.map((n) => n.count)).toEqual([null, 0, 0, 0, 0, 0, 0]);
    expect(outline.every((n) => n.problems === 0 && n.items.length === 0)).toBe(true);
  });

  it("counts problems per section from the real parser output of a document with two broken channels", () => {
    const doc = brokenDoc();
    const problems = problemsOf(doc);
    expect(problems.map((p) => p.pointer).sort()).toEqual(["/channels/0/protocol", "/channels/1/parameters"]);
    const outline = buildOutline(doc, problems);
    expect(outline.map((n) => n.problems)).toEqual([0, 0, 2, 0, 0, 0, 0]);
  });

  it("items carry the key (as label too) and the problem count of each item", () => {
    const doc = brokenDoc();
    const channels = buildOutline(doc, problemsOf(doc)).find((n) => n.section === "channels");
    expect(channels?.items).toEqual([
      { key: "orders", label: "orders", problems: 1 },
      { key: "tenant", label: "tenant", problems: 1 },
    ]);
    const servers = buildOutline(doc, problemsOf(doc)).find((n) => n.section === "servers");
    expect(servers?.items).toEqual([{ key: "kafka-prod", label: "kafka-prod", problems: 0 }]);
    const operations = buildOutline(doc, []).find((n) => n.section === "operations");
    expect(operations?.items).toEqual([{ key: "publishOrder", label: "publishOrder", problems: 0 }]);
  });

  it("locates metadata, server, message and operation problems in their own sections", () => {
    const doc = brokenDoc();
    const outline = buildOutline(doc, [
      { pointer: "/info/title", message: "title is required" },
      { pointer: "/defaultContentType", message: "x" },
      { pointer: "/servers/0/host", message: "host is required" },
      { pointer: "/messages/1/payload/entityId", message: "entityId is required" },
      { pointer: "/operations/0/messageKeys/0", message: "Unknown message" },
    ]);
    expect(Object.fromEntries(outline.map((n) => [n.section, n.problems]))).toEqual({
      metadata: 2, servers: 1, channels: 0, messages: 1, operations: 1, traits: 0, advanced: 0,
    });
    expect(outline.find((n) => n.section === "messages")?.items.map((i) => i.problems)).toEqual([0, 1]);
  });

  it("counts a problem on a duplicate-key item by position, not by key", () => {
    const doc = brokenDoc();
    doc.servers.push({ key: "kafka-prod", protocol: "kafka", host: "h2:9092" });
    const servers = buildOutline(doc, [{ pointer: "/servers/1/host", message: "bad" }]).find((n) => n.section === "servers");
    expect(servers?.items.map((i) => i.problems)).toEqual([0, 1]);
  });

  it("counts identical problems once (client and server lists are concatenated by callers)", () => {
    const doc = brokenDoc();
    const one = { pointer: "/servers/0/host", message: "host is required" };
    const outline = buildOutline(doc, [one, { ...one }]);
    expect(outline.find((n) => n.section === "servers")?.problems).toBe(1);
  });

  it("counts trait problems on Traits, per item by position", () => {
    const doc = brokenDoc();
    doc.traits = [{ key: "a", kind: "MESSAGE", spec: {} }, { key: "b", kind: "OPERATION", spec: {} }];
    const outline = buildOutline(doc, [
      { pointer: "/traits/1/spec/title", message: "bad" },
      { pointer: "/traits/1/spec/summary", message: "bad too" },
      { pointer: "/traits/0/kind", message: "kind must be one of MESSAGE, OPERATION" },
    ]);
    const traits = outline.find((n) => n.section === "traits");
    expect(traits?.problems).toBe(3);
    expect(traits?.items).toEqual([{ key: "a", label: "a", problems: 1 }, { key: "b", label: "b", problems: 2 }]);
  });

  it("counts security scheme problems and /components problems on Advanced, per scheme by name", () => {
    const doc = brokenDoc();
    doc.components = { securitySchemes: { "api-key": { type: "httpApiKey", in: "header" }, basic: { type: "http", scheme: "basic" } } };
    const outline = buildOutline(doc, [
      { pointer: "/components/securitySchemes/api-key/name", message: "name is required" },
      { pointer: "/components/securitySchemes/api-key", message: "x" },
      { pointer: "/components", message: "components must be an object" },
      { pointer: "/servers/0/security/0", message: "Unknown security scheme" },
    ]);
    const advanced = outline.find((n) => n.section === "advanced");
    expect(advanced?.problems).toBe(3);
    expect(advanced?.items).toEqual([{ key: "api-key", label: "api-key", problems: 2 }, { key: "basic", label: "basic", problems: 0 }]);
    expect(outline.find((n) => n.section === "servers")?.problems).toBe(1);
  });

  it("does not take an inherited property for a security scheme", () => {
    const doc = brokenDoc();
    doc.components = { securitySchemes: { basic: { type: "http", scheme: "basic" } } };
    const advanced = buildOutline(doc, [{ pointer: "/components/securitySchemes/constructor/type", message: "x" }]).find((n) => n.section === "advanced");
    expect(advanced?.problems).toBe(1);
    expect(advanced?.items).toEqual([{ key: "basic", label: "basic", problems: 0 }]);
  });

  it("does not count problems that belong to no section (document-level)", () => {
    const outline = buildOutline(brokenDoc(), [
      { pointer: "", message: "Document must be an object" },
      { pointer: "/externalRefs/0/kind", message: "kind must be one of channel, message" },
      { pointer: "/documentVersion", message: "documentVersion must be 2" },
    ]);
    expect(outline.every((n) => n.problems === 0)).toBe(true);
  });
});
