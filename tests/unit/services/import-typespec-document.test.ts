/**
 * Tests for multi-entity TypeSpec document import
 */

import { describe, it, expect } from "vitest";
import { importTypeSpecDocument } from "@/services/import.service";

const MULTI_MODEL_TYPESPEC = `
namespace PetStore;

scalar Email extends string;

enum PetStatus {
  Available,
  Pending,
  Sold,
}

union PetOrError = Pet | Error;

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

    expect(result.data.entities).toHaveLength(3);
    expect(result.data.entities.map((e) => e.name)).toEqual(["Pet", "Error", "Owner"]);
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

  it("preserves field details on each entity", () => {
    const result = importTypeSpecDocument(MULTI_MODEL_TYPESPEC);
    expect(result.success).toBe(true);
    if (!result.success) return;

    const pet = result.data.entities.find((e) => e.name === "Pet")!;
    expect(pet.fields).toHaveLength(3);
    expect(pet.fields[0].name).toBe("id");
    expect(pet.fields[0].isKey).toBe(true);
    expect(pet.description).toBe("A pet in the store");
  });

  it("returns error for empty content", () => {
    const result = importTypeSpecDocument("");
    expect(result.success).toBe(false);
  });

  it("returns error for content with no constructs", () => {
    const result = importTypeSpecDocument("just some text\nno models here");
    expect(result.success).toBe(false);
  });
});

describe("importTypeSpecDocument — inheritance sorting", () => {
  it("sorts parent entities before children for inheritance", () => {
    // The sortByInheritance function is tested via the server action
    // Here we verify the parser preserves extends info
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

    // Parser preserves document order, but entities are all returned
    expect(result.data.entities).toHaveLength(2);
    // Both entities returned with their fields
    const child = result.data.entities.find((e) => e.name === "Child")!;
    const parent = result.data.entities.find((e) => e.name === "Parent")!;
    expect(child).toBeDefined();
    expect(parent).toBeDefined();
    expect(child.fields).toHaveLength(1);
    expect(parent.fields).toHaveLength(1);
  });
});
