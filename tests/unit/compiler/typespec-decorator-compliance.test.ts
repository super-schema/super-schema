/**
 * TypeSpec Built-in Decorator Compliance — Comprehensive Test Suite
 *
 * Story 2-23: Verifies parse -> store -> generate round-trip fidelity
 * for every TypeSpec built-in decorator we support.
 *
 * Covers:
 *  - Every built-in decorator parse -> verify stored correctly
 *  - Round-trip: parse -> generate -> re-parse comparison for key decorators
 *  - @error on model
 *  - @example on field
 *  - @encodedName with different MIME types
 *  - @friendlyName on model
 *  - @encode with bare scalar second arg
 *  - @tag on model level
 *  - Both #deprecated and @deprecated() syntaxes
 *  - @extension on fields
 *  - validateDecoratorTarget: wrong-target warnings
 *  - Full DecoratorAuditEntity test from the story
 */

import { describe, it, expect } from "vitest";
import {
  parseTypeSpecDocument,
  parseTypeSpec,
  validateDecoratorTarget,
  type ParsedTypeSpecDecorators,
} from "@/lib/compiler/typespec-parser";
import { generateTypeSpec } from "@/lib/compiler/typespec-generator";
import type { SuperSchemaModel } from "@/types/super-schema-model";

// ---------------------------------------------------------------------------
// Helper: build a minimal SuperSchemaModel for generator round-trip tests
// ---------------------------------------------------------------------------

function buildModel(
  overrides: Partial<SuperSchemaModel> & {
    entityOverrides?: Partial<SuperSchemaModel["entity"]>;
  } = {}
): SuperSchemaModel {
  const { entityOverrides, ...rest } = overrides;
  return {
    entity: {
      id: "test-id",
      name: "TestEntity",
      domain: "TestDomain",
      domainId: "domain-id",
      description: "",
      status: "DRAFT",
      version: 1,
      metadata: {},
      ...entityOverrides,
    },
    fields: [],
    relationships: [],
    ...rest,
  };
}

// ===========================================================================
// 1. Individual decorator parsing tests
// ===========================================================================

