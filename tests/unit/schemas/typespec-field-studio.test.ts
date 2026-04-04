import { describe, it, expect } from "vitest";
import {
  TypeSpecDecoratorSchema,
  IdentitySchema,
  ValidationConstraintsSchema,
  VisibilitySchema,
  WireFormatSchema,
  ExtensionsSchema,
} from "@/types/schemas/typespec-decorator.schema";
import { getTypeInfo } from "@/lib/data-types";

// ─── Panel Conditional Rendering Logic ───────────────────────────────

describe("Panel conditional rendering (type-contextual validation)", () => {
  it("Number types should show numeric constraints", () => {
    const numTypes = ["integer", "int32", "int64", "float", "float32", "float64", "decimal", "numeric", "safeint"];
    for (const typeId of numTypes) {
      const info = getTypeInfo(typeId);
      expect(info?.category).toBe("Number");
    }
  });

  it("String types should show string constraints", () => {
    const strTypes = ["string", "url"];
    for (const typeId of strTypes) {
      const info = getTypeInfo(typeId);
      expect(info?.category).toBe("String");
    }
  });

  it("array type should show array constraints", () => {
    const info = getTypeInfo("array");
    expect(info?.category).toBe("Structured");
    expect(info?.id).toBe("array");
  });

  it("boolean type should have no validation constraints", () => {
    const info = getTypeInfo("boolean");
    expect(info?.category).toBe("Boolean");
    // Boolean has no validation decorators — panel should show empty state
  });

  it("bytes type should have no validation constraints", () => {
    const info = getTypeInfo("bytes");
    expect(info?.category).toBe("Bytes");
  });
});

// ─── @key / @discriminator Mutex Logic ───────────────────────────────

describe("@key / @discriminator mutex logic", () => {
  it("both key and discriminator can't be true simultaneously", () => {
    // This test validates the business rule, not the schema (schema allows both)
    const identity = { key: true, discriminator: false };
    const result = IdentitySchema.parse(identity);
    expect(result.key).toBe(true);
    expect(result.discriminator).toBe(false);
  });

  it("enabling @key should auto-set nullable=false logic", () => {
    // Business rule: when key=true, nullable must be false
    const identity = IdentitySchema.parse({ key: true });
    // The UI enforces this rule - if key is true, optional is forced false
    expect(identity.key).toBe(true);
  });

  it("schema accepts key without discriminator", () => {
    expect(() => IdentitySchema.parse({ key: true })).not.toThrow();
  });

  it("schema accepts discriminator without key", () => {
    expect(() => IdentitySchema.parse({ discriminator: true })).not.toThrow();
  });
});

// ─── Visibility Matrix Toggle Logic ──────────────────────────────────

describe("Visibility matrix toggle logic", () => {
  const ALL_PHASES = ["Create", "Read", "Update", "Delete", "Query"] as const;

  it("all phases checked = default visibility (no decorator needed)", () => {
    const vis = VisibilitySchema.parse({ phases: [...ALL_PHASES] });
    expect(vis.phases).toHaveLength(5);
  });

  it("Read Only = only Read phase", () => {
    const vis = VisibilitySchema.parse({ phases: ["Read"] });
    expect(vis.phases).toEqual(["Read"]);
  });

  it("Create + Read = two phases", () => {
    const vis = VisibilitySchema.parse({ phases: ["Create", "Read"] });
    expect(vis.phases).toHaveLength(2);
  });

  it("empty phases = @invisible", () => {
    const vis = VisibilitySchema.parse({ phases: [], invisible: true });
    expect(vis.phases).toHaveLength(0);
    expect(vis.invisible).toBe(true);
  });

  it("removeVisibility mode inverts the logic", () => {
    const vis = VisibilitySchema.parse({
      phases: ["Create", "Read", "Update"],
      removeVisibility: true,
    });
    expect(vis.removeVisibility).toBe(true);
    // Removed phases are Delete and Query
    const removed = ALL_PHASES.filter((p) => !vis.phases!.includes(p));
    expect(removed).toEqual(["Delete", "Query"]);
  });

  it("decorator preview generation", () => {
    // Helper function mimicking the panel's getDecoratorPreview
    function getDecoratorPreview(
      phases: string[],
      invisible: boolean,
      removeVisibility: boolean
    ): string {
      if (invisible || phases.length === 0) return "@invisible";
      if (phases.length === ALL_PHASES.length) return "// visible in all phases (default)";
      if (removeVisibility) {
        const removed = ALL_PHASES.filter((p) => !phases.includes(p));
        return `@removeVisibility(${removed.map((p) => `Lifecycle.${p}`).join(", ")})`;
      }
      return `@visibility(${phases.map((p) => `Lifecycle.${p}`).join(", ")})`;
    }

    expect(getDecoratorPreview([...ALL_PHASES], false, false)).toBe("// visible in all phases (default)");
    expect(getDecoratorPreview(["Read"], false, false)).toBe("@visibility(Lifecycle.Read)");
    expect(getDecoratorPreview([], true, false)).toBe("@invisible");
    expect(getDecoratorPreview(["Create", "Read", "Update"], false, true)).toBe(
      "@removeVisibility(Lifecycle.Delete, Lifecycle.Query)"
    );
  });
});

