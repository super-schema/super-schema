/**
 * TypeSpec Built-in Decorator Compliance Audit — Test Suite
 *
 * Story 2-23: Verifies parse -> store -> generate round-trip fidelity
 * for every TypeSpec built-in decorator we support.
 */

import { describe, it, expect } from "vitest";
import {
  parseTypeSpecDocument,
  parseTypeSpec,
  validateDecoratorTarget,
} from "@/lib/compiler/typespec-parser";
import { generateTypeSpec } from "@/lib/compiler/typespec-generator";
import type { SuperSchemaModel } from "@/types/super-schema-model";

// ---------------------------------------------------------------------------
// Helper: build a minimal SuperSchemaModel for generator tests
// ---------------------------------------------------------------------------

function makeModel(
  overrides: Partial<SuperSchemaModel> & {
    entityOverrides?: Partial<SuperSchemaModel["entity"]>;
  } = {}
): SuperSchemaModel {
  const { entityOverrides, ...rest } = overrides;
  return {
    entity: {
      id: "test-id",
      name: "TestModel",
      domain: "test",
      domainId: "test-domain-id",
      description: "",
      status: "draft",
      version: 1,
      metadata: {},
      ...entityOverrides,
    },
    fields: [],
    relationships: [],
    ...rest,
  };
}

// ---------------------------------------------------------------------------
// Task 1 & 2: Parser — each built-in decorator
// ---------------------------------------------------------------------------

