import { describe, it, expect, vi, beforeAll } from "vitest";
import { parseJsonSchemaDocument } from "@/lib/importers/jsonschema.importer";
import { toAssetImportResult } from "@/lib/importers/multi-asset";
import { buildImportAssetsPayload } from "@/lib/importers/import-payload";
import { compileEntity, type PrismaFieldInput } from "@/lib/compiler/compiler.service";
import { generateTypeSpec } from "@/lib/compiler/typespec-generator";

vi.mock("server-only", () => ({}));

let compiler: typeof import("@/lib/compiler/typespec-compiler");
beforeAll(async () => {
  compiler = await import("@/lib/compiler/typespec-compiler");
});

function data(content: unknown) {
  const result = parseJsonSchemaDocument(JSON.stringify(content));
  if (!result.success) throw new Error("import failed");
  return result.data;
}

const CAT = { type: "object", properties: { meow: { type: "string" } } };
const DOG = { type: "object", properties: { bark: { type: "string" } } };
const ref = (name: string) => ({ $ref: `#/$defs/${name}` });

function doc(pet: unknown, extra: Record<string, unknown> = {}) {
  return {
    title: "Owner",
    type: "object",
    properties: { pet },
    required: ["pet"],
    $defs: { Cat: CAT, Dog: DOG },
    ...extra,
  };
}

const field = (d: ReturnType<typeof data>, entity: string, name: string) =>
  d.entities.find((e) => e.name === entity)!.fields.find((f) => f.name === name)!;

describe("JSON Schema importer: oneOf / anyOf of named refs -> UnionType", () => {
  it("(a) oneOf of two $defs refs becomes a union field + a result union", () => {
    const d = data(doc({ oneOf: [ref("Cat"), ref("Dog")] }));
    const f = field(d, "Owner", "pet");
    expect(f.type).toBe("union");
    expect(f.unionName).toBe("Owner_pet_Union");
    expect(d.unions).toEqual([{ name: "Owner_pet_Union", memberTypes: ["Cat", "Dog"] }]);
  });

  it("(b) anyOf behaves identically; oneOf wins when both are present", () => {
    const any = data(doc({ anyOf: [ref("Cat"), ref("Dog")] }));
    expect(field(any, "Owner", "pet").type).toBe("union");
    expect(any.unions).toEqual([{ name: "Owner_pet_Union", memberTypes: ["Cat", "Dog"] }]);
    const both = data(doc({ oneOf: [ref("Cat"), ref("Dog")], anyOf: [ref("Dog"), ref("Cat")] }));
    expect(both.unions?.[0].memberTypes).toEqual(["Cat", "Dog"]);
  });

  it("(c) a ref plus an inline primitive keeps today's fallback and creates no union", () => {
    const d = data(doc({ oneOf: [ref("Cat"), { type: "string" }] }));
    const f = field(d, "Owner", "pet");
    expect(f.type).toBe("reference");
    expect(f.referencedEntityName).toBe("Cat");
    expect(f.confidence).toBe("low");
    expect(f.unionName).toBeUndefined();
    expect(d.unions ?? []).toEqual([]);
  });

  it("(d) a $defs entry that is a oneOf of refs is ONE shared union used by every referencing field", () => {
    const d = data({
      title: "Owner",
      type: "object",
      properties: { pet: ref("Pet"), other: ref("Pet") },
      $defs: { Cat: CAT, Dog: DOG, Pet: { oneOf: [ref("Cat"), ref("Dog")] } },
    });
    expect(d.unions).toEqual([{ name: "Pet", memberTypes: ["Cat", "Dog"] }]);
    expect(field(d, "Owner", "pet")).toMatchObject({ type: "union", unionName: "Pet" });
    expect(field(d, "Owner", "other")).toMatchObject({ type: "union", unionName: "Pet" });
    expect(d.entities.map((e) => e.name)).not.toContain("Pet");
  });

  it("(e) a generated union name that collides with an asset gets a _2 suffix", () => {
    const d = data(doc({ oneOf: [ref("Cat"), ref("Dog")] }, { $defs: { Cat: CAT, Dog: DOG, Owner_pet_Union: CAT } }));
    expect(field(d, "Owner", "pet").unionName).toBe("Owner_pet_Union_2");
    expect(d.unions?.map((u) => u.name)).toEqual(["Owner_pet_Union_2"]);
  });

  it("(f) a null member makes the union field nullable even when required", () => {
    const d = data(doc({ oneOf: [ref("Cat"), { type: "null" }, ref("Dog")] }));
    const f = field(d, "Owner", "pet");
    expect(f.type).toBe("union");
    expect(f.nullable).toBe(true);
    expect(d.unions?.[0].memberTypes).toEqual(["Cat", "Dog"]);
  });

  it("(g) external refs (not in $defs) become members named by refToEntityName", () => {
    const d = data(
      doc({ oneOf: [ref("Cat"), { $ref: "https://x.test/schemas/Bird.json" }, { $ref: "#/$defs/Fish" }] })
    );
    expect(field(d, "Owner", "pet").type).toBe("union");
    expect(d.unions?.[0].memberTypes).toEqual(["Cat", "Bird", "Fish"]);
  });

  it("dedupes identical members and falls back when fewer than two remain", () => {
    const d = data(doc({ oneOf: [ref("Cat"), ref("Cat"), ref("Dog")] }));
    expect(d.unions?.[0].memberTypes).toEqual(["Cat", "Dog"]);
    const one = data(doc({ oneOf: [ref("Cat"), ref("Cat")] }));
    expect(field(one, "Owner", "pet").type).toBe("reference");
    expect(one.unions ?? []).toEqual([]);
  });

  it("(h) a thousand members are bounded with a warning", () => {
    const members = Array.from({ length: 1000 }, (_, i) => ({ $ref: `https://x.test/T${i}.json` }));
    const d = data(doc({ oneOf: members }));
    expect(d.unions?.[0].memberTypes).toHaveLength(200);
    expect(d.warnings.some((w) => /800/.test(w) && /union/i.test(w))).toBe(true);
  });

  it("never throws on null / non-object members (falls back)", () => {
    const d = data(doc({ oneOf: [null, 3, ref("Cat"), ref("Dog")] }));
    expect(field(d, "Owner", "pet").type).not.toBe("union");
  });

  it("an array of oneOf-refs items carries the union", () => {
    const d = data(doc({ type: "array", items: { oneOf: [ref("Cat"), ref("Dog")] } }));
    const f = field(d, "Owner", "pet");
    expect(f.type).toBe("array");
    expect(f.arrayElementType).toBe("union");
    expect(f.unionName).toBe("Owner_pet_Union");
  });
});

