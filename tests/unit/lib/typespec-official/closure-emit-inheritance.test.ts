/**
 * `extends` / spread names are bare and unqualified, so they cannot name a model in another entity's namespace. The Prisma path
 * (`compileEntity`) never sets them, so no real closure member has one today; this pins the guard for the day one does: a clear
 * error Result naming the entity, never a source that binds to the wrong model.
 */
import { describe, it, expect, vi } from "vitest";

vi.mock("@/lib/db", () => ({ prisma: {} }));
vi.mock("@/lib/compiler/compiler.service", async (importOriginal) => {
  const actual = await importOriginal<typeof import("@/lib/compiler/compiler.service")>();
  return {
    ...actual,
    compileEntity: (entity: Parameters<typeof actual.compileEntity>[0], fields: Parameters<typeof actual.compileEntity>[1]) => {
      const model = actual.compileEntity(entity, fields);
      if (entity.name === "Child") return { ...model, entity: { ...model.entity, parentEntityName: "Base" } };
      if (entity.name === "Mixed") return { ...model, entity: { ...model.entity, spreadFrom: ["Base"] } };
      return model;
    },
  };
});

import type { PrismaFieldInput } from "@/lib/compiler/compiler.service";
import type { ClosureEntity } from "@/lib/references/closure";
import { emitClosure } from "@/lib/typespec-official/closure-emit";

const field = (name: string, type: string, sortOrder: number, extra: Partial<PrismaFieldInput> = {}): PrismaFieldInput => ({
  id: `f-${name}`, name, type, precision: null, scale: null, nullable: false, isKey: false,
  fieldNumber: null, description: "", classification: null, aliases: [], decorators: {}, sortOrder, ...extra,
});

const member = (id: string, entity: string): ClosureEntity => ({
  entityId: id,
  ref: { entityId: id, domain: "D", product: "P", entity },
  source: "published",
  fields: [field("id", "string", 0, { isKey: true })],
  entity: { id, name: entity, description: "", status: "PUBLISHED", version: 1, domainId: null, metadata: {}, domain: null },
});

describe("inheritance in a multi-entity closure", () => {
  it.each(["Child", "Mixed"])("%s: refused with a message naming the entity, on every target, before anything is compiled", async (name) => {
    for (const target of ["json-schema", "openapi3", "protobuf", "avro", "java-pojo"]) {
      const result = await emitClosure({ entities: [member("a", "Plain"), member("b", name)], cycles: [] }, target);
      expect(result.success).toBe(false);
      if (result.success) continue;
      expect(result.error.code).toBe("EMISSION_INVALID");
      expect(result.error.message).toContain(name);
      expect(result.error.message).toMatch(/extends/);
    }
  });
});