describe("TypeSpec Decorator Parsing", () => {
  // --- Already-supported decorators (regression tests) ---

  it("parses @doc on field", () => {
    const doc = parseTypeSpecDocument(`
model Foo {
  @doc("A field")
  bar: string;
}
`);
    expect(doc.models[0].fields[0].decorators.doc).toBe("A field");
  });

  it("parses @summary on field", () => {
    const doc = parseTypeSpecDocument(`
model Foo {
  @summary("Short desc")
  bar: string;
}
`);
    expect(doc.models[0].fields[0].decorators.summary).toBe("Short desc");
  });

  it("parses @format on field", () => {
    const doc = parseTypeSpecDocument(`
model Foo {
  @format("uuid")
  id: string;
}
`);
    expect(doc.models[0].fields[0].decorators.format).toBe("uuid");
  });

  it("parses @pattern on field", () => {
    const doc = parseTypeSpecDocument(`
model Foo {
  @pattern("[A-Z]+")
  code: string;
}
`);
    expect(doc.models[0].fields[0].decorators.pattern).toBe("[A-Z]+");
  });

  it("parses @minLength and @maxLength", () => {
    const doc = parseTypeSpecDocument(`
model Foo {
  @minLength(1)
  @maxLength(200)
  name: string;
}
`);
    const f = doc.models[0].fields[0];
    expect(f.decorators.minLength).toBe(1);
    expect(f.decorators.maxLength).toBe(200);
  });

  it("parses @minValue and @maxValue", () => {
    const doc = parseTypeSpecDocument(`
model Foo {
  @minValue(0)
  @maxValue(100)
  score: float64;
}
`);
    const f = doc.models[0].fields[0];
    expect(f.decorators.minValue).toBe(0);
    expect(f.decorators.maxValue).toBe(100);
  });

  it("parses @minValueExclusive and @maxValueExclusive", () => {
    const doc = parseTypeSpecDocument(`
model Foo {
  @minValueExclusive(0)
  @maxValueExclusive(100)
  score: float64;
}
`);
    const f = doc.models[0].fields[0];
    expect(f.decorators.minValueExclusive).toBe(0);
    expect(f.decorators.maxValueExclusive).toBe(100);
  });

  it("parses @minItems and @maxItems", () => {
    const doc = parseTypeSpecDocument(`
model Foo {
  @minItems(0)
  @maxItems(20)
  tags: string[];
}
`);
    const f = doc.models[0].fields[0];
    expect(f.decorators.minItems).toBe(0);
    expect(f.decorators.maxItems).toBe(20);
  });

  it("parses @key on field", () => {
    const doc = parseTypeSpecDocument(`
model Foo {
  @key
  id: string;
}
`);
    expect(doc.models[0].fields[0].isKey).toBe(true);
  });

  it("parses @secret on field", () => {
    const doc = parseTypeSpecDocument(`
model Foo {
  @secret
  apiKey: string;
}
`);
    expect(doc.models[0].fields[0].decorators.secret).toBe(true);
  });

  it("parses @visibility on field", () => {
    const doc = parseTypeSpecDocument(`
model Foo {
  @visibility(Lifecycle.Read)
  internalId: string;
}
`);
    expect(doc.models[0].fields[0].decorators.visibility).toEqual(["Read"]);
  });

  it("parses @encode with single string arg", () => {
    const doc = parseTypeSpecDocument(`
model Foo {
  @encode("rfc3339")
  createdAt: utcDateTime;
}
`);
    const f = doc.models[0].fields[0];
    expect(f.decorators.encode).toBe("rfc3339");
    expect(f.decorators.encodeSubType).toBeUndefined();
  });

  it("parses @encode with quoted second arg", () => {
    const doc = parseTypeSpecDocument(`
model Foo {
  @encode("unixTimestamp", "int32")
  ts: utcDateTime;
}
`);
    const f = doc.models[0].fields[0];
    expect(f.decorators.encode).toBe("unixTimestamp");
    expect(f.decorators.encodeSubType).toBe("int32");
  });

  it("parses @tag on field", () => {
    const doc = parseTypeSpecDocument(`
model Foo {
  @tag("pii")
  email: string;
}
`);
    expect(doc.models[0].fields[0].decorators.tag).toBe("pii");
  });

  it("parses @extension on field", () => {
    const doc = parseTypeSpecDocument(`
model Foo {
  @extension("x-custom", "value")
  data: string;
}
`);
    expect(doc.models[0].fields[0].decorators.extensions).toEqual({
      "x-custom": "value",
    });
  });

  it("parses @discriminator on model", () => {
    const doc = parseTypeSpecDocument(`
@discriminator("kind")
model Base {
  kind: string;
}
`);
    expect(doc.models[0].discriminator).toBe("kind");
  });

  // --- Newly added decorators ---

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

  it("parses @example with value literal on field", () => {
    const doc = parseTypeSpecDocument(`
model Foo {
  @example(#{ name: "John" })
  name: string;
}
`);
    expect(doc.models[0].fields[0].decorators.example).toBe('#{ name: "John" }');
  });

  it("parses @example with simple value on field", () => {
    const doc = parseTypeSpecDocument(`
model Foo {
  @example(42)
  score: int32;
}
`);
    expect(doc.models[0].fields[0].decorators.example).toBe("42");
  });

  it("parses @encodedName with two string args", () => {
    const doc = parseTypeSpecDocument(`
model Foo {
  @encodedName("application/json", "screen_name")
  screenName: string;
}
`);
    const enc = doc.models[0].fields[0].decorators.encodedName;
    expect(enc).toEqual({
      mimeType: "application/json",
      name: "screen_name",
    });
  });

  it("parses @friendlyName on model", () => {
    const doc = parseTypeSpecDocument(`
@friendlyName("MyFriendlyModel")
model InternalModel {
  id: string;
}
`);
    expect(doc.models[0].friendlyName).toBe("MyFriendlyModel");
  });

  it("parses @encode with bare scalar second arg", () => {
    const doc = parseTypeSpecDocument(`
model Foo {
  @encode("unixTimestamp", int32)
  lastLogin: utcDateTime;
}
`);
    const f = doc.models[0].fields[0];
    expect(f.decorators.encode).toBe("unixTimestamp");
    expect(f.decorators.encodeSubType).toBe("int32");
  });

  it("parses @tag on model level", () => {
    const doc = parseTypeSpecDocument(`
@tag("AuditTest")
@tag("Critical")
model TaggedModel {
  id: string;
}
`);
    expect(doc.models[0].tags).toEqual(expect.arrayContaining(["AuditTest", "Critical"]));
    expect(doc.models[0].tags).toHaveLength(2);
  });

  it("parses both #deprecated and @deprecated to same output", () => {
    const doc1 = parseTypeSpecDocument(`
model Foo {
  #deprecated "Use newField"
  oldField: string;
}
`);
    const doc2 = parseTypeSpecDocument(`
model Foo {
  @deprecated("Use newField")
  oldField: string;
}
`);
    expect(doc1.models[0].fields[0].decorators.deprecated).toBe("Use newField");
    expect(doc2.models[0].fields[0].decorators.deprecated).toBe("Use newField");
    expect(doc1.models[0].fields[0].decorators.deprecated).toBe(
      doc2.models[0].fields[0].decorators.deprecated
    );
  });
});

