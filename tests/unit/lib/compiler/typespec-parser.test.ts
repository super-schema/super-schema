import { describe, it, expect } from "vitest";
import {
  parseTypeSpec,
  mapTypeSpecType,
  computeFieldDiff,
  type ParsedTypeSpecModel,
  type ExistingFieldSummary,
} from "@/lib/compiler/typespec-parser";

describe("parseTypeSpec", () => {
  it("parses a simple model with 3 fields", () => {
    const source = `
model Customer {
  id: string;
  name: string;
  age: int32;
}
`;
    const result = parseTypeSpec(source);
    expect(result).not.toBeNull();
    expect(result!.name).toBe("Customer");
    expect(result!.fields).toHaveLength(3);
    expect(result!.fields[0].name).toBe("id");
    expect(result!.fields[0].type).toBe("string");
    expect(result!.fields[1].name).toBe("name");
    expect(result!.fields[1].type).toBe("string");
    expect(result!.fields[2].name).toBe("age");
    expect(result!.fields[2].type).toBe("int32");
  });

  it("parses optional fields (name?: string)", () => {
    const source = `
model User {
  id: string;
  email?: string;
}
`;
    const result = parseTypeSpec(source);
    expect(result).not.toBeNull();
    expect(result!.fields[0].isOptional).toBe(false);
    expect(result!.fields[1].name).toBe("email");
    expect(result!.fields[1].isOptional).toBe(true);
  });

  it("parses @key decorator", () => {
    const source = `
model Product {
  @key
  id: string;
  name: string;
}
`;
    const result = parseTypeSpec(source);
    expect(result).not.toBeNull();
    expect(result!.fields[0].name).toBe("id");
    expect(result!.fields[0].isKey).toBe(true);
    expect(result!.fields[1].isKey).toBe(false);
  });

  it("parses model-level @doc decorator", () => {
    const source = `
@doc("A customer entity")
model Customer {
  id: string;
}
`;
    const result = parseTypeSpec(source);
    expect(result).not.toBeNull();
    expect(result!.doc).toBe("A customer entity");
  });

  it("parses field-level @doc decorator", () => {
    const source = `
model Customer {
  @doc("The unique identifier")
  id: string;
}
`;
    const result = parseTypeSpec(source);
    expect(result).not.toBeNull();
    expect(result!.fields[0].decorators.doc).toBe("The unique identifier");
  });

  it("parses @format decorator", () => {
    const source = `
model Customer {
  @format("uuid")
  id: string;
}
`;
    const result = parseTypeSpec(source);
    expect(result).not.toBeNull();
    expect(result!.fields[0].decorators.format).toBe("uuid");
  });

  it("parses @secret decorator", () => {
    const source = `
model User {
  @secret
  password: string;
}
`;
    const result = parseTypeSpec(source);
    expect(result).not.toBeNull();
    expect(result!.fields[0].decorators.secret).toBe(true);
  });

  it("parses @minLength and @maxLength decorators", () => {
    const source = `
model User {
  @minLength(3)
  @maxLength(100)
  name: string;
}
`;
    const result = parseTypeSpec(source);
    expect(result).not.toBeNull();
    expect(result!.fields[0].decorators.minLength).toBe(3);
    expect(result!.fields[0].decorators.maxLength).toBe(100);
  });

  it("parses @minValue and @maxValue decorators", () => {
    const source = `
model Product {
  @minValue(0)
  @maxValue(99999)
  price: float64;
}
`;
    const result = parseTypeSpec(source);
    expect(result).not.toBeNull();
    expect(result!.fields[0].decorators.minValue).toBe(0);
    expect(result!.fields[0].decorators.maxValue).toBe(99999);
  });

  it("parses @pattern decorator", () => {
    const source = `
model User {
  @pattern("^[a-zA-Z0-9._%+-]+@[a-zA-Z0-9.-]+\\.[a-zA-Z]{2,}$")
  email: string;
}
`;
    const result = parseTypeSpec(source);
    expect(result).not.toBeNull();
    expect(result!.fields[0].decorators.pattern).toBe(
      "^[a-zA-Z0-9._%+-]+@[a-zA-Z0-9.-]+\\.[a-zA-Z]{2,}$"
    );
  });

  it("parses array type (string[])", () => {
    const source = `
model Blog {
  tags: string[];
}
`;
    const result = parseTypeSpec(source);
    expect(result).not.toBeNull();
    expect(result!.fields[0].name).toBe("tags");
    expect(result!.fields[0].type).toBe("array");
    expect((result!.fields[0] as unknown as Record<string, unknown>).arrayElementType).toBe("string");
  });

  it("maps TypeSpec scalars to our type system", () => {
    expect(mapTypeSpecType("int32")).toEqual({ type: "int32" });
    expect(mapTypeSpecType("int64")).toEqual({ type: "int64" });
    expect(mapTypeSpecType("float64")).toEqual({ type: "float64" });
    expect(mapTypeSpecType("utcDateTime")).toEqual({ type: "utcDateTime" });
    expect(mapTypeSpecType("boolean")).toEqual({ type: "boolean" });
    expect(mapTypeSpecType("bytes")).toEqual({ type: "bytes" });
    expect(mapTypeSpecType("decimal")).toEqual({ type: "decimal" });
    expect(mapTypeSpecType("decimal128")).toEqual({ type: "decimal128" });
    expect(mapTypeSpecType("plainDate")).toEqual({ type: "plainDate" });
    expect(mapTypeSpecType("string")).toEqual({ type: "string" });
    expect(mapTypeSpecType("url")).toEqual({ type: "url" });
    expect(mapTypeSpecType("duration")).toEqual({ type: "duration" });
  });

  it("maps array types correctly", () => {
    expect(mapTypeSpecType("string[]")).toEqual({
      type: "array",
      arrayElementType: "string",
    });
    expect(mapTypeSpecType("int32[]")).toEqual({
      type: "array",
      arrayElementType: "int32",
    });
  });

  it("returns null for malformed input", () => {
    expect(parseTypeSpec("")).toBeNull();
    expect(parseTypeSpec("just some random text")).toBeNull();
    expect(parseTypeSpec("model {")).toBeNull();
    expect(parseTypeSpec("model Name")).toBeNull();
  });

  it("returns null for null/undefined input", () => {
    expect(parseTypeSpec(null as unknown as string)).toBeNull();
    expect(parseTypeSpec(undefined as unknown as string)).toBeNull();
  });

  it("parses an empty model (model with no fields)", () => {
    const source = `
model Empty {
}
`;
    const result = parseTypeSpec(source);
    expect(result).not.toBeNull();
    expect(result!.name).toBe("Empty");
    expect(result!.fields).toHaveLength(0);
  });

  it("handles multiple decorators on one field", () => {
    const source = `
model User {
  @key
  @doc("User ID")
  @format("uuid")
  @minLength(36)
  @maxLength(36)
  id: string;
}
`;
    const result = parseTypeSpec(source);
    expect(result).not.toBeNull();
    expect(result!.fields).toHaveLength(1);
    const field = result!.fields[0];
    expect(field.isKey).toBe(true);
    expect(field.decorators.doc).toBe("User ID");
    expect(field.decorators.format).toBe("uuid");
    expect(field.decorators.minLength).toBe(36);
    expect(field.decorators.maxLength).toBe(36);
  });

  it("parses #deprecated directive", () => {
    const source = `
model Legacy {
  #deprecated "Use newField instead"
  oldField: string;
}
`;
    const result = parseTypeSpec(source);
    expect(result).not.toBeNull();
    expect(result!.fields[0].decorators.deprecated).toBe("Use newField instead");
  });

  it("parses @encode decorator", () => {
    const source = `
model Event {
  @encode("unixTimestamp")
  createdAt: utcDateTime;
}
`;
    const result = parseTypeSpec(source);
    expect(result).not.toBeNull();
    expect(result!.fields[0].decorators.encode).toBe("unixTimestamp");
  });

  it("parses @encode with sub-type", () => {
    const source = `
model Event {
  @encode("rfc3339", "string")
  createdAt: utcDateTime;
}
`;
    const result = parseTypeSpec(source);
    expect(result).not.toBeNull();
    expect(result!.fields[0].decorators.encode).toBe("rfc3339");
    expect(result!.fields[0].decorators.encodeSubType).toBe("string");
  });

  it("parses @tag decorator", () => {
    const source = `
model User {
  @tag("classification:PII")
  email: string;
}
`;
    const result = parseTypeSpec(source);
    expect(result).not.toBeNull();
    expect(result!.fields[0].decorators.tag).toBe("classification:PII");
  });

  it("parses @summary decorator", () => {
    const source = `
model User {
  @summary("The user email address")
  email: string;
}
`;
    const result = parseTypeSpec(source);
    expect(result).not.toBeNull();
    expect(result!.fields[0].decorators.summary).toBe("The user email address");
  });

  it("parses @minItems and @maxItems decorators", () => {
    const source = `
model Blog {
  @minItems(1)
  @maxItems(10)
  tags: string[];
}
`;
    const result = parseTypeSpec(source);
    expect(result).not.toBeNull();
    expect(result!.fields[0].decorators.minItems).toBe(1);
    expect(result!.fields[0].decorators.maxItems).toBe(10);
  });

  it("ignores unknown decorators gracefully", () => {
    const source = `
model User {
  @customDecorator("value")
  @anotherOne
  name: string;
}
`;
    const result = parseTypeSpec(source);
    expect(result).not.toBeNull();
    expect(result!.fields).toHaveLength(1);
    expect(result!.fields[0].name).toBe("name");
  });

  it("ignores comments inside model body", () => {
    const source = `
model User {
  // This is a comment
  name: string;
  // Another comment
  age: int32;
}
`;
    const result = parseTypeSpec(source);
    expect(result).not.toBeNull();
    expect(result!.fields).toHaveLength(2);
  });

  it("parses @minValueExclusive and @maxValueExclusive", () => {
    const source = `
model Range {
  @minValueExclusive(0)
  @maxValueExclusive(100)
  value: float64;
}
`;
    const result = parseTypeSpec(source);
    expect(result).not.toBeNull();
    expect(result!.fields[0].decorators.minValueExclusive).toBe(0);
    expect(result!.fields[0].decorators.maxValueExclusive).toBe(100);
  });

  it("parses @visibility decorator", () => {
    const source = `
model User {
  @visibility(Lifecycle.Create, Lifecycle.Read)
  name: string;
}
`;
    const result = parseTypeSpec(source);
    expect(result).not.toBeNull();
    expect(result!.fields[0].decorators.visibility).toEqual(["Create", "Read"]);
  });
});

