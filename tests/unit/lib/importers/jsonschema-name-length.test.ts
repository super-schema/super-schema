import { describe, it, expect, vi } from "vitest";
// These tests shell out to the real TypeSpec compiler / emitters (~1 s each); under load the 5 s default is too tight.
vi.setConfig({ testTimeout: 60_000 });
import { parseJsonSchemaDocument, parseJsonSchema, MAX_IMPORTED_NAME_LENGTH } from "@/lib/importers/jsonschema.importer";
import { toSingleEntityImport } from "@/lib/importers/multi-asset";
import type { PrismaEntityInput, PrismaFieldInput } from "@/lib/compiler/compiler.service";

vi.mock("@/lib/db", () => ({ prisma: {} }));
import { emitOfficialTypeSpecTargetFromData } from "@/lib/typespec-official/emitter.service";

// Found by the corpus (entity-name-too-long): a 300-character `title` reached the emitters, which write a file per declaration and
// crashed with ENAMETOOLONG ("The TypeSpec emitter failed."). Names above the limit are refused at import, and generation says so
// for a name that was stored before the limit existed.
const long = "L".repeat(MAX_IMPORTED_NAME_LENGTH + 1);

describe("import refuses names above the limit", () => {
  it("returns an error naming the entity for a single-entity document", () => {
    const parsed = parseJsonSchemaDocument(JSON.stringify({ title: long, type: "object", properties: { a: { type: "string" } } }));
    expect(parsed.success).toBe(false);
    if (!parsed.success) expect(parsed.error.message).toMatch(/Entity "L+\.\.\." has a name of 129 characters/);
    expect(parseJsonSchema(JSON.stringify({ title: long, type: "object", properties: { a: { type: "string" } } })).success).toBe(false);
  });

  it("returns an error naming the field", () => {
    const parsed = parseJsonSchemaDocument(JSON.stringify({ title: "T", type: "object", properties: { [long]: { type: "string" } } }));
    expect(parsed.success).toBe(false);
    if (!parsed.success) expect(parsed.error.message).toMatch(/Entity "T" has the field "p?L+\.\.\."/);
  });

  it("skips the offending entity with a warning and imports the rest of a multi-entity document", () => {
    const parsed = parseJsonSchemaDocument(JSON.stringify({
      title: "Root", type: "object", properties: { a: { $ref: "#/$defs/Ok" } },
      $defs: { Ok: { type: "object", properties: { x: { type: "string" } } }, [long]: { type: "object", properties: { y: { type: "string" } } } },
    }));
    if (!parsed.success) throw new Error(parsed.error.message);
    expect(parsed.data.entities.map((e) => e.name).sort()).toEqual(["Ok", "Root"]);
    expect(parsed.data.warnings.some((w) => /has a name of 129 characters.*skipped/.test(w))).toBe(true);
  });

  it("a skipped ROOT entity is an error from both entry points, not a silent swap for another entity", () => {
    const doc = JSON.stringify({ title: long, type: "object", properties: { a: { $ref: "#/$defs/Ok" } }, $defs: { Ok: { type: "object", properties: { x: { type: "string" } } } } });
    const multi = parseJsonSchemaDocument(doc);
    expect(multi.success).toBe(false);
    if (!multi.success) expect(multi.error.message).toMatch(/has a name of 129 characters \(the limit is 128\)/);
    const single = parseJsonSchema(doc);
    expect(single.success).toBe(false);
  });

  it("a field that pointed at a skipped entity stays visible as a dangling reference, with a warning naming both", () => {
    const parsed = parseJsonSchemaDocument(JSON.stringify({
      title: "Root", type: "object", properties: { gone: { $ref: `#/$defs/${long}` }, many: { type: "array", items: { $ref: `#/$defs/${long}` } }, ok: { type: "string" } },
      $defs: { [long]: { type: "object", properties: { y: { type: "string" } } } },
    }));
    if (!parsed.success) throw new Error(parsed.error.message);
    expect(parsed.data.entities.map((e) => e.name)).toEqual(["Root"]);
    const fields = parsed.data.entities[0].fields;
    const gone = fields.find((f) => f.name === "gone")!;
    expect(gone.confidence).toBe("low");
    expect(gone.danglingRef?.reason).toMatch(/was skipped because its name is longer than 128/);
    expect(fields.find((f) => f.name === "many")!.danglingRef).toMatchObject({ element: true });
    expect(fields.find((f) => f.name === "many")!.danglingRef?.ref).toMatch(/^#\//);
    expect(parsed.data.warnings.some((w) => /Field "gone" of "Root" refers to "L+\.\.\.", which was skipped/.test(w))).toBe(true);
  });

  it("an over-long field on the root is dropped with a warning, the entity stays, and the single-entity path carries the warning", () => {
    const parsed = parseJsonSchemaDocument(JSON.stringify({ title: "Root", type: "object", properties: { ok: { type: "string" }, [long]: { type: "string" } } }));
    if (!parsed.success) throw new Error(parsed.error.message);
    expect(parsed.data.entities[0].fields.map((f) => f.name)).toEqual(["ok"]);
    const single = toSingleEntityImport(parsed.data);
    expect(single.parsedEntity.name).toBe("Root");
    expect(single.warnings.some((w) => /has the field "L+\.\.\." with a name of 129 characters.*dropped/.test(w))).toBe(true);
  });

  it("accepts a name at the limit", () => {
    expect(parseJsonSchemaDocument(JSON.stringify({ title: "L".repeat(MAX_IMPORTED_NAME_LENGTH), type: "object", properties: { a: { type: "string" } } })).success).toBe(true);
  });
});

describe("generation of a stored overlong name", () => {
  const entity = (name: string): PrismaEntityInput => ({ id: "e", name, description: "", status: "DRAFT", version: 1, domainId: "d", metadata: {}, domain: { id: "d", name: "Sales", slug: "sales" } });
  const field = (name: string): PrismaFieldInput => ({ id: "f", name, type: "string", precision: null, scale: null, nullable: true, isKey: false, fieldNumber: null, description: "", classification: null, aliases: [], decorators: {}, sortOrder: 0 });

  it.each(["json-schema", "avro", "java-pojo"])("%s answers with a clear error, not a crash", async (target) => {
    const byEntity = await emitOfficialTypeSpecTargetFromData(entity(long), [field("a")], target);
    expect(byEntity.validationStatus).toBe("INVALID");
    expect(byEntity.errors[0].message).toMatch(/129 characters long.*Rename it/);
    const byField = await emitOfficialTypeSpecTargetFromData(entity("T"), [field(long)], target);
    expect(byField.errors[0].message).toMatch(/129 characters long/);
  });
});