// ---------------------------------------------------------------------------
// Task 3: Generator output
// ---------------------------------------------------------------------------

describe("TypeSpec Decorator Generation", () => {
  it("emits @error on model", () => {
    const model = makeModel({
      entityOverrides: {
        name: "ErrorResponse",
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
          sortOrder: 0,
        },
      ],
    });
    const output = generateTypeSpec(model);
    expect(output).toContain("@error");
    expect(output).toContain("model ErrorResponse");
  });

  it("emits @friendlyName on model", () => {
    const model = makeModel({
      entityOverrides: {
        name: "InternalModel",
        metadata: { friendlyName: "MyFriendlyModel" },
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
          sortOrder: 0,
        },
      ],
    });
    const output = generateTypeSpec(model);
    expect(output).toContain('@friendlyName("MyFriendlyModel")');
  });

  it("emits entity tags as an x-tags extension on the model (never @tag, Story 16.6)", () => {
    const model = makeModel({
      entityOverrides: {
        name: "TaggedModel",
        metadata: { tags: ["AuditTest", "Critical"] },
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
          sortOrder: 0,
        },
      ],
    });
    const output = generateTypeSpec(model);
    // Story 16.6: @tag is not valid on a model; tags travel as one x-tags extension.
    expect(output).toContain('@TypeSpec.OpenAPI.extension("x-tags", #["AuditTest", "Critical"])');
    expect(output).not.toContain("@tag(");
  });

  it("emits @example on field", () => {
    const model = makeModel({
      fields: [
        {
          name: "name",
          type: "string",
          nullable: false,
          isKey: false,
          description: "",
          aliases: [],
          decorators: {
            typespec: {
              documentation: {
                example: '#{ name: "John" }',
              },
            },
          },
          sortOrder: 0,
        },
      ],
    });
    const output = generateTypeSpec(model);
    expect(output).toContain('@example(#{ name: "John" })');
  });

  it("emits @encodedName on field", () => {
    const model = makeModel({
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
          sortOrder: 0,
        },
      ],
    });
    const output = generateTypeSpec(model);
    expect(output).toContain('@encodedName("application/json", "screen_name")');
  });

  it("emits @encode with subtype", () => {
    const model = makeModel({
      fields: [
        {
          name: "lastLogin",
          type: "utcDateTime",
          nullable: false,
          isKey: false,
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
          sortOrder: 0,
        },
      ],
    });
    const output = generateTypeSpec(model);
    expect(output).toContain('@encode("unixTimestamp", "int32")');
  });
});

// ---------------------------------------------------------------------------
// Task 4: Decorator target validation
// ---------------------------------------------------------------------------