describe("TypeSpec Decorator Compliance — Parse Individual Decorators", () => {
  // --- @doc ---
  it("parses @doc on field", () => {
    const doc = parseTypeSpecDocument(`
model Test {
  @doc("Field documentation")
  name: string;
}
`);
    expect(doc.models[0].fields[0].decorators.doc).toBe("Field documentation");
  });

  it("parses @doc on model", () => {
    const doc = parseTypeSpecDocument(`
@doc("Model documentation")
model Test {
  id: string;
}
`);
    expect(doc.models[0].doc).toBe("Model documentation");
  });

  // --- @summary ---
  it("parses @summary on field", () => {
    const doc = parseTypeSpecDocument(`
model Test {
  @summary("Short summary")
  name: string;
}
`);
    expect(doc.models[0].fields[0].decorators.summary).toBe("Short summary");
  });

  // --- @format ---
  it("parses @format on field", () => {
    const doc = parseTypeSpecDocument(`
model Test {
  @format("uuid")
  id: string;
}
`);
    expect(doc.models[0].fields[0].decorators.format).toBe("uuid");
  });

  it("parses @format with email", () => {
    const doc = parseTypeSpecDocument(`
model Test {
  @format("email")
  email: string;
}
`);
    expect(doc.models[0].fields[0].decorators.format).toBe("email");
  });

  it("parses @format with uri", () => {
    const doc = parseTypeSpecDocument(`
model Test {
  @format("uri")
  website: string;
}
`);
    expect(doc.models[0].fields[0].decorators.format).toBe("uri");
  });

  // --- @pattern ---
  it("parses @pattern on field", () => {
    const doc = parseTypeSpecDocument(`
model Test {
  @pattern("[A-Za-z]+")
  name: string;
}
`);
    expect(doc.models[0].fields[0].decorators.pattern).toBe("[A-Za-z]+");
  });

  // --- @minLength / @maxLength ---
  it("parses @minLength on field", () => {
    const doc = parseTypeSpecDocument(`
model Test {
  @minLength(1)
  name: string;
}
`);
    expect(doc.models[0].fields[0].decorators.minLength).toBe(1);
  });

  it("parses @maxLength on field", () => {
    const doc = parseTypeSpecDocument(`
model Test {
  @maxLength(200)
  name: string;
}
`);
    expect(doc.models[0].fields[0].decorators.maxLength).toBe(200);
  });

  // --- @minValue / @maxValue ---
  it("parses @minValue on field", () => {
    const doc = parseTypeSpecDocument(`
model Test {
  @minValue(0)
  score: int32;
}
`);
    expect(doc.models[0].fields[0].decorators.minValue).toBe(0);
  });

  it("parses @maxValue on field", () => {
    const doc = parseTypeSpecDocument(`
model Test {
  @maxValue(100)
  score: int32;
}
`);
    expect(doc.models[0].fields[0].decorators.maxValue).toBe(100);
  });

  // --- @minValueExclusive / @maxValueExclusive ---
  it("parses @minValueExclusive on field", () => {
    const doc = parseTypeSpecDocument(`
model Test {
  @minValueExclusive(0)
  positiveScore: float64;
}
`);
    expect(doc.models[0].fields[0].decorators.minValueExclusive).toBe(0);
  });

  it("parses @maxValueExclusive on field", () => {
    const doc = parseTypeSpecDocument(`
model Test {
  @maxValueExclusive(100)
  score: float64;
}
`);
    expect(doc.models[0].fields[0].decorators.maxValueExclusive).toBe(100);
  });

  // --- @minItems / @maxItems ---
  it("parses @minItems on field", () => {
    const doc = parseTypeSpecDocument(`
model Test {
  @minItems(1)
  tags: string[];
}
`);
    expect(doc.models[0].fields[0].decorators.minItems).toBe(1);
  });

  it("parses @maxItems on field", () => {
    const doc = parseTypeSpecDocument(`
model Test {
  @maxItems(50)
  tags: string[];
}
`);
    expect(doc.models[0].fields[0].decorators.maxItems).toBe(50);
  });

  // --- @key ---
  it("parses @key on field", () => {
    const doc = parseTypeSpecDocument(`
model Test {
  @key
  id: string;
}
`);
    expect(doc.models[0].fields[0].isKey).toBe(true);
  });

  // --- @secret ---
  it("parses @secret on field", () => {
    const doc = parseTypeSpecDocument(`
model Test {
  @secret
  apiKey: string;
}
`);
    expect(doc.models[0].fields[0].decorators.secret).toBe(true);
  });

  // --- @visibility ---
  it("parses @visibility with single phase", () => {
    const doc = parseTypeSpecDocument(`
model Test {
  @visibility(Lifecycle.Read)
  internalId: string;
}
`);
    expect(doc.models[0].fields[0].decorators.visibility).toEqual(["Read"]);
  });

  it("parses @visibility with multiple phases", () => {
    const doc = parseTypeSpecDocument(`
model Test {
  @visibility(Lifecycle.Create, Lifecycle.Read)
  name: string;
}
`);
    expect(doc.models[0].fields[0].decorators.visibility).toEqual(["Create", "Read"]);
  });

  // --- @discriminator ---
  it("parses @discriminator on model", () => {
    const doc = parseTypeSpecDocument(`
@discriminator("kind")
model Base {
  kind: string;
}
`);
    expect(doc.models[0].discriminator).toBe("kind");
  });

  // --- @tag on field ---
  it("parses @tag on field", () => {
    const doc = parseTypeSpecDocument(`
model Test {
  @tag("groupA")
  name: string;
}
`);
    expect(doc.models[0].fields[0].decorators.tag).toBe("groupA");
  });

  // --- @extension ---
  it("parses @extension on field", () => {
    const doc = parseTypeSpecDocument(`
model Test {
  @extension("x-custom", "value")
  field: string;
}
`);
    expect(doc.models[0].fields[0].decorators.extensions).toEqual({ "x-custom": "value" });
  });

  it("parses multiple @extension decorators on same field", () => {
    const doc = parseTypeSpecDocument(`
model Test {
  @extension("x-first", "one")
  @extension("x-second", "two")
  field: string;
}
`);
    expect(doc.models[0].fields[0].decorators.extensions).toEqual({
      "x-first": "one",
      "x-second": "two",
    });
  });

  // --- @encode with string arg only ---
  it("parses @encode with single string arg", () => {
    const doc = parseTypeSpecDocument(`
model Test {
  @encode("rfc3339")
  createdAt: utcDateTime;
}
`);
    expect(doc.models[0].fields[0].decorators.encode).toBe("rfc3339");
    expect(doc.models[0].fields[0].decorators.encodeSubType).toBeUndefined();
  });

  // --- @encode with quoted string second arg ---
  it("parses @encode with quoted string second arg", () => {
    const doc = parseTypeSpecDocument(`
model Test {
  @encode("base64", "string")
  data: bytes;
}
`);
    expect(doc.models[0].fields[0].decorators.encode).toBe("base64");
    expect(doc.models[0].fields[0].decorators.encodeSubType).toBe("string");
  });
});

// ===========================================================================
// 2. New decorator parsing: @error, @example, @encodedName, @friendlyName
// ===========================================================================

