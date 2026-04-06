import { describe, it, expect } from "vitest";
import { parseTypeSpecSchema } from "@/lib/importers/typespec.importer";
import { detectFormat } from "@/lib/importers/format-detector";

describe("TypeSpec Importer", () => {
  describe("simple model parsing", () => {
    it("parses a simple TypeSpec model with 3 fields", () => {
      const content = `model User {
  id: string;
  name: string;
  age: int32;
}`;
      const result = parseTypeSpecSchema(content);
      expect(result.success).toBe(true);
      if (!result.success) return;
      expect(result.data.name).toBe("User");
      expect(result.data.fields).toHaveLength(3);
      expect(result.data.fields[0].name).toBe("id");
      expect(result.data.fields[0].type).toBe("string");
      expect(result.data.fields[1].name).toBe("name");
      expect(result.data.fields[2].name).toBe("age");
      expect(result.data.fields[2].type).toBe("int32");
    });

    it("sets sourceFormat to typespec", () => {
      const content = `model Item {
  id: string;
}`;
      const result = parseTypeSpecSchema(content);
      expect(result.success).toBe(true);
      if (!result.success) return;
      expect(result.data.sourceFormat).toBe("typespec");
    });

    it("preserves original content", () => {
      const content = `model Item {
  id: string;
}`;
      const result = parseTypeSpecSchema(content);
      expect(result.success).toBe(true);
      if (!result.success) return;
      expect(result.data.originalContent).toBe(content);
    });
  });

  describe("@key decorator", () => {
    it("extracts @key decorator as isKey", () => {
      const content = `model User {
  @key
  id: string;
  name: string;
}`;
      const result = parseTypeSpecSchema(content);
      expect(result.success).toBe(true);
      if (!result.success) return;
      expect(result.data.fields[0].isKey).toBe(true);
      expect(result.data.fields[1].isKey).toBeUndefined();
    });
  });

  describe("@doc decorator", () => {
    it("extracts @doc on fields as description", () => {
      const content = `model User {
  @doc("The unique identifier")
  id: string;
}`;
      const result = parseTypeSpecSchema(content);
      expect(result.success).toBe(true);
      if (!result.success) return;
      expect(result.data.fields[0].description).toBe(
        "The unique identifier"
      );
    });

    it("extracts model-level @doc as entity description", () => {
      const content = `@doc("A user in the system")
model User {
  id: string;
}`;
      const result = parseTypeSpecSchema(content);
      expect(result.success).toBe(true);
      if (!result.success) return;
      expect(result.data.description).toBe("A user in the system");
    });
  });

  describe("@format decorator", () => {
    it("extracts @format as format hint", () => {
      const content = `model User {
  @format("email")
  email: string;
}`;
      const result = parseTypeSpecSchema(content);
      expect(result.success).toBe(true);
      if (!result.success) return;
      expect(result.data.fields[0].format).toBe("email");
    });
  });

  describe("optional fields", () => {
    it("maps optional fields (?) to nullable", () => {
      const content = `model User {
  id: string;
  nickname?: string;
}`;
      const result = parseTypeSpecSchema(content);
      expect(result.success).toBe(true);
      if (!result.success) return;
      expect(result.data.fields[0].nullable).toBe(false);
      expect(result.data.fields[1].nullable).toBe(true);
    });
  });

  describe("classification from @tag", () => {
    it('maps @tag("classification:PII") to classification = "PII"', () => {
      const content = `model User {
  @tag("classification:PII")
  email: string;
}`;
      const result = parseTypeSpecSchema(content);
      expect(result.success).toBe(true);
      if (!result.success) return;
      expect(result.data.fields[0].classification).toBe("PII");
    });

    it('maps @tag("classification:INTERNAL") to classification = "INTERNAL"', () => {
      const content = `model Config {
  @tag("classification:INTERNAL")
  setting: string;
}`;
      const result = parseTypeSpecSchema(content);
      expect(result.success).toBe(true);
      if (!result.success) return;
      expect(result.data.fields[0].classification).toBe("INTERNAL");
    });
  });

  describe("@secret decorator", () => {
    it('maps @secret to classification = "SENSITIVE"', () => {
      const content = `model User {
  @secret
  password: string;
}`;
      const result = parseTypeSpecSchema(content);
      expect(result.success).toBe(true);
      if (!result.success) return;
      expect(result.data.fields[0].classification).toBe("SENSITIVE");
    });
  });

  describe("validation decorators -> constraints", () => {
    it("extracts @minLength and @maxLength as constraints", () => {
      const content = `model User {
  @minLength(1)
  @maxLength(100)
  name: string;
}`;
      const result = parseTypeSpecSchema(content);
      expect(result.success).toBe(true);
      if (!result.success) return;
      const constraints = result.data.fields[0].constraints;
      expect(constraints).toBeDefined();
      expect(constraints).toContainEqual({ type: "minLength", value: 1 });
      expect(constraints).toContainEqual({ type: "maxLength", value: 100 });
    });

    it("extracts @minValue and @maxValue as constraints", () => {
      const content = `model Product {
  @minValue(0)
  @maxValue(999999)
  price: float64;
}`;
      const result = parseTypeSpecSchema(content);
      expect(result.success).toBe(true);
      if (!result.success) return;
      const constraints = result.data.fields[0].constraints;
      expect(constraints).toBeDefined();
      expect(constraints).toContainEqual({ type: "minValue", value: 0 });
      expect(constraints).toContainEqual({ type: "maxValue", value: 999999 });
    });

    it("extracts @pattern as constraint", () => {
      const content = `model User {
  @pattern("^[a-z]+$")
  username: string;
}`;
      const result = parseTypeSpecSchema(content);
      expect(result.success).toBe(true);
      if (!result.success) return;
      const constraints = result.data.fields[0].constraints;
      expect(constraints).toBeDefined();
      expect(constraints).toContainEqual({
        type: "pattern",
        value: "^[a-z]+$",
      });
    });

    it("has no constraints when no validation decorators present", () => {
      const content = `model User {
  id: string;
}`;
      const result = parseTypeSpecSchema(content);
      expect(result.success).toBe(true);
      if (!result.success) return;
      expect(result.data.fields[0].constraints).toBeUndefined();
    });
  });

  describe("confidence", () => {
    it('all fields have confidence "high"', () => {
      const content = `model User {
  id: string;
  age: int32;
  active: boolean;
}`;
      const result = parseTypeSpecSchema(content);
      expect(result.success).toBe(true);
      if (!result.success) return;
      for (const field of result.data.fields) {
        expect(field.confidence).toBe("high");
      }
    });
  });

  describe("array types", () => {
    it("maps string[] to array type", () => {
      const content = `model User {
  tags: string[];
}`;
      const result = parseTypeSpecSchema(content);
      expect(result.success).toBe(true);
      if (!result.success) return;
      expect(result.data.fields[0].type).toBe("array");
    });
  });

  describe("@deprecated decorator", () => {
    it("maps @deprecated to deprecated flag", () => {
      const content = `model User {
  @deprecated("Use newField instead")
  oldField: string;
}`;
      const result = parseTypeSpecSchema(content);
      expect(result.success).toBe(true);
      if (!result.success) return;
      expect(result.data.fields[0].deprecated).toBe(true);
      expect(result.data.fields[0].deprecatedMessage).toBe(
        "Use newField instead"
      );
    });
  });

  describe("error handling", () => {
    it("returns error for empty content", () => {
      const result = parseTypeSpecSchema("");
      expect(result.success).toBe(false);
      if (result.success) return;
      expect(result.error.code).toBe("PARSE_ERROR");
    });

    it("returns error for content without a model", () => {
      const result = parseTypeSpecSchema("just some random text");
      expect(result.success).toBe(false);
      if (result.success) return;
      expect(result.error.code).toBe("PARSE_ERROR");
    });
  });
});

describe("Format detection for TypeSpec", () => {
  it("detects TypeSpec by .tsp file extension", () => {
    expect(detectFormat("", "model.tsp")).toBe("typespec");
  });

  it("detects TypeSpec by model keyword in content", () => {
    const content = `model User {
  id: string;
}`;
    expect(detectFormat(content)).toBe("typespec");
  });

  it('detects TypeSpec by import "@typespec" in content', () => {
    const content = `import "@typespec/http";
model User {
  id: string;
}`;
    expect(detectFormat(content)).toBe("typespec");
  });

  it("detects TypeSpec by decorators + model keyword", () => {
    const content = `@doc("A user")
model User {
  @key
  id: string;
}`;
    expect(detectFormat(content)).toBe("typespec");
  });
});
