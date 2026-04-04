import { describe, it, expect } from "vitest";
import {
  TypeSpecDecoratorSchema,
  IdentitySchema,
  ValidationConstraintsSchema,
  WireFormatSchema,
  VisibilitySchema,
  DocumentationSchema,
  VersioningSchema,
  ExtensionsSchema,
} from "@/types/schemas/typespec-decorator.schema";

describe("TypeSpecDecoratorSchema", () => {
  it("accepts empty object", () => {
    expect(TypeSpecDecoratorSchema.parse({})).toEqual({});
  });

  it("accepts full valid structure", () => {
    const full = {
      identity: { key: true, discriminator: false, secret: false, format: "uuid", optional: false, defaultValue: null },
      validation: { minValue: null, maxValue: null, minLength: null, maxLength: null, pattern: null, minItems: null, maxItems: null },
      wireFormat: { encode: null, encodedNames: {}, httpBinding: null, httpBindingName: null },
      visibility: { phases: ["Create", "Read", "Update", "Delete", "Query"], invisible: false },
      documentation: { doc: "", summary: "", example: null, deprecated: null, externalDocsUrl: null, externalDocsDescription: null },
      versioning: { added: null, removed: null, renamedFrom: null, madeOptional: null, madeRequired: null, typeChangedFrom: null },
      extensions: { openapi: {}, xml: {} },
    };
    const result = TypeSpecDecoratorSchema.parse(full);
    expect(result.identity?.key).toBe(true);
    expect(result.visibility?.phases).toHaveLength(5);
  });

  it("accepts partial structure with only some panels", () => {
    const partial = {
      identity: { key: true },
      documentation: { doc: "A user ID field" },
    };
    const result = TypeSpecDecoratorSchema.parse(partial);
    expect(result.identity?.key).toBe(true);
    expect(result.documentation?.doc).toBe("A user ID field");
    expect(result.validation).toBeUndefined();
  });

  it("rejects invalid visibility phases", () => {
    const invalid = {
      visibility: { phases: ["Create", "InvalidPhase"] },
    };
    expect(() => TypeSpecDecoratorSchema.parse(invalid)).toThrow();
  });

  it("rejects invalid httpBinding value", () => {
    const invalid = {
      wireFormat: { httpBinding: "invalidBinding" },
    };
    expect(() => TypeSpecDecoratorSchema.parse(invalid)).toThrow();
  });
});

describe("IdentitySchema", () => {
  it("accepts key and discriminator flags", () => {
    const result = IdentitySchema.parse({ key: true, discriminator: false });
    expect(result.key).toBe(true);
    expect(result.discriminator).toBe(false);
  });

  it("accepts format string", () => {
    const result = IdentitySchema.parse({ format: "uuid" });
    expect(result.format).toBe("uuid");
  });

  it("accepts null format", () => {
    const result = IdentitySchema.parse({ format: null });
    expect(result.format).toBeNull();
  });

  it("accepts defaultValue of any type", () => {
    expect(IdentitySchema.parse({ defaultValue: "active" }).defaultValue).toBe("active");
    expect(IdentitySchema.parse({ defaultValue: 42 }).defaultValue).toBe(42);
    expect(IdentitySchema.parse({ defaultValue: true }).defaultValue).toBe(true);
    expect(IdentitySchema.parse({ defaultValue: null }).defaultValue).toBeNull();
  });
});

describe("ValidationConstraintsSchema", () => {
  it("accepts numeric constraints", () => {
    const result = ValidationConstraintsSchema.parse({
      minValue: 0,
      maxValue: 100,
      minValueExclusive: -1,
      maxValueExclusive: 101,
    });
    expect(result.minValue).toBe(0);
    expect(result.maxValue).toBe(100);
  });

  it("accepts string constraints", () => {
    const result = ValidationConstraintsSchema.parse({
      minLength: 1,
      maxLength: 255,
      pattern: "^[A-Z]+$",
    });
    expect(result.minLength).toBe(1);
    expect(result.pattern).toBe("^[A-Z]+$");
  });

  it("accepts array constraints", () => {
    const result = ValidationConstraintsSchema.parse({
      minItems: 1,
      maxItems: 10,
    });
    expect(result.minItems).toBe(1);
    expect(result.maxItems).toBe(10);
  });

  it("rejects non-integer minLength", () => {
    expect(() => ValidationConstraintsSchema.parse({ minLength: 1.5 })).toThrow();
  });
});

