import { describe, it, expect } from "vitest";
import {
  normalizeCatalogName,
  normalizeFormatProfile,
  normalizeProtocol,
  parseJsonObjectArrayText,
  parseJsonObjectText,
  formatJsonText,
} from "@/lib/events/inputs";

describe("catalog inputs", () => {
  it("accepts AsyncAPI component-key names and trims them", () => {
    expect(normalizeCatalogName("  OrderCreated ", "Message")).toEqual({ success: true, data: "OrderCreated" });
    expect(normalizeCatalogName("checkout.orders-v1_x", "Channel").success).toBe(true);
  });

  it("rejects names with spaces, slashes or over 128 chars", () => {
    for (const bad of ["Order Created", "a/b", "", "x".repeat(129)]) {
      const r = normalizeCatalogName(bad, "Message");
      expect(r.success).toBe(false);
      expect(!r.success && r.error.code).toBe("VALIDATION_ERROR");
    }
  });

  it("lower-cases protocols and rejects malformed ones", () => {
    expect(normalizeProtocol(" Kafka ")).toEqual({ success: true, data: "kafka" });
    expect(normalizeProtocol("kafka-secure").success).toBe(true);
    expect(normalizeProtocol("my protocol").success).toBe(false);
    expect(normalizeProtocol("").success).toBe(false);
  });

  it("defaults JSON Schema to draft-07 and forbids a dialect on other formats", () => {
    expect(normalizeFormatProfile("json-schema", null)).toEqual({ success: true, data: { format: "json-schema", formatDialect: "draft-07" } });
    expect(normalizeFormatProfile("json-schema", "2020-12")).toEqual({ success: true, data: { format: "json-schema", formatDialect: "2020-12" } });
    expect(normalizeFormatProfile("avro", "")).toEqual({ success: true, data: { format: "avro", formatDialect: null } });
    expect(normalizeFormatProfile("avro", "draft-07").success).toBe(false);
    expect(normalizeFormatProfile("xml", null).success).toBe(false);
    expect(normalizeFormatProfile("json-schema", "draft-04").success).toBe(false);
  });

  it("parses JSON object / array-of-object text; empty means undefined", () => {
    expect(parseJsonObjectText("  ", "Bindings")).toEqual({ success: true, data: undefined });
    expect(parseJsonObjectText('{"kafka":{"partitions":12}}', "Bindings")).toEqual({ success: true, data: { kafka: { partitions: 12 } } });
    const notObject = parseJsonObjectText("[1]", "Bindings");
    expect(!notObject.success && notObject.error.message).toMatch(/Bindings must be a JSON object/);
    const broken = parseJsonObjectText("{", "Bindings");
    expect(!broken.success && broken.error.message).toMatch(/Bindings is not valid JSON/);
    expect(parseJsonObjectArrayText('[{"payload":{"id":"1"}}]', "Examples")).toEqual({ success: true, data: [{ payload: { id: "1" } }] });
    expect(parseJsonObjectArrayText('[1]', "Examples").success).toBe(false);
  });

  it("formats JSON for textareas", () => {
    expect(formatJsonText(undefined)).toBe("");
    expect(formatJsonText({ a: 1 })).toBe('{\n  "a": 1\n}');
  });
});
