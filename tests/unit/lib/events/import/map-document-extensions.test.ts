// AsyncAPI import: x- extensions on channels, messages and operations are kept (no UNSUPPORTED_EXTENSION warning).
import { describe, expect, it } from "vitest";
import { extractPayloads } from "@/lib/events/import/payloads";
import { mapAsyncApiToEventDocument } from "@/lib/events/import/map-document";
import type { ImportWarning, MapContext, RawAsyncApi3 } from "@/lib/events/import/types";

function map(raw: RawAsyncApi3) {
  const extracted = extractPayloads(raw);
  if (!extracted.success) throw new Error(extracted.error.message);
  const ctx: MapContext = {
    payloadPins: new Map(extracted.data.map((p) => [`${p.messageKey}:${p.role}`, { entityId: `ent-${p.messageKey}`, entityVersionId: null }])),
    builtInTraitIds: {},
  };
  const result = mapAsyncApiToEventDocument(raw, ctx);
  if (!result.success) throw new Error(`${result.error.code}: ${result.error.message}`);
  return result.data;
}
const tiny = (o: { channel?: object; message?: object; operation?: object; server?: object } = {}): RawAsyncApi3 => ({
  asyncapi: "3.0.0", info: { title: "T", version: "1" },
  servers: { s: { host: "h:1", protocol: "kafka", ...o.server } },
  channels: { c: { address: "a", messages: { m: { $ref: "#/components/messages/m" } }, ...o.channel } },
  operations: { o: { action: "send", channel: { $ref: "#/channels/c" }, messages: [{ $ref: "#/channels/c/messages/m" }], ...o.operation } },
  components: { messages: { m: { payload: { type: "object" }, ...o.message } } },
});
const byCode = (w: ImportWarning[], code: string) => w.filter((x) => x.code === code);

describe("AsyncAPI import: extensions", () => {
  it("stores an x- key on a channel, message and operation, and warns about none of them", () => {
    const { document, warnings } = map(tiny({
      channel: { "x-visibility": "public" }, message: { "x-owner": "team-a", "x-slo": { p95: 200 } }, operation: { "x-tier": 1 },
    }));
    expect(document.channels[0].extensions).toEqual({ "x-visibility": "public" });
    expect(document.messages[0].extensions).toEqual({ "x-owner": "team-a", "x-slo": { p95: 200 } });
    expect(document.operations[0].extensions).toEqual({ "x-tier": 1 });
    expect(byCode(warnings, "UNSUPPORTED_EXTENSION").filter((w) => !w.pointer.startsWith("/servers"))).toEqual([]);
  });

  it("an item without extensions has no extensions key", () => {
    const { document } = map(tiny());
    expect("extensions" in document.channels[0]).toBe(false);
    expect("extensions" in document.messages[0]).toBe(false);
    expect("extensions" in document.operations[0]).toBe(false);
  });

  it("a key outside the attribute key rule is not imported and is reported as an unsupported extension", () => {
    const { document, warnings } = map(tiny({ channel: { "x-": 1, "x-ok": 2, "x-bad key": 3 } }));
    expect(document.channels[0].extensions).toEqual({ "x-ok": 2 });
    expect(byCode(warnings, "UNSUPPORTED_EXTENSION").map((w) => w.pointer).sort()).toEqual(["/channels/c/x-", "/channels/c/x-bad key"]);
  });

  it("a server's extension is still reported (servers have no place for one)", () => {
    const { warnings } = map(tiny({ server: { "x-region": "eu" } }));
    expect(byCode(warnings, "UNSUPPORTED_EXTENSION").map((w) => w.pointer)).toEqual(["/servers/s/x-region"]);
  });
});
