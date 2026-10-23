import { describe, it, expect, vi } from "vitest";
// These tests shell out to the real TypeSpec compiler / emitters (~1 s each); under load the 5 s default is too tight.
vi.setConfig({ testTimeout: 60_000 });
import type { PrismaEntityInput, PrismaFieldInput } from "@/lib/compiler/compiler.service";
import { compileEntity } from "@/lib/compiler/compiler.service";
import { findNameCollisions, describeNameCollision } from "@/lib/typespec-official/name-collisions";
import { parseJsonSchemaDocument } from "@/lib/importers/jsonschema.importer";

vi.mock("@/lib/db", () => ({ prisma: {} }));
import { emitOfficialTypeSpecTargetFromData } from "@/lib/typespec-official/emitter.service";

// Found by the corpus (names-collide-after-sanitising): distinct property names that an emitter writes as the same identifier made avro
// write a duplicate field, java-pojo write a class that does not compile and protobuf report `duplicate-property`. The DB targets
// already refuse (db-source.ts); every target that renames now refuses with a message naming both names and the identifier.
const entity: PrismaEntityInput = { id: "e", name: "Evt", description: "", status: "DRAFT", version: 1, domainId: "d", metadata: {}, domain: { id: "d", name: "Sales", slug: "sales" } };
const field = (name: string, type = "string", extra: Partial<PrismaFieldInput> = {}): PrismaFieldInput => ({
  id: name, name, type, precision: null, scale: null, nullable: true, isKey: false, fieldNumber: null, description: "", classification: null, aliases: [], decorators: {}, sortOrder: 0, ...extra,
});
const model = (...fields: PrismaFieldInput[]) => compileEntity(entity, fields);

describe("findNameCollisions", () => {
  it("finds fields that become the same identifier, per target", () => {
    const m = model(field("a-b"), field("a_b"), field("fine"));
    expect(findNameCollisions(m, "avro")).toEqual([{ kind: "field", names: ["a-b", "a_b"], becomes: "a_b" }]);
    expect(findNameCollisions(m, "protobuf")).toEqual([{ kind: "field", names: ["a-b", "a_b"], becomes: "a_b" }]);
    expect(findNameCollisions(m, "java-pojo")).toEqual([{ kind: "field", names: ["a-b", "a_b"], becomes: "aB" }]);
  });

  it("finds enum symbols that become the same Java constant", () => {
    const m = model(field("s", "enum", { aliases: ["in-progress", "in progress", "ok"] }));
    expect(findNameCollisions(m, "java-pojo")).toEqual([{ kind: "enum symbol", names: ["in-progress", "in progress"], becomes: "IN_PROGRESS", owner: "s" }]);
  });

  it("finds nothing for the targets that keep names verbatim, or for distinct names", () => {
    const m = model(field("a-b"), field("a_b"));
    expect(findNameCollisions(m, "json-schema")).toEqual([]);
    expect(findNameCollisions(m, "openapi3")).toEqual([]);
    expect(findNameCollisions(model(field("alpha"), field("beta")), "avro")).toEqual([]);
  });

  it("describes a collision with both names and the identifier", () => {
    const text = describeNameCollision({ kind: "field", names: ["a-b", "a_b"], becomes: "a_b" }, "avro");
    expect(text).toContain('"a-b"');
    expect(text).toContain('"a_b"');
    expect(text).toMatch(/Avro/);
  });
});

describe("generation refuses a collision instead of emitting", () => {
  it.each(["avro", "protobuf", "java-pojo"])("%s", async (target) => {
    const result = await emitOfficialTypeSpecTargetFromData(entity, [field("a-b"), field("a_b")], target);
    expect(result.validationStatus).toBe("INVALID");
    expect(result.output).toBe("");
    expect(result.errors[0].message).toContain('"a-b"');
    expect(result.errors[0].message).toContain('"a_b"');
  });
});

describe("the importer warns when names will collide", () => {
  it("names the fields in a warning", () => {
    const parsed = parseJsonSchemaDocument(JSON.stringify({ title: "T", type: "object", properties: { "a-b": { type: "string" }, a_b: { type: "string" }, ok: { type: "string" } } }));
    if (!parsed.success) throw new Error(parsed.error.message);
    expect(parsed.data.warnings.some((w) => w.includes('"a-b"') && w.includes('"a_b"'))).toBe(true);
  });
  it("is silent for distinct names", () => {
    const parsed = parseJsonSchemaDocument(JSON.stringify({ title: "T", type: "object", properties: { alpha: { type: "string" }, beta: { type: "string" } } }));
    if (!parsed.success) throw new Error(parsed.error.message);
    expect(parsed.data.warnings.filter((w) => /collide|same name|both be written/i.test(w))).toEqual([]);
  });
});
