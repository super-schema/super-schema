/**
 * Tests for multi-entity TypeSpec document import
 */

import { readFileSync } from "node:fs";
import path from "node:path";
import { describe, it, expect } from "vitest";
import { importTypeSpecDocument } from "@/services/import.service";

const MULTI_MODEL_TYPESPEC = `
namespace PetStore;

extern dec tracked(target: Model, owner?: valueof string);

scalar Email extends string;

enum PetStatus {
  Available,
  Pending,
  Sold,
}

union PetOrError = Pet | Error;

interface PetsApi {
  @get
  @route("/pets")
  op listPets(): Pet[];
}

@doc("A pet in the store")
model Pet {
  @key
  id: string;
  name: string;
  status: PetStatus;
}

model Error {
  code: int32;
  message: string;
}

model Owner extends Pet {
  ownerName: string;
}
`;

describe("importTypeSpecDocument", () => {
  it("returns all models from multi-model document", () => {
    const result = importTypeSpecDocument(MULTI_MODEL_TYPESPEC);
    expect(result.success).toBe(true);
    if (!result.success) return;

    expect(result.data.models).toHaveLength(3);
    expect(result.data.models.map((model) => model.name)).toEqual(["Pet", "Error", "Owner"]);
  });

  it("returns shared enums", () => {
    const result = importTypeSpecDocument(MULTI_MODEL_TYPESPEC);
    expect(result.success).toBe(true);
    if (!result.success) return;

    expect(result.data.sharedEnums).toHaveLength(1);
    expect(result.data.sharedEnums[0].name).toBe("PetStatus");
    expect(result.data.sharedEnums[0].values).toEqual(["Available", "Pending", "Sold"]);
  });

  it("returns custom scalars", () => {
    const result = importTypeSpecDocument(MULTI_MODEL_TYPESPEC);
    expect(result.success).toBe(true);
    if (!result.success) return;

    expect(result.data.customScalars).toHaveLength(1);
    expect(result.data.customScalars[0].name).toBe("Email");
    expect(result.data.customScalars[0].baseType).toBe("string");
  });

  it("returns union types", () => {
    const result = importTypeSpecDocument(MULTI_MODEL_TYPESPEC);
    expect(result.success).toBe(true);
    if (!result.success) return;

    expect(result.data.unions).toHaveLength(1);
    expect(result.data.unions[0].name).toBe("PetOrError");
    expect(result.data.unions[0].memberTypes).toEqual(["Pet", "Error"]);
  });

  it("returns namespace", () => {
    const result = importTypeSpecDocument(MULTI_MODEL_TYPESPEC);
    expect(result.success).toBe(true);
    if (!result.success) return;

    expect(result.data.namespace).toBe("PetStore");
  });

  it("preserves field details on each model", () => {
    const result = importTypeSpecDocument(MULTI_MODEL_TYPESPEC);
    expect(result.success).toBe(true);
    if (!result.success) return;

    const pet = result.data.models.find((model) => model.name === "Pet")!;
    expect(pet.fields).toHaveLength(3);
    expect(pet.fields[0].name).toBe("id");
    expect(pet.fields[0].isKey).toBe(true);
    expect(pet.description).toBe("A pet in the store");
  });

  it("infers recommended entity candidates and preserves relationships", () => {
    const result = importTypeSpecDocument(MULTI_MODEL_TYPESPEC);
    expect(result.success).toBe(true);
    if (!result.success) return;

    expect(result.data.models.find((model) => model.name === "Pet")?.recommendedAsEntity).toBe(
      true
    );
    expect(result.data.models.find((model) => model.name === "Owner")?.extends).toBe("Pet");
    expect(result.data.models.find((model) => model.name === "Owner")?.recommendedAsEntity).toBe(
      false
    );
  });

  it("returns imported services and decorator definitions", () => {
    const result = importTypeSpecDocument(MULTI_MODEL_TYPESPEC);
    expect(result.success).toBe(true);
    if (!result.success) return;

    expect(result.data.services).toHaveLength(1);
    expect(result.data.services[0]).toMatchObject({
      name: "PetsApi",
      source: "interface",
      scope: "domain",
      basePath: "/pets",
    });
    expect(result.data.decoratorDefinitions).toHaveLength(1);
    expect(result.data.decoratorDefinitions[0]).toMatchObject({
      name: "tracked",
      targetTypes: ["Model"],
    });
  });

  it("returns error for empty content", () => {
    const result = importTypeSpecDocument("");
    expect(result.success).toBe(false);
  });

  it("returns error for content with no constructs", () => {
    const result = importTypeSpecDocument("just some text\nno models here");
    expect(result.success).toBe(false);
  });

  it("imports all constructs from examples/cds/temp/customer_1.tsp", () => {
    const content = readFileSync(
      path.resolve(process.cwd(), "examples/cds/temp/customer_1.tsp"),
      "utf8"
    );

    const result = importTypeSpecDocument(content);
    expect(result.success).toBe(true);
    if (!result.success) return;

    expect(result.data.namespace).toBe("PayPal.CustomerDataStore");
    expect(result.data.models).toHaveLength(11);
    expect(result.data.models.map((model) => model.name)).toEqual([
      "Locale",
      "LegalName",
      "BirthDetails",
      "EmailContact",
      "PhoneContact",
      "PostalAddress",
      "AddressDetails",
      "TaxDetails",
      "OrganizationType",
      "IncorporationDetails",
      "Customer",
    ]);
    expect(result.data.sharedEnums).toHaveLength(5);
    expect(result.data.customScalars).toHaveLength(4);

    const customer = result.data.models.find((model) => model.name === "Customer");
    expect(customer).toBeDefined();
    expect(customer?.fields.length).toBeGreaterThan(10);
    expect(customer?.recommendedAsEntity).toBe(true);

    const taxDetails = result.data.models.find((model) => model.name === "TaxDetails");
    expect(taxDetails?.fields.find((field) => field.name === "tax_id")).toMatchObject({
      name: "tax_id",
      classification: "SENSITIVE",
    });

    const brandEnum = result.data.sharedEnums.find((sharedEnum) => sharedEnum.name === "Brand");
    expect(brandEnum?.description).toBe(
      "Brand namespace for customer. Normalized to UPPERCASE."
    );

    const uuidScalar = result.data.customScalars.find((scalar) => scalar.name === "uuid");
    expect(uuidScalar).toMatchObject({
      name: "uuid",
      baseType: "string",
      format: "uuid",
    });

    const countryCodeScalar = result.data.customScalars.find(
      (scalar) => scalar.name === "CountryCode"
    );
    expect(countryCodeScalar).toMatchObject({
      name: "CountryCode",
      baseType: "string",
      pattern: "^[A-Z]{2}$",
      description: "ISO 3166-1 alpha-2 country code",
    });
  });
});

describe("importTypeSpecDocument — inheritance sorting", () => {
  it("preserves extends relationships for later entity registration sorting", () => {
    const result = importTypeSpecDocument(`
model Child extends Parent {
  extra: string;
}
model Parent {
  id: string;
}
`);
    expect(result.success).toBe(true);
    if (!result.success) return;

    expect(result.data.models).toHaveLength(2);
    const child = result.data.models.find((model) => model.name === "Child")!;
    const parent = result.data.models.find((model) => model.name === "Parent")!;
    expect(child).toBeDefined();
    expect(parent).toBeDefined();
    expect(child.fields).toHaveLength(1);
    expect(parent.fields).toHaveLength(1);
    expect(child.extends).toBe("Parent");
  });
});
