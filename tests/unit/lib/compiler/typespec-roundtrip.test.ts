import { describe, it, expect } from "vitest";
import { generateTypeSpec } from "@/lib/compiler/typespec-generator";
import { compileEntity } from "@/lib/compiler/compiler.service";
import { parseTypeSpec } from "@/lib/compiler/typespec-parser";
import type { PrismaEntityInput, PrismaFieldInput } from "@/lib/compiler/compiler.service";

describe("TypeSpec roundtrip: entity -> TypeSpec -> parse -> fields match", () => {
  it("roundtrips a simple entity with basic fields", () => {
    const entity: PrismaEntityInput = {
      id: "e1",
      name: "Customer",
      description: "A customer record",
      status: "DRAFT",
      version: 1,
      domainId: "d1",
      metadata: {},
      domain: { id: "d1", name: "Commerce", slug: "commerce" },
    };

    const fields: PrismaFieldInput[] = [
      {
        id: "f1",
        name: "id",
        type: "string",
        precision: null,
        scale: null,
        nullable: false,
        isKey: true,
        fieldNumber: 1,
        description: "Unique identifier",
        classification: null,
        aliases: [],
        decorators: {},
        sortOrder: 0,
      },
      {
        id: "f2",
        name: "name",
        type: "string",
        precision: null,
        scale: null,
        nullable: false,
        isKey: false,
        fieldNumber: 2,
        description: "",
        classification: null,
        aliases: [],
        decorators: {},
        sortOrder: 1,
      },
      {
        id: "f3",
        name: "email",
        type: "string",
        precision: null,
        scale: null,
        nullable: true,
        isKey: false,
        fieldNumber: 3,
        description: "Contact email",
        classification: "PII",
        aliases: [],
        decorators: {},
        sortOrder: 2,
      },
      {
        id: "f4",
        name: "age",
        type: "int32",
        precision: null,
        scale: null,
        nullable: false,
        isKey: false,
        fieldNumber: 4,
        description: "",
        classification: null,
        aliases: [],
        decorators: {},
        sortOrder: 3,
      },
    ];

    // Step 1: compile entity to IR
    const model = compileEntity(entity, fields);

    // Step 2: generate TypeSpec source
    const source = generateTypeSpec(model);
    expect(source).toBeTruthy();

    // Step 3: parse it back
    const parsed = parseTypeSpec(source);
    expect(parsed).not.toBeNull();

    // Step 4: verify roundtrip
    expect(parsed!.name).toBe("Customer");
    expect(parsed!.doc).toBe("A customer record");
    expect(parsed!.fields).toHaveLength(4);

    // Field: id
    const idField = parsed!.fields.find((f) => f.name === "id")!;
    expect(idField).toBeDefined();
    expect(idField.type).toBe("string");
    expect(idField.isKey).toBe(true);
    expect(idField.isOptional).toBe(false);
    expect(idField.decorators.doc).toBe("Unique identifier");

    // Field: name
    const nameField = parsed!.fields.find((f) => f.name === "name")!;
    expect(nameField).toBeDefined();
    expect(nameField.type).toBe("string");
    expect(nameField.isKey).toBe(false);

    // Field: email (optional)
    const emailField = parsed!.fields.find((f) => f.name === "email")!;
    expect(emailField).toBeDefined();
    expect(emailField.type).toBe("string");
    expect(emailField.isOptional).toBe(true);
    expect(emailField.decorators.doc).toBe("Contact email");
    // Classification is emitted as @tag("classification:PII")
    expect(emailField.decorators.tag).toBe("classification:PII");

    // Field: age
    const ageField = parsed!.fields.find((f) => f.name === "age")!;
    expect(ageField).toBeDefined();
    expect(ageField.type).toBe("int32");
  });

  it("roundtrips fields with validation decorators", () => {
    const entity: PrismaEntityInput = {
      id: "e2",
      name: "Product",
      description: "",
      status: "DRAFT",
      version: 1,
      domainId: "d1",
      metadata: {},
      domain: { id: "d1", name: "Commerce", slug: "commerce" },
    };

    const fields: PrismaFieldInput[] = [
      {
        id: "f1",
        name: "sku",
        type: "string",
        precision: null,
        scale: null,
        nullable: false,
        isKey: true,
        fieldNumber: 1,
        description: "",
        classification: null,
        aliases: [],
        decorators: {
          typespec: {
            identity: { format: "uuid" },
            validation: { minLength: 8, maxLength: 36 },
          },
        },
        sortOrder: 0,
      },
      {
        id: "f2",
        name: "price",
        type: "float64",
        precision: null,
        scale: null,
        nullable: false,
        isKey: false,
        fieldNumber: 2,
        description: "",
        classification: null,
        aliases: [],
        decorators: {
          typespec: {
            validation: { minValue: 0, maxValue: 99999 },
          },
        },
        sortOrder: 1,
      },
    ];

    const model = compileEntity(entity, fields);
    const source = generateTypeSpec(model);
    const parsed = parseTypeSpec(source);
    expect(parsed).not.toBeNull();

    // sku field
    const sku = parsed!.fields.find((f) => f.name === "sku")!;
    expect(sku.isKey).toBe(true);
    expect(sku.decorators.format).toBe("uuid");
    expect(sku.decorators.minLength).toBe(8);
    expect(sku.decorators.maxLength).toBe(36);

    // price field
    const price = parsed!.fields.find((f) => f.name === "price")!;
    expect(price.type).toBe("float64");
    expect(price.decorators.minValue).toBe(0);
    expect(price.decorators.maxValue).toBe(99999);
  });

  it("roundtrips array-type fields", () => {
    const entity: PrismaEntityInput = {
      id: "e3",
      name: "BlogPost",
      description: "",
      status: "DRAFT",
      version: 1,
      domainId: "d1",
      metadata: {},
      domain: { id: "d1", name: "Content", slug: "content" },
    };

    const fields: PrismaFieldInput[] = [
      {
        id: "f1",
        name: "tags",
        type: "array",
        precision: null,
        scale: null,
        nullable: false,
        isKey: false,
        fieldNumber: 1,
        description: "",
        classification: null,
        aliases: [],
        decorators: { arrayElementType: "string" },
        sortOrder: 0,
      },
    ];

    const model = compileEntity(entity, fields);
    const source = generateTypeSpec(model);
    const parsed = parseTypeSpec(source);
    expect(parsed).not.toBeNull();

    const tagsField = parsed!.fields.find((f) => f.name === "tags")!;
    expect(tagsField.type).toBe("array");
    expect((tagsField as unknown as Record<string, unknown>).arrayElementType).toBe("string");
  });

  it("roundtrips fields with @secret and @encode decorators", () => {
    const entity: PrismaEntityInput = {
      id: "e4",
      name: "Credential",
      description: "",
      status: "DRAFT",
      version: 1,
      domainId: "d1",
      metadata: {},
      domain: { id: "d1", name: "Auth", slug: "auth" },
    };

    const fields: PrismaFieldInput[] = [
      {
        id: "f1",
        name: "token",
        type: "string",
        precision: null,
        scale: null,
        nullable: false,
        isKey: false,
        fieldNumber: 1,
        description: "",
        classification: null,
        aliases: [],
        decorators: { typespec: { identity: { secret: true } } },
        sortOrder: 0,
      },
      {
        id: "f2",
        name: "createdAt",
        type: "utcDateTime",
        precision: null,
        scale: null,
        nullable: false,
        isKey: false,
        fieldNumber: 2,
        description: "",
        classification: null,
        aliases: [],
        decorators: { typespec: { wireFormat: { encode: "rfc3339" } } },
        sortOrder: 1,
      },
    ];

    const model = compileEntity(entity, fields);
    const source = generateTypeSpec(model);
    const parsed = parseTypeSpec(source);
    expect(parsed).not.toBeNull();

    const tokenField = parsed!.fields.find((f) => f.name === "token")!;
    expect(tokenField.decorators.secret).toBe(true);

    const createdAtField = parsed!.fields.find((f) => f.name === "createdAt")!;
    expect(createdAtField.type).toBe("utcDateTime");
    expect(createdAtField.decorators.encode).toBe("rfc3339");
  });
});
