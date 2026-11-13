// Metadata attributes (extensions) on assembled channels, messages and operations; `internal` ones are dropped on request.
import { describe, expect, it } from "vitest";
import { assembleAsyncApi3 } from "@/lib/event-specs/assemble";
import type { JsonObject, ResolvedEventSpec } from "@/lib/event-specs/types";
import { channel, message, operation, spec } from "./fixtures/builders";

const at = (doc: JsonObject, ...path: string[]): unknown => path.reduce<unknown>((node, key) => (node as Record<string, unknown> | undefined)?.[key], doc);

function withExtensions(): ResolvedEventSpec {
  const ch = channel({ id: "ch", name: "orders", extensions: { "x-serviceName": "vaultserv", "x-owner": "payments" } });
  const msg = message({ id: "m", name: "Created", extensions: { "x-slo": { p95: 200 }, "x-owner": "payments" } });
  return spec({
    channels: [ch],
    messages: [msg],
    operations: [operation({ key: "publish", channelRef: "ch", messageRefs: ["m"], extensions: { "x-owner": "payments", "x-tier": 1 } })],
  });
}

describe("assembleAsyncApi3: extensions", () => {
  it("spreads extensions onto the emitted channel, message and operation, after the native keys", () => {
    const { document } = assembleAsyncApi3(withExtensions());
    expect(at(document, "channels", "orders", "x-serviceName")).toBe("vaultserv");
    expect(at(document, "components", "messages", "Created", "x-slo")).toEqual({ p95: 200 });
    expect(at(document, "operations", "publish", "x-tier")).toBe(1);
    const keys = Object.keys(at(document, "channels", "orders") as object);
    expect(keys.slice(-2).sort()).toEqual(["x-owner", "x-serviceName"]);
    expect(keys.indexOf("address")).toBeLessThan(keys.indexOf("x-owner"));
  });

  it("a native key is never overwritten by an extension of the same name", () => {
    const ch = channel({ id: "ch", name: "orders", extensions: { address: "evil", title: "evil" } as never });
    const { document } = assembleAsyncApi3(spec({ channels: [ch], messages: [message({ id: "m", name: "M" })], operations: [operation({ key: "o", channelRef: "ch", messageRefs: ["m"] })] }));
    expect(at(document, "channels", "orders", "address")).toBe("orders.v1");
    expect(at(document, "channels", "orders", "title")).toBeUndefined();
  });

  it("drops the keys named in internalKeys from every emitted object, and keeps the others", () => {
    const input = withExtensions();
    const { document } = assembleAsyncApi3({ ...input, internalKeys: new Set(["x-owner"]) });
    expect(at(document, "channels", "orders", "x-owner")).toBeUndefined();
    expect(at(document, "components", "messages", "Created", "x-owner")).toBeUndefined();
    expect(at(document, "operations", "publish", "x-owner")).toBeUndefined();
    expect(at(document, "channels", "orders", "x-serviceName")).toBe("vaultserv");
    expect(at(document, "operations", "publish", "x-tier")).toBe(1);
    expect(JSON.stringify(document)).not.toContain("payments");
    // the input (the stored draft) keeps everything
    expect(input.channels[0].extensions).toHaveProperty("x-owner");
  });

  it("without extensions the document is exactly what it was", () => {
    const plain = spec({ channels: [channel({ id: "ch", name: "orders" })], messages: [message({ id: "m", name: "Created" })], operations: [operation({ key: "p", channelRef: "ch", messageRefs: ["m"] })] });
    const withEmpty = spec({
      channels: [channel({ id: "ch", name: "orders", extensions: {} })], messages: [message({ id: "m", name: "Created", extensions: {} })],
      operations: [operation({ key: "p", channelRef: "ch", messageRefs: ["m"], extensions: {} })],
    });
    expect(JSON.stringify(assembleAsyncApi3(withEmpty).document)).toBe(JSON.stringify(assembleAsyncApi3(plain).document));
    expect(JSON.stringify(assembleAsyncApi3({ ...plain, internalKeys: new Set(["x-a"]) }).document)).toBe(JSON.stringify(assembleAsyncApi3(plain).document));
  });

  it("drops internal keys from emitted message and operation trait specs (R10, A2)", () => {
    const traits: ResolvedEventSpec["traits"] = [
      { id: "mt", name: "Audit", kind: "MESSAGE" as const, ownerSlug: "checkout", spec: { "x-review-note": "secret-mt", "x-owner": "ok", contentType: "application/json" } },
      { id: "mth", name: "Hdr", kind: "MESSAGE" as const, ownerSlug: "checkout", spec: { "x-review-note": "secret-mth" }, headers: { format: "json-schema" as const, dialect: "draft-07" as const, schema: { type: "object", properties: { a: { type: "string", "x-review-note": "secret-h" } } } } },
      { id: "ot", name: "Sec", kind: "OPERATION" as const, ownerSlug: "checkout", spec: { "x-review-note": "secret-ot", bindings: { kafka: { "x-review-note": "secret-nested" } } } },
    ];
    const input = spec({
      channels: [channel({ id: "ch", name: "orders" })],
      messages: [message({ id: "m", name: "Created", traitRefs: ["mt", "mth"] })],
      operations: [operation({ key: "p", channelRef: "ch", messageRefs: ["m"], traitRefs: ["ot"] })],
      traits,
    });
    const { document } = assembleAsyncApi3({ ...input, internalKeys: new Set(["x-review-note"]) });
    const text = JSON.stringify(document);
    expect(text).not.toContain("secret");
    expect(text).not.toContain("x-review-note");
    expect(at(document, "components", "messageTraits", "Audit", "x-owner")).toBe("ok");
    expect(at(document, "components", "messageTraits", "Audit", "contentType")).toBe("application/json");
    // without internal keys, the traits are emitted verbatim
    expect(JSON.stringify(assembleAsyncApi3(input).document)).toContain("secret-ot");
  });

  it("drops an internal key nested anywhere in the document, e.g. inside a payload schema (R10 deep strip)", () => {
    const msg = message({ id: "m", name: "Created", payloads: [{ format: "json-schema", dialect: "draft-07", schema: { type: "object", properties: { t: { type: "array", items: { type: "string", "x-review-note": "secret" } } } } }], profile: { format: "json-schema" } });
    const input = spec({ channels: [channel({ id: "ch", name: "orders", profile: { format: "json-schema" } })], messages: [msg], operations: [operation({ key: "p", channelRef: "ch", messageRefs: ["m"] })] });
    const { document } = assembleAsyncApi3({ ...input, internalKeys: new Set(["x-review-note"]) });
    expect(JSON.stringify(document)).not.toContain("secret");
  });
});