describe("WireFormatSchema", () => {
  it("accepts valid httpBinding values", () => {
    const validBindings = ["none", "header", "query", "path", "cookie", "body", "bodyRoot", "bodyIgnore", "statusCode"];
    for (const binding of validBindings) {
      const result = WireFormatSchema.parse({ httpBinding: binding });
      expect(result.httpBinding).toBe(binding);
    }
  });

  it("accepts encodedNames as record", () => {
    const result = WireFormatSchema.parse({
      encodedNames: { "application/json": "exp_date", "application/xml": "expirationDate" },
    });
    expect(result.encodedNames?.["application/json"]).toBe("exp_date");
  });
});

describe("VisibilitySchema", () => {
  it("accepts all lifecycle phases", () => {
    const result = VisibilitySchema.parse({
      phases: ["Create", "Read", "Update", "Delete", "Query"],
    });
    expect(result.phases).toHaveLength(5);
  });

  it("accepts subset of phases", () => {
    const result = VisibilitySchema.parse({ phases: ["Read"] });
    expect(result.phases).toHaveLength(1);
  });

  it("accepts invisible flag", () => {
    const result = VisibilitySchema.parse({ invisible: true, phases: [] });
    expect(result.invisible).toBe(true);
  });
});

describe("DocumentationSchema", () => {
  it("accepts doc and summary", () => {
    const result = DocumentationSchema.parse({
      doc: "# User ID\nThe primary identifier",
      summary: "User ID field",
    });
    expect(result.doc).toContain("User ID");
    expect(result.summary).toBe("User ID field");
  });

  it("accepts deprecated with message", () => {
    const result = DocumentationSchema.parse({ deprecated: "Use newUserId instead" });
    expect(result.deprecated).toBe("Use newUserId instead");
  });

  it("accepts externalDocs pair", () => {
    const result = DocumentationSchema.parse({
      externalDocsUrl: "https://example.com/docs",
      externalDocsDescription: "See full docs",
    });
    expect(result.externalDocsUrl).toBe("https://example.com/docs");
  });
});

describe("VersioningSchema", () => {
  it("accepts simple version references", () => {
    const result = VersioningSchema.parse({
      added: "v2",
      removed: "v3",
      madeOptional: "v2",
      madeRequired: "v3",
    });
    expect(result.added).toBe("v2");
    expect(result.removed).toBe("v3");
  });

  it("accepts renamedFrom with version and oldName", () => {
    const result = VersioningSchema.parse({
      renamedFrom: { version: "v3", oldName: "user_name" },
    });
    expect(result.renamedFrom?.version).toBe("v3");
    expect(result.renamedFrom?.oldName).toBe("user_name");
  });

  it("accepts typeChangedFrom with version and oldType", () => {
    const result = VersioningSchema.parse({
      typeChangedFrom: { version: "v2", oldType: "string" },
    });
    expect(result.typeChangedFrom?.version).toBe("v2");
    expect(result.typeChangedFrom?.oldType).toBe("string");
  });
});

describe("ExtensionsSchema", () => {
  it("accepts openapi extensions", () => {
    const result = ExtensionsSchema.parse({
      openapi: { "x-internal": true, "x-deprecated-at": "2024-01" },
    });
    expect(result.openapi?.["x-internal"]).toBe(true);
  });

  it("accepts xml decorators", () => {
    const result = ExtensionsSchema.parse({
      xml: { attribute: true, element: false, name: "userId" },
    });
    expect(result.xml?.attribute).toBe(true);
    expect(result.xml?.name).toBe("userId");
  });
});
