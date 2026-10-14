/**
 * Protobuf target — every logical type emits a VALID .proto (Story 16.1, open item O1).
 *
 * The official `@typespec/protobuf` emitter only knows the proto scalars
 * (bytes/bool/string/int32/int64/uint32/uint64/float32/float64 + the
 * Protobuf.* fixed/sint variants) and walks a scalar's `extends` chain to find
 * one. Every TypeSpec stdlib scalar whose chain ends at `numeric` (numeric,
 * integer, float, decimal, decimal128) or at a temporal root (plainDate,
 * plainTime, utcDateTime, offsetDateTime, duration, unixTimestamp32) used to
 * fail with `unsupported-field-type: no known protobuf scalar for TypeSpec
 * scalar type …`. The protobuf-target source build now substitutes
 * industry-standard proto representations — and the emitted proto type for
 * every scalar/temporal logical type must equal the documented `protobuf`
 * entry in the default type-mapping table, so the table can never drift from
 * what the emitter actually produces.
 *
 * Runs the REAL `tsp compile` shell-out + official emitter, then parses the
 * emitted .proto with protobufjs to assert it is syntactically valid proto3.
 */
import { describe, it, expect, vi, beforeAll } from "vitest";

vi.mock("server-only", () => ({}));
vi.mock("@/lib/db", () => ({ prisma: {} }));

import { parse as parseProto, type Type as ProtoType, type Enum as ProtoEnum } from "protobufjs";
import {
  compileEntity,
  type PrismaEntityInput,
  type PrismaFieldInput,
} from "@/lib/compiler/compiler.service";
import { generateTypeSpec } from "@/lib/compiler/typespec-generator";
import { DATA_TYPE_HIERARCHY, isComplexType } from "@/lib/data-types";
import { getDefaultMapping } from "@/lib/type-mapping/default-mappings";
import {
  emitOfficialTypeSpecTargetFromData,
  type OfficialTypeSpecTargetResult,
} from "@/lib/typespec-official/emitter.service";

const EMIT_TIMEOUT_MS = 60_000;

function decoratorsFor(typeId: string): Record<string, unknown> {
  switch (typeId) {
    case "array":
      return { arrayElementType: "string" };
    case "map":
      return { mapKeyType: "string", mapValueType: "string" };
    case "object":
      return { nestedFields: [{ name: "inner", type: "string", nullable: false }] };
    default:
      return {};
  }
}

/**
 * One field per logical type. "reference" is excluded: a reference to a
 * sibling entity that is not part of the same compile unit fails every real
 * typespec-cli target ("Unknown identifier") — a separately tracked
 * multi-model gap, not a protobuf scalar concern (same exclusion as
 * tests/integration/all-types-roundtrip.test.ts).
 */
function allTypesFields(): PrismaFieldInput[] {
  return DATA_TYPE_HIERARCHY.filter((dt) => dt.id !== "reference").map((dt, i) => {
    const isDecimal = dt.id === "decimal" || dt.id === "decimal128";
    return {
      id: `f-${dt.id}`,
      name: `field_${dt.id}`,
      type: dt.id,
      precision: isDecimal ? 38 : null,
      scale: isDecimal ? 9 : null,
      nullable: i % 2 === 0,
      isKey: false,
      fieldNumber: i + 1,
      description: `A ${dt.id} field`,
      classification: null,
      // The generator reads inline enum members from the field aliases.
      aliases: dt.id === "enum" ? ["ALPHA", "BETA"] : [],
      decorators: decoratorsFor(dt.id),
      sortOrder: i,
    } satisfies PrismaFieldInput;
  });
}

const entity: PrismaEntityInput = {
  id: "ent-alltypes",
  name: "AllTypes",
  description: "Entity exercising every logical data type",
  status: "DRAFT",
  version: 1,
  domainId: "domain-1",
  metadata: {},
  domain: { id: "domain-1", name: "Sales", slug: "sales" },
};

const SCALAR_IDS = DATA_TYPE_HIERARCHY.map((t) => t.id).filter(
  (id) => !isComplexType(id) && id !== "enum"
);

function parseEmittedProto(result: OfficialTypeSpecTargetResult) {
  const parsed = parseProto(result.output, { keepCase: true });
  const message = parsed.root.lookupType("AllTypes") as ProtoType;
  return { parsed, message };
}

