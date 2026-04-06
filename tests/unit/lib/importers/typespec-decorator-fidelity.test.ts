/**
 * TypeSpec Import Decorator Fidelity Tests
 *
 * Verifies that ALL TypeSpec decorators flow correctly from source text
 * through the parser → importer → decorator builder pipeline.
 *
 * Uses a comprehensive UserProfile entity with every decorator type.
 */

import { describe, it, expect } from "vitest";
import { parseTypeSpecSchema, parseTypeSpecFullDocument } from "@/lib/importers/typespec.importer";
import { parseTypeSpecDocument } from "@/lib/compiler/typespec-parser";
import { buildDecoratorsFromParsedField } from "@/lib/importers/decorator-builder";
import type { ParsedField } from "@/lib/importers/types";

// ---------------------------------------------------------------------------
// UserProfile TypeSpec source — comprehensive decorator coverage
// ---------------------------------------------------------------------------

const USER_PROFILE_TYPESPEC = `
@doc("A user profile with full decorator coverage")
model UserProfile {
  @key
  @doc("Unique user identifier")
  @format("uuid")
  id: string;

  @doc("User's first name")
  @summary("The given name of the user")
  @minLength(1)
  @maxLength(100)
  @pattern("[A-Za-z\\\\s-]+")
  firstName: string;

  @doc("User's last name")
  @minLength(1)
  @maxLength(100)
  lastName: string;

  @doc("Email address")
  @format("email")
  @maxLength(255)
  email: string;

  @doc("Age in years")
  @minValue(0)
  @maxValue(150)
  age?: int32;

  @doc("Account balance")
  @minValueExclusive(0)
  balance?: float64;

  @secret
  @doc("Hashed password")
  passwordHash: string;

  @encode("base64")
  @doc("Profile picture data")
  avatar?: bytes;

  @doc("Profile tags")
  @minItems(0)
  @maxItems(10)
  tags: string[];

  @visibility(Lifecycle.Read)
  @doc("Internal score")
  internalScore?: float64;

  #deprecated "Use displayName instead"
  @doc("Legacy username field")
  username?: string;

  @extension("x-format", "phone")
  @doc("Phone number")
  phone?: string;
}
`;

// ---------------------------------------------------------------------------
// Helper
// ---------------------------------------------------------------------------

function getField(fields: ParsedField[], name: string): ParsedField {
  const f = fields.find((f) => f.name === name);
  if (!f) throw new Error(`Field "${name}" not found`);
  return f;
}

// ---------------------------------------------------------------------------
// Parser level: ParsedTypeSpecDecorators
// ---------------------------------------------------------------------------

describe("TypeSpec parser — decorator extraction", () => {
  const doc = parseTypeSpecDocument(USER_PROFILE_TYPESPEC);
  const model = doc.models[0];

  it("parses model name and doc", () => {
    expect(model.name).toBe("UserProfile");
    expect(model.doc).toBe("A user profile with full decorator coverage");
  });

  it("parses @key", () => {
    const id = model.fields.find((f) => f.name === "id")!;
    expect(id.isKey).toBe(true);
  });

  it("parses @format", () => {
    const id = model.fields.find((f) => f.name === "id")!;
    expect(id.decorators.format).toBe("uuid");
  });

  it("parses @summary", () => {
    const fn = model.fields.find((f) => f.name === "firstName")!;
    expect(fn.decorators.summary).toBe("The given name of the user");
  });

  it("parses @minLength and @maxLength", () => {
    const fn = model.fields.find((f) => f.name === "firstName")!;
    expect(fn.decorators.minLength).toBe(1);
    expect(fn.decorators.maxLength).toBe(100);
  });

  it("parses @pattern", () => {
    const fn = model.fields.find((f) => f.name === "firstName")!;
    expect(fn.decorators.pattern).toBeDefined();
  });

  it("parses @minValue and @maxValue", () => {
    const age = model.fields.find((f) => f.name === "age")!;
    expect(age.decorators.minValue).toBe(0);
    expect(age.decorators.maxValue).toBe(150);
  });

  it("parses @minValueExclusive", () => {
    const balance = model.fields.find((f) => f.name === "balance")!;
    expect(balance.decorators.minValueExclusive).toBe(0);
  });

  it("parses @secret", () => {
    const pw = model.fields.find((f) => f.name === "passwordHash")!;
    expect(pw.decorators.secret).toBe(true);
  });

  it("parses @encode", () => {
    const avatar = model.fields.find((f) => f.name === "avatar")!;
    expect(avatar.decorators.encode).toBe("base64");
  });

  it("parses @minItems and @maxItems", () => {
    const tags = model.fields.find((f) => f.name === "tags")!;
    expect(tags.decorators.minItems).toBe(0);
    expect(tags.decorators.maxItems).toBe(10);
  });

  it("parses @visibility", () => {
    const score = model.fields.find((f) => f.name === "internalScore")!;
    expect(score.decorators.visibility).toEqual(["Read"]);
  });

  it("parses #deprecated", () => {
    const username = model.fields.find((f) => f.name === "username")!;
    expect(username.decorators.deprecated).toBe("Use displayName instead");
  });

  it("parses @extension", () => {
    const phone = model.fields.find((f) => f.name === "phone")!;
    expect(phone.decorators.extensions).toEqual({ "x-format": "phone" });
  });

  it("parses optional (?) fields", () => {
    const age = model.fields.find((f) => f.name === "age")!;
    expect(age.isOptional).toBe(true);
    const id = model.fields.find((f) => f.name === "id")!;
    expect(id.isOptional).toBe(false);
  });
});