describe("Decorator Target Validation", () => {
  it("warns when @minLength is applied to a number type", () => {
    const warnings = validateDecoratorTarget(
      { minLength: 5 },
      "score",
      "int32"
    );
    expect(warnings).toHaveLength(1);
    expect(warnings[0].decorator).toBe("@minLength");
    expect(warnings[0].message).toContain("string types");
  });

  it("warns when @maxLength is applied to boolean", () => {
    const warnings = validateDecoratorTarget(
      { maxLength: 10 },
      "flag",
      "boolean"
    );
    expect(warnings).toHaveLength(1);
    expect(warnings[0].decorator).toBe("@maxLength");
  });

  it("warns when @format is applied to boolean", () => {
    const warnings = validateDecoratorTarget(
      { format: "uuid" },
      "flag",
      "boolean"
    );
    expect(warnings).toHaveLength(1);
    expect(warnings[0].decorator).toBe("@format");
  });

  it("warns when @pattern is applied to int32", () => {
    const warnings = validateDecoratorTarget(
      { pattern: "[0-9]+" },
      "num",
      "int32"
    );
    expect(warnings).toHaveLength(1);
    expect(warnings[0].decorator).toBe("@pattern");
  });

  it("warns when @minValue is applied to string", () => {
    const warnings = validateDecoratorTarget(
      { minValue: 0 },
      "name",
      "string"
    );
    expect(warnings).toHaveLength(1);
    expect(warnings[0].decorator).toBe("@minValue");
  });

  it("warns when @maxValue is applied to boolean", () => {
    const warnings = validateDecoratorTarget(
      { maxValue: 100 },
      "flag",
      "boolean"
    );
    expect(warnings).toHaveLength(1);
    expect(warnings[0].decorator).toBe("@maxValue");
  });

  it("warns when @minItems is applied to string", () => {
    const warnings = validateDecoratorTarget(
      { minItems: 0 },
      "name",
      "string"
    );
    expect(warnings).toHaveLength(1);
    expect(warnings[0].decorator).toBe("@minItems");
  });

  it("warns when @maxItems is applied to int32", () => {
    const warnings = validateDecoratorTarget(
      { maxItems: 10 },
      "count",
      "int32"
    );
    expect(warnings).toHaveLength(1);
    expect(warnings[0].decorator).toBe("@maxItems");
  });

  it("returns no warnings for correct decorator/type combos", () => {
    expect(validateDecoratorTarget({ minLength: 1 }, "name", "string")).toHaveLength(0);
    expect(validateDecoratorTarget({ minValue: 0 }, "score", "float64")).toHaveLength(0);
    expect(validateDecoratorTarget({ minItems: 0 }, "items", "array")).toHaveLength(0);
    expect(validateDecoratorTarget({ format: "uuid" }, "id", "string")).toHaveLength(0);
  });

  it("does not crash for decorators without type conflicts", () => {
    const warnings = validateDecoratorTarget(
      { doc: "test", secret: true, encode: "rfc3339" },
      "field",
      "boolean"
    );
    expect(warnings).toHaveLength(0);
  });

  it("reports multiple warnings for multiple mismatches", () => {
    const warnings = validateDecoratorTarget(
      { minLength: 1, maxLength: 100, pattern: "[a-z]+" },
      "score",
      "float64"
    );
    expect(warnings).toHaveLength(3);
  });
});

// ---------------------------------------------------------------------------
// Task 5: Comprehensive round-trip test
// ---------------------------------------------------------------------------

