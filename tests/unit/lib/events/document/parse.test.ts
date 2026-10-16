import { describe, expect, it } from "vitest";
import { emptyEventDocument, type EventDocument } from "@/lib/events/document/types";
import { parseEventDocument } from "@/lib/events/document/parse";

const pin = (id: string, v: string | null = "ev1") => ({ entityId: id, entityVersionId: v });

function valid(): EventDocument {
  return {
    ...emptyEventDocument("checkout-service"),
    servers: [{ key: "kafka-prod", protocol: "kafka", host: "kafka-prod.internal:9092" }],
    channels: [{ key: "orders", address: "payments.orders.v1", protocol: "kafka", serverKeys: ["kafka-prod"], format: "avro", messageKeys: ["OrderCreated"] }],
    messages: [{ key: "OrderCreated", payload: pin("ent-order"), keyPin: pin("ent-key"), traitKeys: ["CloudEvents"] }],
    traits: [{ key: "CloudEvents", kind: "MESSAGE", libraryTraitId: "trait-1" }],
    operations: [{ key: "publishOrderCreated", action: "send", channelKey: "orders", messageKeys: ["OrderCreated"], traitKeys: [] }],
  };
}
function problems(value: unknown): Array<{ pointer: string; message: string }> {
  const r = parseEventDocument(value);
  return r.success ? [] : ((r.error.details as { problems: Array<{ pointer: string; message: string }> }).problems);
}
const mutate = (fn: (d: EventDocument) => void) => { const d = valid(); fn(d); return d; };