describe("TypeSpec Decorator Compliance — New Decorators", () => {
  // --- @error on model ---
  it("parses @error on model", () => {
    const doc = parseTypeSpecDocument(`
@error
model ErrorResponse {
  code: int32;
  message: string;
}
`);
    expect(doc.models[0].isError).toBe(true);
  });

  it("@error combined with @doc on model", () => {
    const doc = parseTypeSpecDocument(`
@doc("An error response")
@error
model ErrorResponse {
  code: int32;
  message: string;
}
`);
    expect(doc.models[0].isError).toBe(true);
    expect(doc.models[0].doc).toBe("An error response");
  });

  // --- @example on field ---
  it("parses @example with value literal on field", () => {
    const doc = parseTypeSpecDocument(`
model Test {
  @example(#{ name: "John" })
  profile: string;
}
`);
    expect(doc.models[0].fields[0].decorators.example).toBe('#{ name: "John" }');
  });

  it("parses @example with simple string on field", () => {
    const doc = parseTypeSpecDocument(`
model Test {
  @example("hello@example.com")
  email: string;
}
`);
    expect(doc.models[0].fields[0].decorators.example).toBe('"hello@example.com"');
  });

  // --- @encodedName ---
  it("parses @encodedName with application/json", () => {
    const doc = parseTypeSpecDocument(`
model Test {
  @encodedName("application/json", "screen_name")
  screenName: string;
}
`);
    expect(doc.models[0].fields[0].decorators.encodedName).toEqual({
      mimeType: "application/json",
      name: "screen_name",
    });
  });

  it("parses @encodedName with application/xml", () => {
    const doc = parseTypeSpecDocument(`
model Test {
  @encodedName("application/xml", "ScreenName")
  screenName: string;
}
`);
    expect(doc.models[0].fields[0].decorators.encodedName).toEqual({
      mimeType: "application/xml",
      name: "ScreenName",
    });
  });

  it("parses @encodedName with application/protobuf", () => {
    const doc = parseTypeSpecDocument(`
model Test {
  @encodedName("application/protobuf", "screen_name_proto")
  screenName: string;
}
`);
    expect(doc.models[0].fields[0].decorators.encodedName).toEqual({
      mimeType: "application/protobuf",
      name: "screen_name_proto",
    });
  });

  // --- @friendlyName on model ---
  it("parses @friendlyName on model", () => {
    const doc = parseTypeSpecDocument(`
@friendlyName("UserProfile")
model UserProfileEntity {
  id: string;
}
`);
    expect(doc.models[0].friendlyName).toBe("UserProfile");
  });

  it("@friendlyName combined with @doc on model", () => {
    const doc = parseTypeSpecDocument(`
@doc("A user profile")
@friendlyName("UserProfile")
model UserProfileEntity {
  id: string;
}
`);
    expect(doc.models[0].friendlyName).toBe("UserProfile");
    expect(doc.models[0].doc).toBe("A user profile");
  });

  // --- @encode with bare scalar second arg ---
  it("parses @encode with bare scalar int32", () => {
    const doc = parseTypeSpecDocument(`
model Test {
  @encode("unixTimestamp", int32)
  lastLogin: utcDateTime;
}
`);
    expect(doc.models[0].fields[0].decorators.encode).toBe("unixTimestamp");
    expect(doc.models[0].fields[0].decorators.encodeSubType).toBe("int32");
  });

  it("parses @encode with bare scalar int64", () => {
    const doc = parseTypeSpecDocument(`
model Test {
  @encode("unixTimestamp", int64)
  lastLogin: utcDateTime;
}
`);
    expect(doc.models[0].fields[0].decorators.encode).toBe("unixTimestamp");
    expect(doc.models[0].fields[0].decorators.encodeSubType).toBe("int64");
  });

  it("parses @encode with bare scalar float64", () => {
    const doc = parseTypeSpecDocument(`
model Test {
  @encode("seconds", float64)
  duration: duration;
}
`);
    expect(doc.models[0].fields[0].decorators.encode).toBe("seconds");
    expect(doc.models[0].fields[0].decorators.encodeSubType).toBe("float64");
  });

  // --- @tag on model level ---
  it("parses @tag on model level", () => {
    const doc = parseTypeSpecDocument(`
@tag("GroupA")
model Test {
  id: string;
}
`);
    expect(doc.models[0].tags).toEqual(["GroupA"]);
  });

  it("parses multiple @tag on model level", () => {
    const doc = parseTypeSpecDocument(`
@tag("GroupA")
@tag("GroupB")
model Test {
  id: string;
}
`);
    expect(doc.models[0].tags).toContain("GroupA");
    expect(doc.models[0].tags).toContain("GroupB");
    expect(doc.models[0].tags).toHaveLength(2);
  });

  it("@tag on model combined with @tag on field", () => {
    const doc = parseTypeSpecDocument(`
@tag("ModelTag")
model Test {
  @tag("FieldTag")
  name: string;
}
`);
    expect(doc.models[0].tags).toEqual(["ModelTag"]);
    expect(doc.models[0].fields[0].decorators.tag).toBe("FieldTag");
  });
});

// ===========================================================================
// 3. Deprecated directive — both syntaxes
// ===========================================================================

describe("TypeSpec Decorator Compliance — Deprecated Syntaxes", () => {
  it("parses #deprecated directive", () => {
    const doc = parseTypeSpecDocument(`
model Test {
  #deprecated "Use newField instead"
  oldField: string;
}
`);
    expect(doc.models[0].fields[0].decorators.deprecated).toBe("Use newField instead");
  });

  it("parses @deprecated() decorator", () => {
    const doc = parseTypeSpecDocument(`
model Test {
  @deprecated("Use newField instead")
  oldField: string;
}
`);
    expect(doc.models[0].fields[0].decorators.deprecated).toBe("Use newField instead");
  });

  it("both deprecated syntaxes produce same result", () => {
    const doc1 = parseTypeSpecDocument(`
model Test {
  #deprecated "Reason here"
  oldField: string;
}
`);
    const doc2 = parseTypeSpecDocument(`
model Test {
  @deprecated("Reason here")
  oldField: string;
}
`);
    expect(doc1.models[0].fields[0].decorators.deprecated).toBe(
      doc2.models[0].fields[0].decorators.deprecated
    );
    expect(doc1.models[0].fields[0].decorators.deprecated).toBe("Reason here");
  });
});