describe("Comprehensive Round-Trip Test", () => {
  const testTypeSpec = `@doc("Full decorator coverage test model")
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
}`;

  it("parses the comprehensive test entity correctly", () => {
    const doc = parseTypeSpecDocument(testTypeSpec);
    expect(doc.models).toHaveLength(1);

    const model = doc.models[0];
    expect(model.name).toBe("DecoratorAuditEntity");
    expect(model.doc).toBe("Full decorator coverage test model");
    expect(model.isError).toBe(true);
    expect(model.friendlyName).toBe("AuditEntity");
    expect(model.tags).toEqual(expect.arrayContaining(["AuditTest"]));

    // Verify individual fields
    const fieldMap = new Map(model.fields.map((f) => [f.name, f]));

    // id field
    const id = fieldMap.get("id")!;
    expect(id.isKey).toBe(true);
    expect(id.decorators.doc).toBe("Primary identifier");
    expect(id.decorators.format).toBe("uuid");

    // displayName field
    const displayName = fieldMap.get("displayName")!;
    expect(displayName.decorators.summary).toBe("The name shown in UI");
    expect(displayName.decorators.minLength).toBe(1);
    expect(displayName.decorators.maxLength).toBe(200);
    expect(displayName.decorators.pattern).toBeDefined();

    // score field
    const score = fieldMap.get("score")!;
    expect(score.decorators.minValue).toBe(0);
    expect(score.decorators.maxValue).toBe(100);
    expect(score.decorators.minValueExclusive).toBe(0);

    // tags field
    const tags = fieldMap.get("tags")!;
    expect(tags.type).toBe("array");
    expect(tags.decorators.minItems).toBe(0);
    expect(tags.decorators.maxItems).toBe(20);

    // apiKey field
    const apiKey = fieldMap.get("apiKey")!;
    expect(apiKey.decorators.secret).toBe(true);

    // createdAt field
    const createdAt = fieldMap.get("createdAt")!;
    expect(createdAt.decorators.encode).toBe("rfc3339");

    // lastLogin field — bare scalar second arg
    const lastLogin = fieldMap.get("lastLogin")!;
    expect(lastLogin.decorators.encode).toBe("unixTimestamp");
    expect(lastLogin.decorators.encodeSubType).toBe("int32");

    // screenName field — @encodedName
    const screenName = fieldMap.get("screenName")!;
    expect(screenName.decorators.encodedName).toEqual({
      mimeType: "application/json",
      name: "screen_name",
    });

    // internalId field — @visibility
    const internalId = fieldMap.get("internalId")!;
    expect(internalId.decorators.visibility).toEqual(["Read"]);

    // legacyName field — #deprecated
    const legacyName = fieldMap.get("legacyName")!;
    expect(legacyName.isOptional).toBe(true);
    expect(legacyName.decorators.deprecated).toBe("Use displayName instead");

    // customField — @extension
    const customField = fieldMap.get("customField")!;
    expect(customField.decorators.extensions).toEqual({ "x-custom": "value" });
  });

  it("round-trips: parse -> generate -> re-parse produces consistent structure", () => {
    // Parse original
    const doc1 = parseTypeSpecDocument(testTypeSpec);
    const model1 = doc1.models[0];

    // Build a SuperSchemaModel from parsed data (minimal mapping)
    const irModel = makeModel({
      entityOverrides: {
        name: model1.name,
        description: model1.doc || "",
        metadata: {
          isError: model1.isError,
          friendlyName: model1.friendlyName,
          tags: model1.tags,
        },
      },
      fields: model1.fields.map((f, i) => ({
        name: f.name,
        type: f.type as any,
        nullable: f.isOptional,
        isKey: f.isKey,
        description: f.decorators.doc || "",
        aliases: [],
        sortOrder: i,
        decorators: {
          typespec: {
            identity: {
              secret: f.decorators.secret,
              format: f.decorators.format,
            },
            validation: {
              minLength: f.decorators.minLength,
              maxLength: f.decorators.maxLength,
              minValue: f.decorators.minValue,
              maxValue: f.decorators.maxValue,
              minValueExclusive: f.decorators.minValueExclusive,
              maxValueExclusive: f.decorators.maxValueExclusive,
              pattern: f.decorators.pattern,
              minItems: f.decorators.minItems,
              maxItems: f.decorators.maxItems,
            },
            wireFormat: {
              encode: f.decorators.encode,
              encodeSubType: f.decorators.encodeSubType,
              encodedNames: f.decorators.encodedName
                ? { [f.decorators.encodedName.mimeType]: f.decorators.encodedName.name }
                : undefined,
            },
            visibility: f.decorators.visibility
              ? { phases: f.decorators.visibility as any[] }
              : undefined,
            documentation: {
              summary: f.decorators.summary,
              deprecated: f.decorators.deprecated,
              example: f.decorators.example,
            },
          },
        },
        complexType:
          f.type === "array" ? { arrayElementType: f.arrayElementType } : undefined,
      })),
    });

    // Generate TypeSpec from IR
    const generatedSource = generateTypeSpec(irModel);

    // Re-parse the generated source
    const doc2 = parseTypeSpecDocument(generatedSource);
    const model2 = doc2.models[0];

    // Compare key structural properties
    expect(model2.name).toBe(model1.name);
    expect(model2.doc).toBe(model1.doc);
    expect(model2.isError).toBe(model1.isError);
    expect(model2.friendlyName).toBe(model1.friendlyName);
    expect(model2.tags).toEqual(model1.tags);
    expect(model2.fields).toHaveLength(model1.fields.length);

    // Compare each field's core properties
    for (let i = 0; i < model1.fields.length; i++) {
      const f1 = model1.fields[i];
      const f2 = model2.fields[i];
      expect(f2.name).toBe(f1.name);
      expect(f2.isKey).toBe(f1.isKey);
      expect(f2.isOptional).toBe(f1.isOptional);
      expect(f2.decorators.doc).toBe(f1.decorators.doc);
    }
  });
});