describe("parseEventDocument", () => {
  it("accepts a complete document and returns it unchanged", () => {
    const r = parseEventDocument(valid());
    expect(r.success).toBe(true);
    if (r.success) expect(r.data).toEqual(valid());
  });
  it("accepts the empty document", () => {
    expect(parseEventDocument(emptyEventDocument("t")).success).toBe(true);
  });
  it("rejects non-objects and the wrong documentVersion", () => {
    expect(problems(null)[0].pointer).toBe("");
    expect(problems({ ...valid(), documentVersion: 1 })[0].pointer).toBe("/documentVersion");
  });
  it("requires info.title", () => {
    expect(problems(mutate((d) => { d.info.title = "  "; })).map((p) => p.pointer)).toContain("/info/title");
  });
  it("rejects invalid keys (space, slash, 65 chars)", () => {
    for (const key of ["a b", "a/b", "x".repeat(65)]) {
      const p = problems(mutate((d) => { d.channels[0].key = key; d.operations[0].channelKey = key; }));
      expect(p.map((x) => x.pointer)).toContain("/channels/0/key");
    }
  });
  it("rejects duplicate keys inside one namespace, including external refs", () => {
    const dup = mutate((d) => {
      d.externalRefs = [{ key: "OrderCreated", eventVersionId: "ev-other", kind: "message", itemKey: "Foo" }];
    });
    expect(problems(dup).map((p) => p.pointer)).toContain("/externalRefs/0/key");
    const twoChannels = mutate((d) => { d.channels.push({ ...d.channels[0] }); });
    expect(problems(twoChannels).map((p) => p.pointer)).toContain("/channels/1/key");
  });
  it("requires unique trait keys across both kinds", () => {
    const d = mutate((x) => { x.traits.push({ key: "CloudEvents", kind: "OPERATION", spec: {} }); });
    expect(problems(d).map((p) => p.pointer)).toContain("/traits/1/key");
  });
  it("validates channel fields", () => {
    expect(problems(mutate((d) => { (d.channels[0] as { format: string }).format = "xml"; })).map((p) => p.pointer)).toContain("/channels/0/format");
    expect(problems(mutate((d) => { d.channels[0].formatDialect = "2020-12"; })).map((p) => p.pointer)).toContain("/channels/0/formatDialect"); // dialect only for json-schema
    expect(problems(mutate((d) => { d.channels[0].protocol = ""; })).map((p) => p.pointer)).toContain("/channels/0/protocol");
    expect(problems(mutate((d) => { d.channels[0].serverKeys = ["nope"]; })).map((p) => p.pointer)).toContain("/channels/0/serverKeys/0");
    expect(problems(mutate((d) => { d.channels[0].messageKeys = ["ghost"]; })).map((p) => p.pointer)).toContain("/channels/0/messageKeys/0");
  });
  it("requires a parameter for every address expression", () => {
    const d = mutate((x) => { x.channels[0].address = "orders.{tenantId}.{region}"; x.channels[0].parameters = { tenantId: {} }; });
    const p = problems(d);
    expect(p.map((x) => x.pointer)).toContain("/channels/0/parameters");
    expect(p.some((x) => x.message.includes("{region}"))).toBe(true);
    const repeated = mutate((x) => { x.channels[0].address = "o.{a}.{a}"; x.channels[0].parameters = { a: {} }; });
    expect(problems(repeated)).toEqual([]);
    const empty = mutate((x) => { x.channels[0].address = "o.{}"; });
    expect(problems(empty).map((x) => x.pointer)).toContain("/channels/0/address");
  });
  it("requires a pinned payload entity and valid optional pins", () => {
    expect(problems(mutate((d) => { (d.messages[0] as { payload?: unknown }).payload = undefined; })).map((p) => p.pointer)).toContain("/messages/0/payload");
    expect(problems(mutate((d) => { d.messages[0].payload = { entityId: "", entityVersionId: null }; })).map((p) => p.pointer)).toContain("/messages/0/payload/entityId");
    expect(problems(mutate((d) => { d.messages[0].payload = pin("e", null); }))).toEqual([]); // unpinned is a legal draft
  });
  it("checks message trait references and kinds", () => {
    expect(problems(mutate((d) => { d.messages[0].traitKeys = ["missing"]; })).map((p) => p.pointer)).toContain("/messages/0/traitKeys/0");
    const wrongKind = mutate((d) => { d.traits[0] = { key: "CloudEvents", kind: "OPERATION", libraryTraitId: "t" }; });
    expect(problems(wrongKind).map((p) => p.pointer)).toContain("/messages/0/traitKeys/0");
  });
  it("keeps operations consistent with their channel", () => {
    expect(problems(mutate((d) => { d.operations[0].channelKey = "nope"; })).map((p) => p.pointer)).toContain("/operations/0/channelKey");
    const notOnChannel = mutate((d) => { d.messages.push({ key: "Other", payload: pin("e2"), traitKeys: [] }); d.operations[0].messageKeys = ["Other"]; });
    expect(problems(notOnChannel).map((p) => p.pointer)).toContain("/operations/0/messageKeys/0");
    const replyNoChannel = mutate((d) => { d.operations[0].reply = { messageKeys: ["OrderCreated"] }; });
    expect(problems(replyNoChannel).map((p) => p.pointer)).toContain("/operations/0/reply/channelKey");
    expect(problems(mutate((d) => { d.operations[0].action = "publish" as never; })).map((p) => p.pointer)).toContain("/operations/0/action");
  });
  it("allows operations on external channels without a subset check", () => {
    const d = mutate((x) => {
      x.externalRefs = [{ key: "ext-orders", eventVersionId: "ev9", kind: "channel", itemKey: "orders" }];
      x.operations.push({ key: "recv", action: "receive", channelKey: "ext-orders", messageKeys: ["OrderCreated"], traitKeys: [] });
    });
    expect(problems(d)).toEqual([]);
  });
  it("validates servers and external refs", () => {
    expect(problems(mutate((d) => { d.servers[0].pathname = "v1"; })).map((p) => p.pointer)).toContain("/servers/0/pathname");
    expect(problems(mutate((d) => { d.servers[0].host = ""; })).map((p) => p.pointer)).toContain("/servers/0/host");
    const badRef = mutate((d) => { d.externalRefs = [{ key: "x", eventVersionId: "", kind: "message", itemKey: "" }]; });
    const ptrs = problems(badRef).map((p) => p.pointer);
    expect(ptrs).toContain("/externalRefs/0/eventVersionId");
    expect(ptrs).toContain("/externalRefs/0/itemKey");
  });
  it("drops undefined optionals and trims strings", () => {
    const r = parseEventDocument(mutate((d) => { d.info.title = "  spaced  "; d.channels[0].title = undefined; }));
    expect(r.success && r.data.info.title).toBe("spaced");
    expect(r.success && "title" in r.data.channels[0]).toBe(false);
  });
});