describe("computeFieldDiff", () => {
  it("detects new fields to add", () => {
    const parsed = [
      { name: "id", type: "string", isOptional: false, isKey: true, decorators: {} },
      { name: "email", type: "string", isOptional: false, isKey: false, decorators: {} },
    ];
    const existing: ExistingFieldSummary[] = [
      { name: "id", type: "string", isOptional: false, isKey: true },
    ];
    const diff = computeFieldDiff(parsed, existing);
    expect(diff.toAdd).toHaveLength(1);
    expect(diff.toAdd[0].name).toBe("email");
    expect(diff.toRemove).toHaveLength(0);
  });

  it("detects fields to remove", () => {
    const parsed = [
      { name: "id", type: "string", isOptional: false, isKey: true, decorators: {} },
    ];
    const existing: ExistingFieldSummary[] = [
      { name: "id", type: "string", isOptional: false, isKey: true },
      { name: "oldField", type: "string", isOptional: false, isKey: false },
    ];
    const diff = computeFieldDiff(parsed, existing);
    expect(diff.toRemove).toEqual(["oldField"]);
  });

  it("detects fields that changed type", () => {
    const parsed = [
      { name: "age", type: "int64", isOptional: false, isKey: false, decorators: {} },
    ];
    const existing: ExistingFieldSummary[] = [
      { name: "age", type: "int32", isOptional: false, isKey: false },
    ];
    const diff = computeFieldDiff(parsed, existing);
    expect(diff.toUpdate).toHaveLength(1);
    expect(diff.toUpdate[0].name).toBe("age");
    expect(diff.toUpdate[0].changes.type).toBe("int64");
  });

  it("detects fields that changed optionality", () => {
    const parsed = [
      { name: "email", type: "string", isOptional: true, isKey: false, decorators: {} },
    ];
    const existing: ExistingFieldSummary[] = [
      { name: "email", type: "string", isOptional: false, isKey: false },
    ];
    const diff = computeFieldDiff(parsed, existing);
    expect(diff.toUpdate).toHaveLength(1);
    expect(diff.toUpdate[0].changes.isOptional).toBe(true);
  });

  it("returns empty diff when nothing changed", () => {
    const parsed = [
      { name: "id", type: "string", isOptional: false, isKey: true, decorators: {} },
    ];
    const existing: ExistingFieldSummary[] = [
      { name: "id", type: "string", isOptional: false, isKey: true },
    ];
    const diff = computeFieldDiff(parsed, existing);
    expect(diff.toAdd).toHaveLength(0);
    expect(diff.toUpdate).toHaveLength(0);
    expect(diff.toRemove).toHaveLength(0);
  });
});
