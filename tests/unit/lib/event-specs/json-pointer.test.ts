import { describe, it, expect } from "vitest";
import { jsonPointer, localRef, parseLocalRef, resolveLocalRef } from "@/lib/event-specs/json-pointer";
import { hasErrors, normalizeDiagnostics } from "@/lib/event-specs/diagnostics";
import type { Diagnostic } from "@/lib/event-specs/types";

describe("json pointers", () => {
  it("escapes ~ and / per RFC 6901", () => {
    expect(jsonPointer("channels", "a/b", "c~d")).toBe("/channels/a~1b/c~0d");
    expect(jsonPointer()).toBe("");
    expect(localRef("components", "messages", "OrderCreated")).toBe("#/components/messages/OrderCreated");
  });

  it("parses local refs and rejects remote ones", () => {
    expect(parseLocalRef("#/channels/a~1b/messages/X")).toEqual(["channels", "a/b", "messages", "X"]);
    expect(parseLocalRef("#")).toEqual([]);
    expect(parseLocalRef("https://example.com/schema.json#/x")).toBeNull();
  });

  it("preserves percent-encoded-looking segments as literal text (RFC 6901 has no percent-encoding)", () => {
    // A schema property key that happens to contain %20
    expect(parseLocalRef("#/definitions/my%20field")).toEqual(["definitions", "my%20field"]);
    // A channel key with %XX patterns
    expect(parseLocalRef("#/channels/a%2Fb/messages/X")).toEqual(["channels", "a%2Fb", "messages", "X"]);
    // Mixed: real ~1 escape + percent-looking substring
    expect(parseLocalRef("#/path/a~1b%20c")).toEqual(["path", "a/b%20c"]);
  });

  it("decodeURIComponent is NOT applied — %XX stays literal", () => {
    // Verify that resolveLocalRef can find a key with literal %20
    const doc = { "my key": { "has%20space": true } };
    expect(resolveLocalRef(doc, "#/my key/has%20space")).toEqual({ found: true, value: true });
  });

  it("resolves refs through objects and arrays", () => {
    const doc = { channels: { "checkout.orders": { messages: { M: { payload: 1 } } } }, list: [{ a: true }] };
    expect(resolveLocalRef(doc, "#/channels/checkout.orders/messages/M")).toEqual({
      found: true,
      value: { payload: 1 },
    });
    expect(resolveLocalRef(doc, "#/list/0/a")).toEqual({ found: true, value: true });
    expect(resolveLocalRef(doc, "#/list/1")).toEqual({ found: false });
    expect(resolveLocalRef(doc, "#/channels/missing")).toEqual({ found: false });
  });
});

describe("diagnostics", () => {
  const d = (severity: Diagnostic["severity"], code: string, pointer: string): Diagnostic => ({
    severity,
    code,
    message: code,
    pointer,
  });

  it("orders by severity, pointer, code and removes duplicates", () => {
    const sorted = normalizeDiagnostics([
      d("info", "C", "/a"),
      d("warning", "B", "/b"),
      d("error", "A", "/z"),
      d("error", "A", "/b"),
      d("error", "A", "/b"),
    ]);
    expect(sorted.map((x) => `${x.severity}:${x.pointer}`)).toEqual(["error:/b", "error:/z", "warning:/b", "info:/a"]);
  });

  it("hasErrors is true only when an error is present", () => {
    expect(hasErrors([d("warning", "W", "")])).toBe(false);
    expect(hasErrors([d("warning", "W", ""), d("error", "E", "")])).toBe(true);
  });
});