// ---------------------------------------------------------------------------
// Importer level: ParsedField
// ---------------------------------------------------------------------------

describe("TypeSpec importer — ParsedField mapping", () => {
  const result = parseTypeSpecSchema(USER_PROFILE_TYPESPEC);
  expect(result.success).toBe(true);
  const fields = result.success ? result.data.fields : [];

  it("maps @format to ParsedField.format", () => {
    expect(getField(fields, "id").format).toBe("uuid");
    expect(getField(fields, "email").format).toBe("email");
  });

  it("maps @summary to ParsedField.summary", () => {
    expect(getField(fields, "firstName").summary).toBe("The given name of the user");
  });

  it("maps @visibility to ParsedField.visibility", () => {
    expect(getField(fields, "internalScore").visibility).toEqual(["Read"]);
  });

  it("maps @encode to ParsedField.encode", () => {
    expect(getField(fields, "avatar").encode).toBe("base64");
  });

  it("maps @secret to ParsedField.secret", () => {
    expect(getField(fields, "passwordHash").secret).toBe(true);
  });

  it("maps @extension to ParsedField.extensions", () => {
    expect(getField(fields, "phone").extensions).toEqual({ "x-format": "phone" });
  });

  it("maps @minValueExclusive to ParsedField.minValueExclusive", () => {
    expect(getField(fields, "balance").minValueExclusive).toBe(0);
  });

  it("maps #deprecated to ParsedField.deprecated + deprecatedMessage", () => {
    const username = getField(fields, "username");
    expect(username.deprecated).toBe(true);
    expect(username.deprecatedMessage).toBe("Use displayName instead");
  });

  it("maps @key to ParsedField.isKey", () => {
    expect(getField(fields, "id").isKey).toBe(true);
  });

  it("maps optional to ParsedField.nullable", () => {
    expect(getField(fields, "age").nullable).toBe(true);
    expect(getField(fields, "id").nullable).toBe(false);
  });

  it("maps validation constraints to ParsedField.constraints", () => {
    const fn = getField(fields, "firstName");
    expect(fn.constraints).toBeDefined();
    expect(fn.constraints!.find((c) => c.type === "minLength")?.value).toBe(1);
    expect(fn.constraints!.find((c) => c.type === "maxLength")?.value).toBe(100);
    expect(fn.constraints!.find((c) => c.type === "pattern")).toBeDefined();
  });

  it("maps @classification from @secret", () => {
    expect(getField(fields, "passwordHash").classification).toBe("SENSITIVE");
  });
});

// ---------------------------------------------------------------------------
// Decorator builder: ParsedField → DecoratorSet JSON
// ---------------------------------------------------------------------------

