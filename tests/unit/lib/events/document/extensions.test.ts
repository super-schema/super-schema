// Metadata attributes on event channels, messages and operations: the document model's `extensions` map.
import { describe, expect, it } from "vitest";
import { classifyEventBump, type EventBumpSide } from "@/lib/events/document/bump";
import { parseEventDocument } from "@/lib/events/document/parse";
import { resolveDocument } from "@/lib/events/document/resolve";
import { emptyEventDocument, type EventDocument } from "@/lib/events/document/types";
import type { SchemaArtifact } from "@/lib/event-specs/types";

function docWith(extensions: { channel?: unknown; message?: unknown; operation?: unknown }): Record<string, unknown> {
  return {
    ...emptyEventDocument("svc"),
    channels: [{ key: "orders", address: "orders.v1", protocol: "kafka", serverKeys: [], messageKeys: ["Created"], ...(extensions.channel !== undefined ? { extensions: extensions.channel } : {}) }],
    messages: [{ key: "Created", payload: { entityId: "e1", entityVersionId: "v1" }, traitKeys: [], ...(extensions.message !== undefined ? { extensions: extensions.message } : {}) }],
    operations: [{ key: "publish", action: "send", channelKey: "orders", messageKeys: ["Created"], traitKeys: [], ...(extensions.operation !== undefined ? { extensions: extensions.operation } : {}) }],
  };
}

describe("event document parse: extensions", () => {
  it("accepts x- keys with JSON values on a channel, a message and an operation", () => {
    const parsed = parseEventDocument(docWith({
      channel: { "x-serviceName": "vaultserv" },
      message: { "x-slo": { p95: 200 }, "x-flags": [1, "a", null, true] },
      operation: { "x-owner": "payments" },
    }));
    expect(parsed.success).toBe(true);
    if (!parsed.success) return;
    expect(parsed.data.channels[0].extensions).toEqual({ "x-serviceName": "vaultserv" });
    expect(parsed.data.messages[0].extensions).toEqual({ "x-slo": { p95: 200 }, "x-flags": [1, "a", null, true] });
    expect(parsed.data.operations[0].extensions).toEqual({ "x-owner": "payments" });
  });

  it("no extensions key stays absent (an empty map too)", () => {
    const parsed = parseEventDocument(docWith({ channel: {} }));
    expect(parsed.success).toBe(true);
    if (!parsed.success) return;
    expect("extensions" in parsed.data.channels[0]).toBe(false);
    expect("extensions" in parsed.data.messages[0]).toBe(false);
  });

  it("rejects a key that breaks the attribute key rule, at <pointer>/extensions/<key>", () => {
    for (const [target, pointer] of [["channel", "/channels/0"], ["message", "/messages/0"], ["operation", "/operations/0"]] as const) {
      const parsed = parseEventDocument(docWith({ [target]: { serviceName: "vaultserv" } }));
      expect(parsed.success).toBe(false);
      if (parsed.success) continue;
      const problems = (parsed.error.details as { problems: Array<{ pointer: string }> }).problems;
      expect(problems.map((p) => p.pointer)).toEqual([`${pointer}/extensions/serviceName`]);
    }
  });

  it("rejects `x-`, an over-long key and an extensions value that is not an object", () => {
    const long = `x-${"a".repeat(63)}`;
    const bad = parseEventDocument(docWith({ channel: { "x-": 1, [long]: 1 } }));
    expect(bad.success).toBe(false);
    const notObject = parseEventDocument(docWith({ message: ["x-a"] }));
    expect(notObject.success).toBe(false);
    if (!notObject.success) expect((notObject.error.details as { problems: Array<{ pointer: string }> }).problems[0].pointer).toBe("/messages/0/extensions");
  });
});

const PAYLOAD: SchemaArtifact = { format: "json-schema", dialect: "draft-07", schema: { type: "object" } };

describe("event document resolve: extensions", () => {
  it("carries each local item's extensions onto the resolved spec", () => {
    const parsed = parseEventDocument(docWith({ channel: { "x-a": 1 }, message: { "x-b": 2 }, operation: { "x-c": 3 } }));
    if (!parsed.success) throw new Error("parse");
    const resolved = resolveDocument({
      doc: parsed.data, productSlug: "p", version: "1.0",
      artifacts: new Map([["Created", { payloads: [PAYLOAD], keys: [] }]]),
      localTraitHeaders: new Map(), libraryTraits: new Map(), libraryTraitHeaders: new Map(), external: new Map(),
    });
    if (!resolved.success) throw new Error(JSON.stringify(resolved.error));
    expect(resolved.data.channels[0].extensions).toEqual({ "x-a": 1 });
    expect(resolved.data.messages[0].extensions).toEqual({ "x-b": 2 });
    expect(resolved.data.operations[0].extensions).toEqual({ "x-c": 3 });
  });
});

const side = (doc: EventDocument): EventBumpSide => ({ doc, pins: { v1: { entityId: "e1", entityName: "Order", label: "1.0", major: 1 } }, libraryHeaders: {}, externalMajors: {} });

describe("event document bump: extensions", () => {
  const prev = (): EventDocument => {
    const parsed = parseEventDocument(docWith({ channel: { "x-a": 1 }, message: { "x-b": 2 }, operation: { "x-c": 3 } }));
    if (!parsed.success) throw new Error("parse");
    return parsed.data;
  };
  const decide = (mutate: (d: EventDocument) => void) => {
    const next = structuredClone(prev());
    mutate(next);
    return classifyEventBump(side(prev()), side(next));
  };

  it("an unchanged document is PATCH with no reasons", () => {
    expect(decide(() => {})).toEqual({ bump: "PATCH", reasons: [] });
  });

  it("changing, adding or removing an extension on a channel, message or operation is PATCH, named", () => {
    const patch = (...reasons: string[]) => ({ bump: "PATCH", reasons });
    expect(decide((d) => { d.channels[0].extensions = { "x-a": 2 }; })).toEqual(patch('Channel "orders" extensions changed'));
    expect(decide((d) => { d.channels[0].extensions = { "x-a": 1, "x-new": true }; })).toEqual(patch('Channel "orders" extensions changed'));
    expect(decide((d) => { delete d.channels[0].extensions; })).toEqual(patch('Channel "orders" extensions changed'));
    expect(decide((d) => { d.messages[0].extensions = { "x-b": { nested: 1 } }; })).toEqual(patch('Message "Created" extensions changed'));
    expect(decide((d) => { delete d.messages[0].extensions; })).toEqual(patch('Message "Created" extensions changed'));
    expect(decide((d) => { d.operations[0].extensions = { "x-c": "z" }; })).toEqual(patch('Operation "publish" extensions changed'));
    expect(decide((d) => { delete d.operations[0].extensions; })).toEqual(patch('Operation "publish" extensions changed'));
  });
});
