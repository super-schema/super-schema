/**
 * What closure emission refuses or survives without ever throwing:
 * - `extends` / spread names are bare and unqualified, so they cannot name a model in another entity's namespace. The Prisma path
 *   (`compileEntity`) never sets them, so no real closure member has one today; this pins the guard for the day one does: a clear
 *   error Result naming the entity, never a source that binds to the wrong model.
 * - a step that throws (compiling an entity) is an `EMISSION_FAILED` Result, not an exception.
 * - two entities that declare the same name make a flat-name-space target say so, instead of an opaque compiler diagnostic.
 */
import { describe, it, expect, vi } from "vitest";

vi.setConfig({ testTimeout: 60_000 });
vi.mock("@/lib/db", () => ({ prisma: {} }));
vi.mock("@/lib/compiler/compiler.service", async (importOriginal) => {
  const actual = await importOriginal<typeof import("@/lib/compiler/compiler.service")>();
  return {
    ...actual,
    compileEntity: (entity: Parameters<typeof actual.compileEntity>[0], fields: Parameters<typeof actual.compileEntity>[1]) => {
      if (entity.name === "Throws") throw new Error("compile exploded");
      const model = actual.compileEntity(entity, fields);
      if (entity.name === "Child") return { ...model, entity: { ...model.entity, parentEntityName: "Base" } };
      if (entity.name === "Mixed") return { ...model, entity: { ...model.entity, spreadFrom: ["Base"] } };
      return model;
    },
  };
});

import type { PrismaFieldInput } from "@/lib/compiler/compiler.service";
import type { ClosureEntity } from "@/lib/references/closure";
import { writeFieldReference } from "@/lib/references/entity-reference";
import { emitClosure } from "@/lib/typespec-official/closure-emit";

const TARGETS = ["json-schema", "openapi3", "protobuf", "avro", "java-pojo"];

const field = (name: string, type: string, sortOrder: number, extra: Partial<PrismaFieldInput> = {}): PrismaFieldInput => ({
  id: `f-${name}`, name, type, precision: null, scale: null, nullable: false, isKey: false,
  fieldNumber: null, description: "", classification: null, aliases: [], decorators: {}, sortOrder, ...extra,
});

const member = (id: string, entity: string, extra: PrismaFieldInput[] = []): ClosureEntity => ({
  entityId: id,
  ref: { entityId: id, domain: "D", product: "P", entity },
  source: "published",
  fields: [field("id", "string", 0, { isKey: true }), ...extra],
  entity: { id, name: entity, description: "", status: "PUBLISHED", version: 1, domainId: null, metadata: {}, domain: null },
});

describe("inheritance in a multi-entity closure", () => {
  it.each(["Child", "Mixed"])("%s: refused with a message naming the entity, on every target, before anything is compiled", async (name) => {
    for (const target of TARGETS) {
      const result = await emitClosure({ entities: [member("a", "Plain"), member("b", name)], cycles: [] }, target);
      expect(result.success).toBe(false);
      if (result.success) continue;
      expect(result.error.code).toBe("EMISSION_INVALID");
      expect(result.error.message).toContain(name);
      expect(result.error.message).toMatch(/extends/);
    }
  });
});

describe("emitClosure never throws", () => {
  it.each(TARGETS)("%s: a step that throws is an EMISSION_FAILED result", async (target) => {
    const result = await emitClosure({ entities: [member("a", "Plain"), member("b", "Throws")], cycles: [] }, target);
    expect(result).toMatchObject({ success: false, error: { code: "EMISSION_FAILED" } });
    expect(!result.success && result.error.message).toContain("compile exploded");
  });

  it("a stand-alone entity whose compile throws is the same result", async () => {
    expect(await emitClosure({ entities: [member("b", "Throws")], cycles: [] }, "json-schema")).toMatchObject({ success: false, error: { code: "EMISSION_FAILED" } });
  });
});

describe("two entities that declare the same name", () => {
  // `Order` has an inline enum field `status`, declared as `Order_status`; the entity `Order_status` is a model of that name.
  const closure = () => {
    const order = member("o", "Order", [
      field("status", "enum", 1, { aliases: ["x", "y"] }),
      field("other", "reference", 2, { decorators: writeFieldReference({}, { entityId: "s", domain: "D", product: "P", entity: "Order_status" }) }),
    ]);
    return { entities: [order, member("s", "Order_status")], cycles: [] };
  };

  it.each(["json-schema", "openapi3"])("%s: refused naming both entities and the name (it would overwrite a file / fail with an opaque diagnostic)", async (target) => {
    const result = await emitClosure(closure(), target);
    expect(result).toMatchObject({ success: false, error: { code: "EMISSION_INVALID" } });
    expect(!result.success && result.error.message).toMatch(/Order and Order_status both declare "Order_status"/);
  });

  it.each(["protobuf", "avro", "java-pojo"])("%s: fine, the names live in different namespaces / packages", async (target) => {
    const result = await emitClosure(closure(), target);
    expect(result.success).toBe(true);
  });
});