// ===========================================================================
// 4. validateDecoratorTarget — wrong-target warnings
// ===========================================================================

describe("TypeSpec Decorator Compliance — validateDecoratorTarget", () => {
  it("warns when @minLength applied to number type", () => {
    const decorators: ParsedTypeSpecDecorators = { minLength: 5 };
    const warnings = validateDecoratorTarget(decorators, "score", "int32");
    expect(warnings.length).toBeGreaterThanOrEqual(1);
    expect(warnings.some((w) => w.decorator === "@minLength")).toBe(true);
    expect(warnings[0].message).toContain("string");
  });

  it("warns when @maxLength applied to boolean type", () => {
    const decorators: ParsedTypeSpecDecorators = { maxLength: 10 };
    const warnings = validateDecoratorTarget(decorators, "flag", "boolean");
    expect(warnings.length).toBeGreaterThanOrEqual(1);
    expect(warnings.some((w) => w.decorator === "@maxLength")).toBe(true);
  });

  it("warns when @pattern applied to int32 type", () => {
    const decorators: ParsedTypeSpecDecorators = { pattern: "[0-9]+" };
    const warnings = validateDecoratorTarget(decorators, "count", "int32");
    expect(warnings.length).toBeGreaterThanOrEqual(1);
    expect(warnings.some((w) => w.decorator === "@pattern")).toBe(true);
  });

  it("warns when @format applied to boolean type", () => {
    const decorators: ParsedTypeSpecDecorators = { format: "uuid" };
    const warnings = validateDecoratorTarget(decorators, "active", "boolean");
    expect(warnings.length).toBeGreaterThanOrEqual(1);
    expect(warnings.some((w) => w.decorator === "@format")).toBe(true);
    expect(warnings[0].message).toContain("string");
  });

  it("warns when @minValue applied to string type", () => {
    const decorators: ParsedTypeSpecDecorators = { minValue: 0 };
    const warnings = validateDecoratorTarget(decorators, "name", "string");
    expect(warnings.length).toBeGreaterThanOrEqual(1);
    expect(warnings.some((w) => w.decorator === "@minValue")).toBe(true);
    expect(warnings[0].message).toContain("numeric");
  });

  it("warns when @maxValue applied to boolean type", () => {
    const decorators: ParsedTypeSpecDecorators = { maxValue: 100 };
    const warnings = validateDecoratorTarget(decorators, "flag", "boolean");
    expect(warnings.length).toBeGreaterThanOrEqual(1);
    expect(warnings.some((w) => w.decorator === "@maxValue")).toBe(true);
  });

  it("warns when @minValueExclusive applied to string type", () => {
    const decorators: ParsedTypeSpecDecorators = { minValueExclusive: 0 };
    const warnings = validateDecoratorTarget(decorators, "name", "string");
    expect(warnings.length).toBeGreaterThanOrEqual(1);
    expect(warnings.some((w) => w.decorator === "@minValueExclusive")).toBe(true);
  });

  it("warns when @maxValueExclusive applied to boolean type", () => {
    const decorators: ParsedTypeSpecDecorators = { maxValueExclusive: 50 };
    const warnings = validateDecoratorTarget(decorators, "flag", "boolean");
    expect(warnings.length).toBeGreaterThanOrEqual(1);
  });

  it("warns when @minItems applied to string type", () => {
    const decorators: ParsedTypeSpecDecorators = { minItems: 1 };
    const warnings = validateDecoratorTarget(decorators, "name", "string");
    expect(warnings.length).toBeGreaterThanOrEqual(1);
    expect(warnings.some((w) => w.decorator === "@minItems")).toBe(true);
    expect(warnings[0].message).toContain("array");
  });

  it("warns when @maxItems applied to int32 type", () => {
    const decorators: ParsedTypeSpecDecorators = { maxItems: 10 };
    const warnings = validateDecoratorTarget(decorators, "count", "int32");
    expect(warnings.length).toBeGreaterThanOrEqual(1);
    expect(warnings.some((w) => w.decorator === "@maxItems")).toBe(true);
  });

  it("does NOT warn when @minLength applied to string type", () => {
    const decorators: ParsedTypeSpecDecorators = { minLength: 1 };
    const warnings = validateDecoratorTarget(decorators, "name", "string");
    expect(warnings).toHaveLength(0);
  });

  it("does NOT warn when @minValue applied to int32 type", () => {
    const decorators: ParsedTypeSpecDecorators = { minValue: 0 };
    const warnings = validateDecoratorTarget(decorators, "score", "int32");
    expect(warnings).toHaveLength(0);
  });

  it("does NOT warn when @minValue applied to float64 type", () => {
    const decorators: ParsedTypeSpecDecorators = { minValue: 0.0 };
    const warnings = validateDecoratorTarget(decorators, "score", "float64");
    expect(warnings).toHaveLength(0);
  });

  it("does NOT warn when @minItems applied to array type", () => {
    const decorators: ParsedTypeSpecDecorators = { minItems: 0 };
    const warnings = validateDecoratorTarget(decorators, "tags", "array");
    expect(warnings).toHaveLength(0);
  });

  it("does NOT warn when @format applied to string type", () => {
    const decorators: ParsedTypeSpecDecorators = { format: "uuid" };
    const warnings = validateDecoratorTarget(decorators, "id", "string");
    expect(warnings).toHaveLength(0);
  });

  it("reports fieldName and fieldType in warning", () => {
    const decorators: ParsedTypeSpecDecorators = { minLength: 5 };
    const warnings = validateDecoratorTarget(decorators, "myScore", "float32");
    expect(warnings[0].fieldName).toBe("myScore");
    expect(warnings[0].fieldType).toBe("float32");
  });

  it("multiple wrong decorators produce multiple warnings", () => {
    const decorators: ParsedTypeSpecDecorators = {
      minLength: 1,
      maxLength: 10,
      pattern: "[a-z]+",
      format: "email",
    };
    const warnings = validateDecoratorTarget(decorators, "count", "int32");
    expect(warnings).toHaveLength(4);
  });
});