describe("union chain: importer -> multi-asset -> payload -> generator", () => {
  const d = data(doc({ oneOf: [ref("Cat"), ref("Dog")] }));

  it("(i) toAssetImportResult carries unions through (copies)", () => {
    const r = toAssetImportResult(d);
    expect(r.unions).toEqual(d.unions);
    expect(r.unions[0]).not.toBe(d.unions![0]);
  });

  it("(j) payload.unionTypes has the union; the field decorators keep unionName; TypeSpec compiles", async () => {
    const r = toAssetImportResult(d);
    const payload = buildImportAssetsPayload(r, {
      domainId: "d",
      selectedModels: [],
      selectedEntities: r.models.map((_, i) => i),
      selectedEnums: [],
      selectedScalars: [],
      selectedUnions: [0],
      selectedServices: [],
      selectedDecorators: [],
    });
    expect(payload.unionTypes).toEqual([{ name: "Owner_pet_Union", memberTypes: ["Cat", "Dog"] }]);
    const owner = payload.entities.find((e) => e.name === "Owner")!;
    const input = owner.fields.find((f) => f.name === "pet")!;
    expect(input.type).toBe("union");
    expect(input.decorators).toMatchObject({ unionName: "Owner_pet_Union" });

    const pf = (name: string, i: number, type: string, decorators: Record<string, unknown>): PrismaFieldInput => ({
      id: name, name, type, precision: null, scale: null, nullable: false, isKey: false, fieldNumber: null,
      description: "", classification: null, aliases: [], decorators, sortOrder: i,
    });
    const entity = (name: string) => ({
      id: name, name, description: "", status: "DRAFT", version: 1, domainId: null, metadata: {}, domain: null,
    });
    const model = compileEntity(entity("Owner"), [pf("pet", 0, input.type, input.decorators as Record<string, unknown>)]);
    expect(model.fields[0].complexType?.unionName).toBe("Owner_pet_Union");
    const cat = compileEntity(entity("Cat"), [pf("meow", 0, "string", {})]);
    const dog = compileEntity(entity("Dog"), [pf("bark", 0, "string", {})]);
    model.unionTypes = payload.unionTypes;
    const src = generateTypeSpec(model);
    expect(src).toContain("pet: Owner_pet_Union;");
    expect(src).toContain("union Owner_pet_Union {\n  Cat,\n  Dog,\n}");
    // Compile Owner with its members in one program (drop the repeated import / using lines of the extra sources).
    const body = (s: string) => s.split("\n").filter((l) => !/^(import|using) /.test(l)).join("\n");
    const result = await compiler.compileTypeSpecWithGovernance(
      [src, body(generateTypeSpec(cat)), body(generateTypeSpec(dog))].join("\n")
    );
    expect(result.diagnostics.filter((x) => x.severity === "error")).toEqual([]);
  }, 60_000);
});

// ---------------------------------------------------------------------------
// Fix round 1: sanitized names, and a union field that does not depend on a declaration
// ---------------------------------------------------------------------------

