/**
 * Bug-hunt #5: the sync deleted owned keys the source text does not show, erasing validators / format / wire format / bounds the
 * generator withheld on purpose (dangling `unknown` fields, out-of-range bounds, validators the scalar does not accept).
 */
import { describe, it, expect } from "vitest";
import { mergeSyncedField, type SyncExistingField, type SyncSourceField } from "@/lib/typespec-sync/merge-fields";

const RAW = "other.json";

const src = (over: Partial<SyncSourceField> = {}): SyncSourceField => ({
  name: "f", type: "string", isOptional: false, isKey: false, decorators: {}, ...over,
});
const row = (over: Partial<SyncExistingField> = {}): SyncExistingField => ({
  type: "string", nullable: false, isKey: false, description: "", classification: null, decorators: {}, ...over,
});

describe("a dangling field keeps what the generator withheld", () => {
  it("preserves validators, format and wire format of a dangling direct reference", () => {
    const existing = row({
      type: "reference",
      decorators: {
        danglingRef: { ref: RAW, reason: "r" },
        referencedEntityName: "other",
        typespec: {
          identity: { format: "uuid" },
          validation: { maxLength: 5, pattern: "^a" },
          wireFormat: { encode: "base64" },
        },
      },
    });
    const m = mergeSyncedField(existing, src({ type: "unknown", decorators: { extensions: { $ref: RAW } } }));
    expect(m.type).toBe("reference");
    const ts = m.decorators.typespec as Record<string, Record<string, unknown>>;
    expect(ts.identity).toEqual({ format: "uuid" });
    expect(ts.validation).toEqual({ maxLength: 5, pattern: "^a" });
    expect(ts.wireFormat).toEqual({ encode: "base64" });
  });

  it("an element-dangling field still takes minItems / maxItems from the source", () => {
    const existing = row({
      type: "array",
      decorators: {
        arrayElementType: "reference",
        danglingRef: { ref: RAW, reason: "r", element: true },
        typespec: { validation: { maxLength: 5, minItems: 1 } },
      },
    });
    const m = mergeSyncedField(existing, src({ type: "array", arrayElementType: "unknown", decorators: { extensions: { items: { $ref: RAW } }, maxItems: 4 } }));
    const v = (m.decorators.typespec as Record<string, Record<string, unknown>>).validation;
    expect(v).toEqual({ maxLength: 5, maxItems: 4 });
  });
});

describe("bounds and validators the generator dropped for the type are kept", () => {
  it("keeps an out-of-range bound the text does not carry", () => {
    const existing = row({ type: "int32", decorators: { typespec: { validation: { maxValue: 9223372036854775807, minValue: 1 } } } });
    const m = mergeSyncedField(existing, src({ type: "int32", decorators: { minValue: 1 } }));
    expect((m.decorators.typespec as Record<string, Record<string, unknown>>).validation).toEqual({ minValue: 1, maxValue: 9223372036854775807 });
  });

  it("keeps maxLength / pattern on a date-time (not applicable, never written)", () => {
    const existing = row({ type: "utcDateTime", decorators: { typespec: { validation: { maxLength: 30, pattern: "^2" } } } });
    const m = mergeSyncedField(existing, src({ type: "utcDateTime" }));
    expect((m.decorators.typespec as Record<string, Record<string, unknown>>).validation).toEqual({ maxLength: 30, pattern: "^2" });
  });

  it("still drops an applicable validator the user removed from the text", () => {
    const existing = row({ type: "string", decorators: { typespec: { validation: { maxLength: 30 } } } });
    const m = mergeSyncedField(existing, src({ type: "string" }));
    expect(m.decorators.typespec).toBeUndefined();
  });

  it("drops an in-range bound the user removed from the text", () => {
    const existing = row({ type: "int32", decorators: { typespec: { validation: { maxValue: 5 } } } });
    const m = mergeSyncedField(existing, src({ type: "int32" }));
    expect(m.decorators.typespec).toBeUndefined();
  });
});