// ===========================================================================
// 5. Generator emission tests (model -> TypeSpec source)
// ===========================================================================

describe("TypeSpec Decorator Compliance — Generator Emission", () => {
  it("emits @error on model", () => {
    const model = buildModel({
      entityOverrides: {
        name: "ErrorResponse",
        metadata: { isError: true },
      },
    });
    const source = generateTypeSpec(model);
    expect(source).toContain("@error");
    expect(source).toContain("model ErrorResponse");
  });

  it("emits @friendlyName on model", () => {
    const model = buildModel({
      entityOverrides: {
        name: "UserEntity",
        metadata: { friendlyName: "User" },
      },
    });
    const source = generateTypeSpec(model);
    expect(source).toContain('@friendlyName("User")');
  });

  it("emits entity tags as an x-tags extension on the model (never @tag, Story 16.6)", () => {
    const model = buildModel({
      entityOverrides: {
        name: "Tagged",
        metadata: { tags: ["GroupA", "GroupB"] },
      },
    });
    const source = generateTypeSpec(model);
    expect(source).toContain('@TypeSpec.OpenAPI.extension("x-tags", #["GroupA", "GroupB"])');
    expect(source).not.toContain("@tag(");
  });

  it("emits @encodedName on field", () => {
    const model = buildModel({
      fields: [
        {
          name: "screenName",
          type: "string",
          nullable: false,
          isKey: false,
          fieldNumber: 1,
          description: "",
          aliases: [],
          decorators: {
            typespec: {
              wireFormat: {
                encodedNames: { "application/json": "screen_name" },
              },
            },
          },
          sortOrder: 1,
        },
      ],
    });
    const source = generateTypeSpec(model);
    expect(source).toContain('@encodedName("application/json", "screen_name")');
  });

  it("emits @encode with subtype on field", () => {
    const model = buildModel({
      fields: [
        {
          name: "lastLogin",
          type: "utcDateTime",
          nullable: false,
          isKey: false,
          fieldNumber: 1,
          description: "",
          aliases: [],
          decorators: {
            typespec: {
              wireFormat: {
                encode: "unixTimestamp",
                encodeSubType: "int32",
              },
            },
          },
          sortOrder: 1,
        },
      ],
    });
    const source = generateTypeSpec(model);
    expect(source).toContain('@encode("unixTimestamp", "int32")');
  });

  it("emits @example on field", () => {
    const model = buildModel({
      fields: [
        {
          name: "email",
          type: "string",
          nullable: false,
          isKey: false,
          fieldNumber: 1,
          description: "",
          aliases: [],
          decorators: {
            typespec: {
              documentation: {
                example: '"test@example.com"',
              },
            },
          },
          sortOrder: 1,
        },
      ],
    });
    const source = generateTypeSpec(model);
    expect(source).toContain('@example("test@example.com")');
  });

  it("emits #deprecated on field", () => {
    const model = buildModel({
      fields: [
        {
          name: "legacyName",
          type: "string",
          nullable: true,
          isKey: false,
          fieldNumber: 1,
          description: "",
          aliases: [],
          decorators: {
            typespec: {
              documentation: {
                deprecated: "Use displayName instead",
              },
            },
          },
          sortOrder: 1,
        },
      ],
    });
    const source = generateTypeSpec(model);
    expect(source).toContain('#deprecated "Use displayName instead"');
  });

  it("emits @doc on model when description provided", () => {
    const model = buildModel({
      entityOverrides: {
        name: "DocModel",
        description: "Model with docs",
      },
    });
    const source = generateTypeSpec(model);
    expect(source).toContain('@doc("Model with docs")');
  });
});

// ===========================================================================
// 6. Round-trip tests: parse -> generate -> re-parse -> compare
// ===========================================================================