describe("protobuf target: every logical type emits a valid .proto", () => {
  const fields = allTypesFields();
  let result: OfficialTypeSpecTargetResult;

  beforeAll(async () => {
    result = await emitOfficialTypeSpecTargetFromData(entity, fields, "protobuf");
  }, EMIT_TIMEOUT_MS);

  it("compiles through the official @typespec/protobuf emitter", () => {
    expect(result.errors).toEqual([]);
    expect(result.validationStatus).toBe("VALID");
    expect(result.output).toContain('syntax = "proto3";');
  });

  it("emits syntactically valid proto3 containing every field", () => {
    const { message } = parseEmittedProto(result);
    for (const field of fields) {
      expect(message.fields[field.name], `missing ${field.name} in emitted message`).toBeDefined();
    }
  });

  it("emits, for every scalar/temporal type, exactly the documented protobuf mapping", () => {
    const { message } = parseEmittedProto(result);
    for (const id of SCALAR_IDS) {
      const documented = getDefaultMapping(id, "protobuf");
      expect(documented, `no protobuf entry for ${id} in the default mapping table`).toBeDefined();
      expect(message.fields[`field_${id}`]?.type, `field_${id}`).toBe(documented?.mappedType);
    }
  });

  it("uses google.protobuf well-known types for instants and durations", () => {
    expect(result.output).toContain('import "google/protobuf/timestamp.proto";');
    expect(result.output).toContain('import "google/protobuf/duration.proto";');
    expect(result.output).toContain("google.protobuf.Timestamp field_utcDateTime");
    expect(result.output).toContain("google.protobuf.Timestamp field_offsetDateTime");
    expect(result.output).toContain("google.protobuf.Timestamp field_unixTimestamp32");
    expect(result.output).toContain("google.protobuf.Duration field_duration");
  });

  it("uses google.type civil-time messages for dates and times of day", () => {
    expect(result.output).toContain('import "google/type/date.proto";');
    expect(result.output).toContain('import "google/type/timeofday.proto";');
    expect(result.output).toContain("google.type.Date field_plainDate");
    expect(result.output).toContain("google.type.TimeOfDay field_plainTime");
  });

  it("carries exact decimals as decimal text and widens small integers", () => {
    expect(result.output).toContain("string field_decimal = ");
    expect(result.output).toContain("string field_decimal128 = ");
    expect(result.output).toContain("string field_numeric = ");
    expect(result.output).toContain("int64 field_integer = ");
    expect(result.output).toContain("double field_float = ");
    expect(result.output).toContain("int32 field_int8 = ");
    expect(result.output).toContain("int32 field_int16 = ");
    expect(result.output).toContain("uint32 field_uint8 = ");
    expect(result.output).toContain("uint32 field_uint16 = ");
    expect(result.output).toContain("string field_url = ");
  });

  it("maps structured types: repeated, map<>, Struct and a zero-valued enum", () => {
    const { parsed, message } = parseEmittedProto(result);
    expect(message.fields.field_array.repeated).toBe(true);
    expect(message.fields.field_array.type).toBe("string");
    expect(result.output).toContain("map<string, string> field_map");
    expect(result.output).toContain('import "google/protobuf/struct.proto";');
    expect(message.fields.field_object.type).toBe("google.protobuf.Struct");

    const enumType = parsed.root.lookupEnum(message.fields.field_enum.type) as ProtoEnum;
    // proto3: the first enum value must be zero; AIP-126 / Buf name it <ENUM>_UNSPECIFIED.
    expect(enumType.values).toEqual({
      ALL_TYPES_FIELD_ENUM_UNSPECIFIED: 0,
      ALPHA: 1,
      BETA: 2,
    });
  });

  it("keeps field numbers from the model", () => {
    const { message } = parseEmittedProto(result);
    fields.forEach((field) => {
      expect(message.fields[field.name].id, field.name).toBe(field.fieldNumber);
    });
  });

  it("does not change the canonical TypeSpec used by every other target", () => {
    const canonical = generateTypeSpec(compileEntity(entity, fields));
    expect(canonical).toContain("field_utcDateTime?: utcDateTime;");
    expect(canonical).toContain("field_decimal?: decimal;");
    expect(canonical).toContain("field_map?: Record<string>;");
    expect(canonical).not.toContain("TypeSpec.Protobuf");
  });
});

function makeField(
  overrides: Partial<PrismaFieldInput> & Pick<PrismaFieldInput, "name" | "type" | "fieldNumber">
): PrismaFieldInput {
  return {
    id: `f-${overrides.name}`,
    precision: null,
    scale: null,
    nullable: false,
    isKey: false,
    description: "",
    classification: null,
    aliases: [],
    decorators: {},
    sortOrder: overrides.fieldNumber ?? 0,
    ...overrides,
  };
}

describe("protobuf target: substituted types inside containers, with constraints and defaults", () => {
  it(
    "substitutes element/value types, drops constraints and defaults the proto type cannot carry, and leaves look-alike names alone",
    async () => {
      const fields: PrismaFieldInput[] = [
        makeField({
          name: "price",
          type: "decimal",
          fieldNumber: 1,
          precision: 19,
          scale: 4,
          decorators: {
            typespec: {
              validation: { minValue: 0, maxValue: 1000000 },
              identity: { defaultValue: 0 },
            },
          },
        }),
        makeField({
          name: "occurredAt",
          type: "utcDateTime",
          fieldNumber: 2,
          decorators: { typespec: { wireFormat: { encode: "rfc3339" } } },
        }),
        makeField({
          name: "occurrences",
          type: "array",
          fieldNumber: 3,
          decorators: { arrayElementType: "utcDateTime" },
        }),
        makeField({
          name: "pricesBySku",
          type: "map",
          fieldNumber: 4,
          decorators: { mapKeyType: "string", mapValueType: "decimal" },
        }),
        // A property NAMED like a stdlib scalar, with a numeric constraint
        // that stays valid because its type (int32) is not substituted.
        makeField({
          name: "duration",
          type: "int32",
          fieldNumber: 5,
          decorators: { typespec: { validation: { minValue: 0 } } },
        }),
      ];

      const out = await emitOfficialTypeSpecTargetFromData(
        { ...entity, name: "PricedEvent" },
        fields,
        "protobuf"
      );

      expect(out.errors).toEqual([]);
      expect(out.validationStatus).toBe("VALID");
      expect(out.output).toContain("string price = 1;");
      expect(out.output).toContain("google.protobuf.Timestamp occurredAt = 2;");
      expect(out.output).toContain("repeated google.protobuf.Timestamp occurrences = 3;");
      expect(out.output).toContain("map<string, string> pricesBySku = 4;");
      expect(out.output).toContain("int32 duration = 5;");
      expect(() => parseProto(out.output, { keepCase: true })).not.toThrow();
    },
    EMIT_TIMEOUT_MS
  );
});