const pf = (name: string, i: number, type: string, decorators: Record<string, unknown>): PrismaFieldInput => ({
  id: name, name, type, precision: null, scale: null, nullable: false, isKey: false, fieldNumber: null,
  description: "", classification: null, aliases: [], decorators, sortOrder: i,
});
const entityRow = (name: string, metadata: Record<string, unknown> = {}) => ({
  id: name, name, description: "", status: "DRAFT", version: 1, domainId: null, metadata, domain: null,
});
const body = (s: string) => s.split("\n").filter((l) => !/^(import|using) /.test(l)).join("\n");

async function compileErrors(sources: string[]) {
  const [first, ...rest] = sources;
  const result = await compiler.compileTypeSpecWithGovernance([first, ...rest.map(body)].join("\n"));
  return result.diagnostics.filter((x) => x.severity === "error");
}

describe("union names are spelled the way the generator spells the assets they name", () => {
  const messy = {
    title: "Change me title",
    type: "object",
    properties: {
      "page-size": { oneOf: [ref("pet-cat"), ref("Bird.v2")] },
      page_size: { oneOf: [ref("pet-cat"), ref("Bird.v2")] },
    },
    $defs: { "pet-cat": CAT, "Bird.v2": DOG },
  };

  it("members and union names are sanitized; page-size / page_size cannot collide", () => {
    const d = data(messy);
    expect(d.unions!.map((u) => u.name)).toEqual(["Change_me_title_page_size_Union", "Change_me_title_page_size_Union_2"]);
    expect(d.unions![0].memberTypes).toEqual(["pet_cat", "Bird_v2"]);
    expect(field(d, "Change me title", "page-size").unionName).toBe("Change_me_title_page_size_Union");
    expect(field(d, "Change me title", "page_size").unionName).toBe("Change_me_title_page_size_Union_2");
  });

  it("the emitted TypeSpec compiles and the union members are the emitted model names", async () => {
    const d = data(messy);
    const r = toAssetImportResult(d);
    const payload = buildImportAssetsPayload(r, {
      domainId: "d", selectedModels: [], selectedEntities: r.models.map((_, i) => i), selectedEnums: [],
      selectedScalars: [], selectedUnions: [0, 1], selectedServices: [], selectedDecorators: [],
    });
    const sources = payload.entities.map((e, idx) => {
      const model = compileEntity(
        // only the first entity (the owner) declares the unions, as a document would
        entityRow(e.name, idx === 0 ? { custom: { unionTypes: payload.unionTypes } } : {}),
        e.fields.map((f, i) => pf(f.name, i, f.type, f.decorators as Record<string, unknown>))
      );
      return generateTypeSpec(model);
    });
    const text = sources.join("\n");
    expect(text).toContain("model pet_cat");
    expect(text).toContain("model Bird_v2");
    expect(text).toContain("model Change_me_title");
    expect(sources[0]).toContain("  pet_cat,\n  Bird_v2,\n");
    expect(await compileErrors(sources)).toEqual([]);
  }, 60_000);
});

describe("a union field on the REAL read-back path (Prisma rows -> compileEntity -> generateTypeSpec -> compiler)", () => {
  const decorators = { unionName: "Owner_pet_Union", unionMembers: ["Cat", "Dog"] };
  const members = [
    generateTypeSpec(compileEntity(entityRow("Cat"), [pf("meow", 0, "string", {})])),
    generateTypeSpec(compileEntity(entityRow("Dog"), [pf("bark", 0, "string", {})])),
  ];

  it("(a) the union declared in metadata.custom.unionTypes is referenced by name", async () => {
    const model = compileEntity(
      entityRow("Owner", { custom: { unionTypes: [{ name: "Owner_pet_Union", memberTypes: ["Cat", "Dog"] }] } }),
      [pf("pet", 0, "union", decorators)]
    );
    const src = generateTypeSpec(model);
    expect(src).toContain("pet: Owner_pet_Union;");
    expect(await compileErrors([src, ...members])).toEqual([]);
  }, 60_000);

  it("(b) a union that is NOT declared falls back to the inline expression from the field's own members", async () => {
    const src = generateTypeSpec(compileEntity(entityRow("Owner"), [pf("pet", 0, "union", decorators)]));
    expect(src).toContain("pet: Cat | Dog;");
    expect(src).not.toContain("union Owner_pet_Union");
    expect(await compileErrors([src, ...members])).toEqual([]);
  }, 60_000);

  it("(b2) an array of an undeclared union is parenthesized", async () => {
    const src = generateTypeSpec(
      compileEntity(entityRow("Owner"), [pf("pets", 0, "array", { arrayElementType: "union", ...decorators })])
    );
    expect(src).toContain("pets: (Cat | Dog)[];");
    expect(await compileErrors([src, ...members])).toEqual([]);
  }, 60_000);

  it("(c) not declared and no members falls back to string and still compiles", async () => {
    const src = generateTypeSpec(compileEntity(entityRow("Owner"), [pf("pet", 0, "union", { unionName: "Gone" })]));
    expect(src).toContain("pet: string;");
    expect(await compileErrors([src])).toEqual([]);
  }, 60_000);
});