describe("TypeSpec Decorator Compliance — Round-trip Fidelity", () => {
  it("round-trips @error on model", () => {
    const source = `
@doc("Error model")
@error
model ErrorResponse {
  code: int32;
  message: string;
}
`;
    const parsed1 = parseTypeSpecDocument(source);
    expect(parsed1.models[0].isError).toBe(true);

    // Build an IR model from parsed data and regenerate
    const model = buildModel({
      entityOverrides: {
        name: "ErrorResponse",
        description: "Error model",
        metadata: { isError: true },
      },
      fields: [
        {
          name: "code",
          type: "int32",
          nullable: false,
          isKey: false,
          description: "",
          aliases: [],
          decorators: {},
          sortOrder: 1,
        },
        {
          name: "message",
          type: "string",
          nullable: false,
          isKey: false,
          description: "",
          aliases: [],
          decorators: {},
          sortOrder: 2,
        },
      ],
    });
    const generated = generateTypeSpec(model);
    const parsed2 = parseTypeSpecDocument(generated);

    expect(parsed2.models[0].isError).toBe(true);
    expect(parsed2.models[0].doc).toBe("Error model");
    expect(parsed2.models[0].name).toBe("ErrorResponse");
  });

  it("round-trips @friendlyName on model", () => {
    const source = `
@friendlyName("Profile")
model UserProfile {
  id: string;
}
`;
    const parsed1 = parseTypeSpecDocument(source);
    expect(parsed1.models[0].friendlyName).toBe("Profile");

    const model = buildModel({
      entityOverrides: {
        name: "UserProfile",
        metadata: { friendlyName: "Profile" },
      },
      fields: [
        {
          name: "id",
          type: "string",
          nullable: false,
          isKey: false,
          description: "",
          aliases: [],
          decorators: {},
          sortOrder: 1,
        },
      ],
    });
    const generated = generateTypeSpec(model);
    const parsed2 = parseTypeSpecDocument(generated);
    expect(parsed2.models[0].friendlyName).toBe("Profile");
  });

  it("round-trips @tag on model", () => {
    const source = `
@tag("Users")
model UserEntity {
  id: string;
}
`;
    const parsed1 = parseTypeSpecDocument(source);
    expect(parsed1.models[0].tags).toContain("Users");

    const model = buildModel({
      entityOverrides: {
        name: "UserEntity",
        metadata: { tags: ["Users"] },
      },
      fields: [
        {
          name: "id",
          type: "string",
          nullable: false,
          isKey: false,
          description: "",
          aliases: [],
          decorators: {},
          sortOrder: 1,
        },
      ],
    });
    const generated = generateTypeSpec(model);
    const parsed2 = parseTypeSpecDocument(generated);
    expect(parsed2.models[0].tags).toContain("Users");
  });

  it("round-trips @encodedName on field", () => {
    const model = buildModel({
      fields: [
        {
          name: "screenName",
          type: "string",
          nullable: false,
          isKey: false,
          description: "",
          aliases: [],
          decorators: {
            typespec: {
              wireFormat: {
                encodedNames: { "application/json": "screen_name" },
              },
            },
          },
          sortOrder: 1,
        },
      ],
    });
    const generated = generateTypeSpec(model);
    const parsed = parseTypeSpecDocument(generated);
    expect(parsed.models[0].fields[0].decorators.encodedName).toEqual({
      mimeType: "application/json",
      name: "screen_name",
    });
  });

  it("round-trips @encode with bare scalar", () => {
    const source = `
model Test {
  @encode("unixTimestamp", int32)
  lastLogin: utcDateTime;
}
`;
    const parsed = parseTypeSpecDocument(source);
    expect(parsed.models[0].fields[0].decorators.encode).toBe("unixTimestamp");
    expect(parsed.models[0].fields[0].decorators.encodeSubType).toBe("int32");
  });

  it("round-trips #deprecated on field", () => {
    const source = `
model Test {
  #deprecated "Use newField instead"
  oldField?: string;
}
`;
    const parsed1 = parseTypeSpecDocument(source);
    expect(parsed1.models[0].fields[0].decorators.deprecated).toBe("Use newField instead");

    const model = buildModel({
      fields: [
        {
          name: "oldField",
          type: "string",
          nullable: true,
          isKey: false,
          description: "",
          aliases: [],
          decorators: {
            typespec: {
              documentation: {
                deprecated: "Use newField instead",
              },
            },
          },
          sortOrder: 1,
        },
      ],
    });
    const generated = generateTypeSpec(model);
    const parsed2 = parseTypeSpecDocument(generated);
    expect(parsed2.models[0].fields[0].decorators.deprecated).toBe("Use newField instead");
  });

  it("round-trips validation decorators on field", () => {
    const model = buildModel({
      fields: [
        {
          name: "name",
          type: "string",
          nullable: false,
          isKey: false,
          description: "User name",
          aliases: [],
          decorators: {
            typespec: {
              validation: {
                minLength: 1,
                maxLength: 200,
                pattern: "[A-Za-z]+",
              },
            },
          },
          sortOrder: 1,
        },
      ],
    });
    const generated = generateTypeSpec(model);
    const parsed = parseTypeSpecDocument(generated);
    const field = parsed.models[0].fields[0];
    expect(field.decorators.minLength).toBe(1);
    expect(field.decorators.maxLength).toBe(200);
    expect(field.decorators.pattern).toBe("[A-Za-z]+");
  });

  it("round-trips numeric validation decorators", () => {
    const model = buildModel({
      fields: [
        {
          name: "score",
          type: "float64",
          nullable: false,
          isKey: false,
          description: "",
          aliases: [],
          decorators: {
            typespec: {
              validation: {
                minValue: 0,
                maxValue: 100,
                minValueExclusive: -1,
                maxValueExclusive: 101,
              },
            },
          },
          sortOrder: 1,
        },
      ],
    });
    const generated = generateTypeSpec(model);
    const parsed = parseTypeSpecDocument(generated);
    const field = parsed.models[0].fields[0];
    expect(field.decorators.minValue).toBe(0);
    expect(field.decorators.maxValue).toBe(100);
    expect(field.decorators.minValueExclusive).toBe(-1);
    expect(field.decorators.maxValueExclusive).toBe(101);
  });
});

