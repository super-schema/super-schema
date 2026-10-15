/**
 * Final review C (minor): an operation / server / channel / message key `__proto__` used to be assigned with a plain
 * `obj[key] = value`, which sets the prototype instead of creating the entry — the key silently vanished and the
 * references to it came back as "unresolved ref". It is now a clear error, and the key is still an own entry.
 */
import { describe, it, expect } from "vitest";
import { assembleAsyncApi3 } from "@/lib/event-specs/assemble";
import type { JsonObject } from "@/lib/event-specs/types";
import { channel, message, operation, spec } from "./fixtures/builders";

const ch = channel({ id: "ch1", name: "orders" });
const msg = message({ id: "m1", name: "OrderCreated" });

const reservedErrors = (diagnostics: Array<{ code: string; message: string; pointer: string }>) =>
  diagnostics.filter((d) => d.code === "RESERVED_KEY");

describe("assembleAsyncApi3 — reserved keys", () => {
  it("an operation key __proto__ is reported, and the entry survives as an own key", () => {
    const { document, diagnostics } = assembleAsyncApi3(
      spec({
        channels: [ch],
        messages: [msg],
        operations: [operation({ key: "__proto__", channelRef: ch.id, messageRefs: [msg.id] })],
      }),
    );
    expect(reservedErrors(diagnostics)).toEqual([
      {
        severity: "error",
        code: "RESERVED_KEY",
        message: 'Operation key "__proto__" is reserved and cannot be used as a document key — rename it',
        pointer: "/operations/__proto__",
      },
    ]);
    const operations = document.operations as JsonObject;
    expect(Object.keys(operations)).toEqual(["__proto__"]);
    expect(Object.getPrototypeOf(operations)).toBe(Object.prototype);
    expect(JSON.stringify(document.operations)).toContain('"__proto__":{"action":"send"');
  });

  it("a server key __proto__ is reported and kept", () => {
    const { document, diagnostics } = assembleAsyncApi3(
      spec({ servers: [{ key: "__proto__", host: "h:1", protocol: "kafka" }, { key: "ok", host: "o:1", protocol: "kafka" }] }),
    );
    expect(reservedErrors(diagnostics).map((d) => [d.pointer, d.message])).toEqual([
      ["/servers/__proto__", 'Server key "__proto__" is reserved and cannot be used as a document key — rename it'],
    ]);
    expect(Object.keys(document.servers as JsonObject).sort()).toEqual(["__proto__", "ok"]);
  });

  it("a channel or message named __proto__ fails with the clear message, and its references still resolve", () => {
    const badChannel = channel({ id: "chx", name: "__proto__" });
    const badMessage = message({ id: "mx", name: "__proto__" });
    const { document, diagnostics } = assembleAsyncApi3(
      spec({
        channels: [badChannel],
        messages: [badMessage],
        operations: [operation({ key: "op1", channelRef: badChannel.id, messageRefs: [badMessage.id] })],
      }),
    );
    const reserved = reservedErrors(diagnostics);
    expect(reserved.map((d) => d.message).sort()).toEqual([
      'Channel name "__proto__" is reserved and cannot be used as a document key — rename it',
      'Message name "__proto__" is reserved and cannot be used as a document key — rename it',
    ]);
    // No dangling reference: the entries are real own properties, so `$ref`s into them resolve.
    expect(Object.keys(document.channels as JsonObject)).toEqual(["__proto__"]);
    expect(Object.keys((document.components as JsonObject).messages as JsonObject)).toEqual(["__proto__"]);
    expect(diagnostics.some((d) => d.code === "UNKNOWN_CHANNEL_REF" || d.code === "UNKNOWN_MESSAGE_REF")).toBe(false);
  });

  it("constructor / prototype are reserved too, but toString-style names are fine", () => {
    const { diagnostics } = assembleAsyncApi3(
      spec({
        channels: [ch],
        messages: [msg],
        operations: [
          operation({ key: "constructor", channelRef: ch.id, messageRefs: [msg.id] }),
          operation({ key: "prototype", channelRef: ch.id, messageRefs: [msg.id] }),
          operation({ key: "toString", channelRef: ch.id, messageRefs: [msg.id] }),
        ],
      }),
    );
    expect(reservedErrors(diagnostics).map((d) => d.pointer)).toEqual(["/operations/constructor", "/operations/prototype"]);
  });

  it("user-supplied map entries named __proto__ (channel parameters, trait specs) are preserved, not dropped", () => {
    const parameters = JSON.parse('{"__proto__":{"description":"p"},"id":{"description":"i"}}') as Record<string, JsonObject>;
    const { document } = assembleAsyncApi3(
      spec({ channels: [{ ...ch, parameters }], messages: [msg], operations: [operation({ key: "o", channelRef: ch.id, messageRefs: [msg.id] })] }),
    );
    const out = (document.channels as JsonObject).orders as JsonObject;
    expect(Object.keys(out.parameters as JsonObject).sort()).toEqual(["__proto__", "id"]);
  });

  it("ordinary documents are unaffected (no RESERVED_KEY, same keys in the same order)", () => {
    const { document, diagnostics } = assembleAsyncApi3(
      spec({ channels: [ch], messages: [msg], operations: [operation({ key: "publish", channelRef: ch.id, messageRefs: [msg.id] })] }),
    );
    expect(reservedErrors(diagnostics)).toEqual([]);
    expect(Object.keys(document)).toEqual(["asyncapi", "info", "channels", "operations", "components"]);
  });
});