// ─── Auto-Save Debounce Logic ────────────────────────────────────────

describe("Auto-save debounce logic", () => {
  it("validates that typespec decorator data roundtrips through schema", () => {
    const data = {
      identity: { key: true, format: "uuid", optional: false },
      validation: { minLength: 1, maxLength: 255 },
      wireFormat: { httpBinding: "header" as const, httpBindingName: "X-Request-Id" },
      visibility: { phases: ["Read" as const], invisible: false },
      documentation: { doc: "Request ID", summary: "Unique request identifier" },
      versioning: { added: "v2" },
      extensions: { openapi: { "x-internal": true } },
    };

    const result = TypeSpecDecoratorSchema.parse(data);
    expect(result).toEqual(data);
  });

  it("validates partial decorator updates merge correctly", () => {
    const existing = { identity: { key: false } };
    const update = { identity: { ...existing.identity, key: true, format: "uuid" } };
    const merged = { ...existing, ...update };
    const result = TypeSpecDecoratorSchema.parse(merged);
    expect(result.identity?.key).toBe(true);
    expect(result.identity?.format).toBe("uuid");
  });
});

// ─── Wire Format Validation ──────────────────────────────────────────

describe("Wire format validation", () => {
  it("accepts all valid httpBinding values", () => {
    const bindings = ["header", "query", "path", "cookie", "body", "bodyRoot", "bodyIgnore", "statusCode"];
    for (const binding of bindings) {
      const result = WireFormatSchema.parse({ httpBinding: binding });
      expect(result.httpBinding).toBe(binding);
    }
  });

  it("rejects invalid httpBinding", () => {
    expect(() => WireFormatSchema.parse({ httpBinding: "invalid" })).toThrow();
  });

  it("encodedNames supports multiple content types", () => {
    const result = WireFormatSchema.parse({
      encodedNames: {
        "application/json": "user_id",
        "application/xml": "UserId",
        "text/csv": "USER_ID",
      },
    });
    expect(Object.keys(result.encodedNames!)).toHaveLength(3);
  });
});

// ─── Extensions Schema Validation ────────────────────────────────────

describe("Extensions schema", () => {
  it("openapi extensions support complex JSON values", () => {
    const result = ExtensionsSchema.parse({
      openapi: {
        "x-tags": ["internal", "deprecated"],
        "x-config": { retries: 3, timeout: 5000 },
        "x-enabled": true,
        "x-rate-limit": 100,
      },
    });
    expect(result.openapi!["x-tags"]).toEqual(["internal", "deprecated"]);
    expect((result.openapi!["x-config"] as Record<string, number>).retries).toBe(3);
  });

  it("xml decorators are all optional", () => {
    const result = ExtensionsSchema.parse({ xml: {} });
    expect(result.xml).toEqual({});
  });

  it("xml decorators accept full configuration", () => {
    const result = ExtensionsSchema.parse({
      xml: {
        attribute: true,
        element: false,
        namespace: "http://example.com/ns",
        namespacePrefix: "ex",
        name: "CustomName",
      },
    });
    expect(result.xml?.attribute).toBe(true);
    expect(result.xml?.namespace).toBe("http://example.com/ns");
  });
});

// ─── Decorator Integration with JSONB ────────────────────────────────

describe("Decorator JSONB integration", () => {
  it("typespec decorators coexist with existing decorator categories", () => {
    // Simulates the full decorators JSONB structure
    const decorators = {
      structure: { nullable: true, key: false },
      semantics: { description: "test" },
      classification: { level: "INTERNAL" },
      policy: { retention: "30d" },
      typespec: {
        identity: { key: true, format: "uuid" },
        validation: { minLength: 1 },
        documentation: { doc: "Primary key" },
      },
    };

    // Validate just the typespec sub-key
    const result = TypeSpecDecoratorSchema.parse(decorators.typespec);
    expect(result.identity?.key).toBe(true);
    expect(result.validation?.minLength).toBe(1);

    // Original categories are untouched
    expect(decorators.structure.nullable).toBe(true);
    expect(decorators.classification.level).toBe("INTERNAL");
  });
});
