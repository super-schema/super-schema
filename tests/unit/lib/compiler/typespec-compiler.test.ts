/**
 * Real @typespec/compiler extraction tests. These run an actual compile() in
 * Node (async), so they verify the AST extraction end-to-end.
 */
import { describe, it, expect, vi, beforeAll } from "vitest";
// These tests shell out to the real TypeSpec compiler / emitters (~1 s each); under load the 5 s default is too tight.
vi.setConfig({ testTimeout: 60_000 });

// server-only throws outside an RSC bundle; neutralize it for the Node test.
vi.mock("server-only", () => ({}));

let compileTypeSpecDocument: typeof import("@/lib/compiler/typespec-compiler").compileTypeSpecDocument;

beforeAll(async () => {
  ({ compileTypeSpecDocument } = await import("@/lib/compiler/typespec-compiler"));
});

describe("TypeSpec compiler import (real AST)", () => {
  it("extracts a model with typed fields, optionality, @key and @doc", async () => {
    const doc = await compileTypeSpecDocument(`
      @doc("A user")
      model User {
        @key id: string;
        name: string;
        age?: int32;
        tags: string[];
      }
    `);

    expect(doc.models).toHaveLength(1);
    const user = doc.models[0];
    expect(user.name).toBe("User");
    expect(user.doc).toBe("A user");

    const byName = Object.fromEntries(user.fields.map((f) => [f.name, f]));
    expect(byName.id.type).toBe("string");
    expect(byName.id.isKey).toBe(true);
    expect(byName.age.isOptional).toBe(true);
    expect(byName.age.type).toBe("int32");
    expect(byName.tags.type).toBe("array");
    expect(byName.tags.arrayElementType).toBe("string");
  });

  it("maps a model-typed field to the referenced model name", async () => {
    const doc = await compileTypeSpecDocument(`
      model Account { id: string; }
      model User { owner: Account; friends: Account[]; }
    `);
    const user = doc.models.find((m) => m.name === "User")!;
    const byName = Object.fromEntries(user.fields.map((f) => [f.name, f]));
    expect(byName.owner.type).toBe("Account");
    expect(byName.friends.type).toBe("array");
    expect(byName.friends.arrayElementType).toBe("Account");
  });

  it("extracts string constraints and format via std decorators", async () => {
    const doc = await compileTypeSpecDocument(`
      model P {
        @format("email") email: string;
        @minLength(3) @maxLength(50) name: string;
        @minValue(0) @maxValue(120) age: int32;
      }
    `);
    const byName = Object.fromEntries(doc.models[0].fields.map((f) => [f.name, f]));
    expect(byName.email.decorators.format).toBe("email");
    expect(byName.name.decorators.minLength).toBe(3);
    expect(byName.name.decorators.maxLength).toBe(50);
    expect(byName.age.decorators.minValue).toBe(0);
    expect(byName.age.decorators.maxValue).toBe(120);
  });

  it("extracts enums, scalars, unions, and a namespace", async () => {
    const doc = await compileTypeSpecDocument(`
      namespace MyApp;
      enum Status { Active, Inactive }
      scalar uuid extends string;
      union Id { string, int32 }
      model M { s: Status; }
    `);
    expect(doc.namespace).toBe("MyApp");
    expect(doc.enums.find((e) => e.name === "Status")?.values).toEqual(["Active", "Inactive"]);
    expect(doc.scalars.find((s) => s.name === "uuid")?.baseType).toBe("string");
    expect(doc.unions.find((u) => u.name === "Id")?.memberTypes).toEqual(
      expect.arrayContaining(["string", "int32"])
    );
  });

  it("extracts interface operations", async () => {
    const doc = await compileTypeSpecDocument(`
      model User { id: string; }
      interface Users {
        get(id: string): User;
      }
    `);
    const iface = doc.interfaces.find((i) => i.name === "Users");
    expect(iface).toBeDefined();
    expect(iface!.operations[0].name).toBe("get");
    expect(iface!.operations[0].returnType).toBe("User");
    expect(iface!.operations[0].params[0]).toMatchObject({ name: "id", type: "string" });
  });

  it("ignores std-lib types (only user source extracted)", async () => {
    const doc = await compileTypeSpecDocument(`model Solo { x: string; }`);
    expect(doc.models.map((m) => m.name)).toEqual(["Solo"]);
  });
});

describe("TypeSpec compiler governance extraction (compileTypeSpecWithGovernance)", () => {
  let compileTypeSpecWithGovernance: typeof import("@/lib/compiler/typespec-compiler").compileTypeSpecWithGovernance;

  beforeAll(async () => {
    ({ compileTypeSpecWithGovernance } = await import("@/lib/compiler/typespec-compiler"));
  });

  it("captures governance decorator values via real semantic accessors", async () => {
    const result = await compileTypeSpecWithGovernance(`
      import "@superschema/typespec-enterprise";
      namespace Payments;

      @Enterprise.businessOwner("payments-team")
      model Transaction {
        @key id: string;

        @Enterprise.dataClassification(Enterprise.DataClassification.PII)
        @Enterprise.pii
        @Enterprise.anonymization(Enterprise.AnonymizationStrategy.tokenize)
        cardNumber: string;

        @Enterprise.precision(19, 4)
        amount: decimal;
      }
    `);

    expect(result.success).toBe(true);
    if (!result.success) return;

    expect(result.modelGovernance["Transaction"]?.businessOwner).toBe("payments-team");
    expect(result.fieldGovernance["Transaction.cardNumber"]).toMatchObject({
      classification: "PII",
      pii: true,
      anonymization: "tokenize",
    });
    expect(result.document.models[0]?.name).toBe("Transaction");
  });

  it("captures Avro and Protobuf binding decorators", async () => {
    const result = await compileTypeSpecWithGovernance(`
      import "@superschema/typespec-enterprise";
      namespace Catalog;
      model Product {
        @key id: string;
        @Enterprise.avroLogicalType(Enterprise.AvroLogicalType.fixed)
        @Enterprise.avroFixedSize(16)
        checksum: bytes;
        @Enterprise.protobufFieldNumber(7)
        status: string;
      }
    `);

    expect(result.success).toBe(true);
    if (!result.success) return;
    expect(result.fieldGovernance["Product.checksum"]).toMatchObject({
      avroLogicalType: "fixed",
      avroFixedSize: 16,
    });
    expect(result.fieldGovernance["Product.status"]?.protobufFieldNumber).toBe(7);
  });

  it("fails closed on a real compile error without throwing", async () => {
    const result = await compileTypeSpecWithGovernance(`
      namespace Broken;
      model Foo { bar: ThisTypeDoesNotExist; }
    `);

    expect(result.success).toBe(false);
    if (result.success) return;
    expect(result.diagnostics.some((d) => d.severity === "error")).toBe(true);
  });

  it("surfaces lint warnings without blocking a successful compile", async () => {
    const result = await compileTypeSpecWithGovernance(`
      import "@superschema/typespec-enterprise";
      namespace Lax;
      model Foo {
        @key id: string;
        @Enterprise.pii
        email: string;
      }
    `);

    expect(result.success).toBe(true);
    if (!result.success) return;
    expect(
      result.diagnostics.some((d) => d.code.includes("pii-requires-anonymization") && d.severity === "warning")
    ).toBe(true);
  });
});
