/**
 * Unit tests for the protobuf-target source projection (pure text → text).
 * The real-compiler proof lives in tests/integration/protobuf-all-types.test.ts;
 * these pin the edge cases of the rewrite itself without a `tsp` shell-out.
 */
import { describe, it, expect } from "vitest";
import {
  projectTypeSpecSourceForProtobuf,
  rewriteTypeExpressionForProtobuf,
} from "@/lib/typespec-official/protobuf-source";

const TIMESTAMP = "TypeSpec.Protobuf.WellKnown.Timestamp";

describe("rewriteTypeExpressionForProtobuf", () => {
  it.each([
    ["utcDateTime", TIMESTAMP],
    ["offsetDateTime", TIMESTAMP],
    ["unixTimestamp32", TIMESTAMP],
    ["duration", 'TypeSpec.Protobuf.Extern<"google/protobuf/duration.proto", "google.protobuf.Duration">'],
    ["plainDate", 'TypeSpec.Protobuf.Extern<"google/type/date.proto", "google.type.Date">'],
    ["plainTime", 'TypeSpec.Protobuf.Extern<"google/type/timeofday.proto", "google.type.TimeOfDay">'],
    ["decimal", "string"],
    ["decimal128", "string"],
    ["numeric", "string"],
    ["integer", "int64"],
    ["float", "float64"],
  ])("substitutes %s", (input, expected) => {
    expect(rewriteTypeExpressionForProtobuf(input)).toBe(expected);
  });

  it.each(["string", "int8", "int16", "uint8", "uint16", "safeint", "url", "float32", "bytes", "boolean", "Customer"])(
    "leaves %s for the emitter to resolve natively",
    (input) => {
      expect(rewriteTypeExpressionForProtobuf(input)).toBe(input);
    }
  );

  it("substitutes inside arrays and maps, and maps Record<unknown> to Struct", () => {
    expect(rewriteTypeExpressionForProtobuf("utcDateTime[]")).toBe(`${TIMESTAMP}[]`);
    expect(rewriteTypeExpressionForProtobuf("Record<decimal>")).toBe("TypeSpec.Protobuf.Map<string, string>");
    expect(rewriteTypeExpressionForProtobuf("Record<int32, utcDateTime>")).toBe(
      `TypeSpec.Protobuf.Map<int32, ${TIMESTAMP}>`
    );
    expect(rewriteTypeExpressionForProtobuf("Record<unknown>")).toBe(
      'TypeSpec.Protobuf.Extern<"google/protobuf/struct.proto", "google.protobuf.Struct">'
    );
  });

  it("is idempotent and never rewrites member-access tails or string literals", () => {
    const once = rewriteTypeExpressionForProtobuf("Record<plainDate>");
    expect(rewriteTypeExpressionForProtobuf(once)).toBe(once);
    expect(rewriteTypeExpressionForProtobuf("Lib.decimal")).toBe("Lib.decimal");
    expect(rewriteTypeExpressionForProtobuf('"decimal"')).toBe('"decimal"');
  });
});

describe("projectTypeSpecSourceForProtobuf", () => {
  it("rewrites property types only — docs and property names that look like scalars are untouched", () => {
    const source = [
      "model Event {",
      '  @doc("A utcDateTime field")',
      "  at?: utcDateTime;",
      "  @minValue(0)",
      "  duration: int32;",
      "}",
    ].join("\n");

    expect(projectTypeSpecSourceForProtobuf(source)).toBe(
      [
        "model Event {",
        '  @doc("A utcDateTime field")',
        `  at?: ${TIMESTAMP};`,
        "  @minValue(0)",
        "  duration: int32;",
        "}",
      ].join("\n")
    );
  });

  it("drops type-bound decorators and defaults from substituted properties only", () => {
    const source = [
      "model Priced {",
      '  @doc("Unit price")',
      "  @minValue(0)",
      "  @maxValue(1000000)",
      "  @example(19.99)",
      "  price: decimal = 0;",
      '  @encode("rfc3339")',
      "  at: utcDateTime;",
      "  @maxLength(10)",
      '  code: string = "x";',
      "}",
    ].join("\n");

    expect(projectTypeSpecSourceForProtobuf(source)).toBe(
      [
        "model Priced {",
        '  @doc("Unit price")',
        "  price: string;",
        `  at: ${TIMESTAMP};`,
        "  @maxLength(10)",
        '  code: string = "x";',
        "}",
      ].join("\n")
    );
  });

  it("gives value-less enums explicit integers behind an <ENUM>_UNSPECIFIED zero value", () => {
    const source = ["enum AllTypes_status {", "  ACTIVE,", "  INACTIVE,", "}"].join("\n");

    expect(projectTypeSpecSourceForProtobuf(source)).toBe(
      [
        "enum AllTypes_status {",
        "  ALL_TYPES_STATUS_UNSPECIFIED: 0,",
        "  ACTIVE: 1,",
        "  INACTIVE: 2,",
        "}",
      ].join("\n")
    );
  });

  it("keeps an existing zero-style first member instead of adding a sentinel", () => {
    const source = ["enum Status {", "  STATUS_UNKNOWN,", "  ACTIVE,", "}"].join("\n");

    expect(projectTypeSpecSourceForProtobuf(source)).toBe(
      ["enum Status {", "  STATUS_UNKNOWN: 0,", "  ACTIVE: 1,", "}"].join("\n")
    );
  });

  it("turns an empty (placeholder) enum into a single zero value", () => {
    const source = ["enum HTTPStatus {", "  // TODO: Define enum values", "}"].join("\n");

    expect(projectTypeSpecSourceForProtobuf(source)).toBe(
      ["enum HTTPStatus {", "  HTTP_STATUS_UNSPECIFIED: 0,", "}"].join("\n")
    );
  });
});