describe("buildDecoratorsFromParsedField", () => {
  const result = parseTypeSpecSchema(USER_PROFILE_TYPESPEC);
  const fields = result.success ? result.data.fields : [];

  it("builds typespec.identity.format from @format", () => {
    const decorators = buildDecoratorsFromParsedField(getField(fields, "id"));
    expect((decorators.typespec as Record<string, unknown> as { identity: { format: string } }).identity.format).toBe("uuid");
  });

  it("builds typespec.identity.secret from @secret", () => {
    const decorators = buildDecoratorsFromParsedField(getField(fields, "passwordHash"));
    const ts = decorators.typespec as Record<string, unknown>;
    expect((ts.identity as Record<string, unknown>).secret).toBe(true);
  });

  it("builds typespec.identity.key from @key", () => {
    const decorators = buildDecoratorsFromParsedField(getField(fields, "id"));
    const ts = decorators.typespec as Record<string, unknown>;
    expect((ts.identity as Record<string, unknown>).key).toBe(true);
  });

  it("builds typespec.validation from constraints", () => {
    const decorators = buildDecoratorsFromParsedField(getField(fields, "firstName"));
    const ts = decorators.typespec as Record<string, unknown>;
    const validation = ts.validation as Record<string, unknown>;
    expect(validation.minLength).toBe(1);
    expect(validation.maxLength).toBe(100);
    expect(validation.pattern).toBeDefined();
  });

  it("builds typespec.validation.minValueExclusive", () => {
    const decorators = buildDecoratorsFromParsedField(getField(fields, "balance"));
    const ts = decorators.typespec as Record<string, unknown>;
    const validation = ts.validation as Record<string, unknown>;
    expect(validation.minValueExclusive).toBe(0);
  });

  it("builds typespec.documentation.summary from @summary", () => {
    const decorators = buildDecoratorsFromParsedField(getField(fields, "firstName"));
    const ts = decorators.typespec as Record<string, unknown>;
    const docs = ts.documentation as Record<string, unknown>;
    expect(docs.summary).toBe("The given name of the user");
  });

  it("builds typespec.visibility.phases from @visibility", () => {
    const decorators = buildDecoratorsFromParsedField(getField(fields, "internalScore"));
    const ts = decorators.typespec as Record<string, unknown>;
    const vis = ts.visibility as Record<string, unknown>;
    expect(vis.phases).toEqual(["Read"]);
  });

  it("builds typespec.wireFormat.encode from @encode", () => {
    const decorators = buildDecoratorsFromParsedField(getField(fields, "avatar"));
    const ts = decorators.typespec as Record<string, unknown>;
    const wf = ts.wireFormat as Record<string, unknown>;
    expect(wf.encode).toBe("base64");
  });

  it("builds typespec.extensions from @extension", () => {
    const decorators = buildDecoratorsFromParsedField(getField(fields, "phone"));
    const ts = decorators.typespec as Record<string, unknown>;
    const ext = ts.extensions as Record<string, unknown>;
    expect((ext.openapi as Record<string, string>)["x-format"]).toBe("phone");
  });

  it("builds classification.level from @secret", () => {
    const decorators = buildDecoratorsFromParsedField(getField(fields, "passwordHash"));
    expect((decorators.classification as Record<string, unknown>).level).toBe("SENSITIVE");
  });

  it("builds evolution.deprecated from #deprecated", () => {
    const decorators = buildDecoratorsFromParsedField(getField(fields, "username"));
    const evo = decorators.evolution as Record<string, unknown>;
    expect(evo.deprecated).toBe(true);
  });

  it("builds typespec.documentation.deprecated from #deprecated", () => {
    const decorators = buildDecoratorsFromParsedField(getField(fields, "username"));
    const ts = decorators.typespec as Record<string, unknown>;
    const docs = ts.documentation as Record<string, unknown>;
    expect(docs.deprecated).toBe("Use displayName instead");
  });

  it("returns empty object for a field with no decorators", () => {
    const bareField: ParsedField = {
      name: "bare",
      type: "string",
      nullable: true,
      confidence: "high",
      originalType: "string",
    };
    const decorators = buildDecoratorsFromParsedField(bareField);
    expect(Object.keys(decorators)).toHaveLength(0);
  });
});
