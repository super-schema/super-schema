import { describe, expect, it } from "vitest";
import { compileTypeSpecDocument } from "@/lib/compiler/typespec-compiler";
import { mapDocumentToImportResult } from "@/lib/importers/typespec.importer";

// A field typed with a model the same text declares is a reference to that model's entity, by name (as the JSON Schema importer keeps a
// reference to a definition of the same file). It is never stored under the model's name as its type, which is no type of the app.

const importOf = async (text: string) => mapDocumentToImportResult(await compileTypeSpecDocument(text), text);

describe("a TypeSpec import keeps a field typed with a model of the text as a reference to that model", () => {
  it("a property typed with a model is a reference, an array of one an array of references, both by the model's name", async () => {
    const result = await importOf(
      "model Pet { id: string; owner: Owner; tags: Tag[]; }\nmodel Owner { email: string; }\nmodel Tag { label: string; }\n",
    );
    const pet = result.models.find((m) => m.name === "Pet");
    expect(pet?.fields.find((f) => f.name === "owner")).toMatchObject({ type: "reference", referencedEntityName: "Owner" });
    expect(pet?.fields.find((f) => f.name === "tags")).toMatchObject({ type: "array", arrayElementType: "reference", referencedEntityName: "Tag" });
    expect(pet?.fields.find((f) => f.name === "owner")?.danglingRef).toBeUndefined();
  });

  it("a property typed with a declared enum is still an enum field, and a plain scalar keeps its type", async () => {
    const result = await importOf("enum Species { Dog, Cat }\nmodel Pet { species: Species; name: string; }\n");
    const pet = result.models.find((m) => m.name === "Pet");
    expect(pet?.fields.find((f) => f.name === "species")).toMatchObject({ type: "enum", enumName: "Species" });
    expect(pet?.fields.find((f) => f.name === "name")).toMatchObject({ type: "string" });
  });
});