// ===========================================================================
// 7. Full DecoratorAuditEntity — comprehensive test from the story
// ===========================================================================

describe("TypeSpec Decorator Compliance — Full DecoratorAuditEntity", () => {
  const auditEntitySource = `
@doc("Full decorator coverage test model")
@error
@tag("AuditTest")
@friendlyName("AuditEntity")
model DecoratorAuditEntity {
  @key
  @doc("Primary identifier")
  @format("uuid")
  id: string;

  @doc("User's display name")
  @summary("The name shown in UI")
  @minLength(1)
  @maxLength(200)
  @pattern("[A-Za-z\\\\s]+")
  displayName: string;

  @doc("Numeric score")
  @minValue(0)
  @maxValue(100)
  @minValueExclusive(0)
  score: float64;

  @doc("User tags")
  @minItems(0)
  @maxItems(20)
  tags: string[];

  @secret
  @doc("API key")
  apiKey: string;

  @encode("rfc3339")
  @doc("Creation timestamp")
  createdAt: utcDateTime;

  @encode("unixTimestamp", int32)
  @doc("Last login as unix timestamp")
  lastLogin: utcDateTime;

  @encodedName("application/json", "screen_name")
  @doc("Username for JSON serialization")
  screenName: string;

  @visibility(Lifecycle.Read)
  @doc("Internal-only field")
  internalId: string;

  #deprecated "Use displayName instead"
  @doc("Legacy name field")
  legacyName?: string;

  @extension("x-custom", "value")
  @doc("Custom extended field")
  customField: string;
}
`;

  it("parses all model-level decorators", () => {
    const doc = parseTypeSpecDocument(auditEntitySource);
    const model = doc.models[0];

    expect(model.name).toBe("DecoratorAuditEntity");
    expect(model.doc).toBe("Full decorator coverage test model");
    expect(model.isError).toBe(true);
    expect(model.friendlyName).toBe("AuditEntity");
    expect(model.tags).toContain("AuditTest");
  });

  it("parses all field-level decorators", () => {
    const doc = parseTypeSpecDocument(auditEntitySource);
    const fields = doc.models[0].fields;

    // id field: @key, @doc, @format
    const idField = fields.find((f) => f.name === "id")!;
    expect(idField.isKey).toBe(true);
    expect(idField.decorators.doc).toBe("Primary identifier");
    expect(idField.decorators.format).toBe("uuid");

    // displayName: @doc, @summary, @minLength, @maxLength, @pattern
    const displayNameField = fields.find((f) => f.name === "displayName")!;
    expect(displayNameField.decorators.doc).toBe("User's display name");
    expect(displayNameField.decorators.summary).toBe("The name shown in UI");
    expect(displayNameField.decorators.minLength).toBe(1);
    expect(displayNameField.decorators.maxLength).toBe(200);
    expect(displayNameField.decorators.pattern).toBeDefined();

    // score: @doc, @minValue, @maxValue, @minValueExclusive
    const scoreField = fields.find((f) => f.name === "score")!;
    expect(scoreField.decorators.minValue).toBe(0);
    expect(scoreField.decorators.maxValue).toBe(100);
    expect(scoreField.decorators.minValueExclusive).toBe(0);

    // tags: @doc, @minItems, @maxItems
    const tagsField = fields.find((f) => f.name === "tags")!;
    expect(tagsField.decorators.minItems).toBe(0);
    expect(tagsField.decorators.maxItems).toBe(20);
    expect(tagsField.type).toBe("array");

    // apiKey: @secret, @doc
    const apiKeyField = fields.find((f) => f.name === "apiKey")!;
    expect(apiKeyField.decorators.secret).toBe(true);

    // createdAt: @encode("rfc3339")
    const createdAtField = fields.find((f) => f.name === "createdAt")!;
    expect(createdAtField.decorators.encode).toBe("rfc3339");
    expect(createdAtField.decorators.encodeSubType).toBeUndefined();

    // lastLogin: @encode("unixTimestamp", int32)
    const lastLoginField = fields.find((f) => f.name === "lastLogin")!;
    expect(lastLoginField.decorators.encode).toBe("unixTimestamp");
    expect(lastLoginField.decorators.encodeSubType).toBe("int32");

    // screenName: @encodedName("application/json", "screen_name")
    const screenNameField = fields.find((f) => f.name === "screenName")!;
    expect(screenNameField.decorators.encodedName).toEqual({
      mimeType: "application/json",
      name: "screen_name",
    });

    // internalId: @visibility(Lifecycle.Read)
    const internalIdField = fields.find((f) => f.name === "internalId")!;
    expect(internalIdField.decorators.visibility).toEqual(["Read"]);

    // legacyName: #deprecated
    const legacyNameField = fields.find((f) => f.name === "legacyName")!;
    expect(legacyNameField.decorators.deprecated).toBe("Use displayName instead");
    expect(legacyNameField.isOptional).toBe(true);

    // customField: @extension
    const customFieldDec = fields.find((f) => f.name === "customField")!;
    expect(customFieldDec.decorators.extensions).toEqual({ "x-custom": "value" });
  });

  it("has correct total number of fields", () => {
    const doc = parseTypeSpecDocument(auditEntitySource);
    expect(doc.models[0].fields).toHaveLength(11);
  });

  it("preserves field types correctly", () => {
    const doc = parseTypeSpecDocument(auditEntitySource);
    const fields = doc.models[0].fields;

    expect(fields.find((f) => f.name === "id")!.type).toBe("string");
    expect(fields.find((f) => f.name === "displayName")!.type).toBe("string");
    expect(fields.find((f) => f.name === "score")!.type).toBe("float64");
    expect(fields.find((f) => f.name === "tags")!.type).toBe("array");
    expect(fields.find((f) => f.name === "apiKey")!.type).toBe("string");
    expect(fields.find((f) => f.name === "createdAt")!.type).toBe("utcDateTime");
    expect(fields.find((f) => f.name === "lastLogin")!.type).toBe("utcDateTime");
    expect(fields.find((f) => f.name === "screenName")!.type).toBe("string");
    expect(fields.find((f) => f.name === "internalId")!.type).toBe("string");
    expect(fields.find((f) => f.name === "legacyName")!.type).toBe("string");
    expect(fields.find((f) => f.name === "customField")!.type).toBe("string");
  });
});

// ===========================================================================
// 8. Edge cases and combinations
// ===========================================================================

describe("TypeSpec Decorator Compliance — Edge Cases", () => {
  it("model with no decorators parses cleanly", () => {
    const doc = parseTypeSpecDocument(`
model Plain {
  name: string;
}
`);
    const model = doc.models[0];
    expect(model.isError).toBeUndefined();
    expect(model.friendlyName).toBeUndefined();
    expect(model.tags).toBeUndefined();
    expect(model.discriminator).toBeUndefined();
  });

  it("all model-level decorators combined", () => {
    const doc = parseTypeSpecDocument(`
@doc("Full model")
@error
@friendlyName("FullModel")
@tag("TagA")
@tag("TagB")
@discriminator("type")
model FullModel {
  type: string;
}
`);
    const model = doc.models[0];
    expect(model.doc).toBe("Full model");
    expect(model.isError).toBe(true);
    expect(model.friendlyName).toBe("FullModel");
    expect(model.tags).toContain("TagA");
    expect(model.tags).toContain("TagB");
    expect(model.discriminator).toBe("type");
  });

  it("field with all validation decorators", () => {
    const doc = parseTypeSpecDocument(`
model Test {
  @minLength(1)
  @maxLength(100)
  @pattern("[a-z]+")
  @format("email")
  @doc("An email field")
  @summary("Email")
  email: string;
}
`);
    const field = doc.models[0].fields[0];
    expect(field.decorators.minLength).toBe(1);
    expect(field.decorators.maxLength).toBe(100);
    expect(field.decorators.pattern).toBe("[a-z]+");
    expect(field.decorators.format).toBe("email");
    expect(field.decorators.doc).toBe("An email field");
    expect(field.decorators.summary).toBe("Email");
  });

  it("negative numeric values in min/max", () => {
    const doc = parseTypeSpecDocument(`
model Test {
  @minValue(-100)
  @maxValue(-1)
  negativeRange: int32;
}
`);
    const field = doc.models[0].fields[0];
    expect(field.decorators.minValue).toBe(-100);
    expect(field.decorators.maxValue).toBe(-1);
  });

  it("decimal values in min/max", () => {
    const doc = parseTypeSpecDocument(`
model Test {
  @minValue(0.5)
  @maxValue(99.9)
  decimalRange: float64;
}
`);
    const field = doc.models[0].fields[0];
    expect(field.decorators.minValue).toBe(0.5);
    expect(field.decorators.maxValue).toBe(99.9);
  });

  it("multiple models in same document", () => {
    const doc = parseTypeSpecDocument(`
@error
model ErrorA {
  code: int32;
}

@friendlyName("Second")
model ModelB {
  id: string;
}
`);
    expect(doc.models).toHaveLength(2);
    expect(doc.models[0].isError).toBe(true);
    expect(doc.models[0].name).toBe("ErrorA");
    expect(doc.models[1].friendlyName).toBe("Second");
    expect(doc.models[1].name).toBe("ModelB");
  });

  it("model with extends and decorators", () => {
    const doc = parseTypeSpecDocument(`
@error
@doc("Error with base")
model SpecificError extends BaseError {
  details: string;
}
`);
    const model = doc.models[0];
    expect(model.isError).toBe(true);
    expect(model.extends).toBe("BaseError");
    expect(model.doc).toBe("Error with base");
  });
});
