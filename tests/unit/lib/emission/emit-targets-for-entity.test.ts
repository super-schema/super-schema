import { beforeEach, describe, expect, it, vi } from "vitest";

const h = vi.hoisted(() => ({ emitClosure: vi.fn(), emitStandalone: vi.fn() }));
vi.mock("@/lib/db", () => ({ prisma: {} }));
vi.mock("@/lib/typespec-official/closure-emit", async (importOriginal) => ({
  ...(await importOriginal<typeof import("@/lib/typespec-official/closure-emit")>()),
  emitClosure: h.emitClosure,
}));
vi.mock("@/lib/typespec-official/emitter.service", async (importOriginal) => ({
  ...(await importOriginal<typeof import("@/lib/typespec-official/emitter.service")>()),
  emitOfficialTypeSpecTargetFromData: h.emitStandalone,
}));

import { emitTargetsForEntity } from "@/lib/emission/emission.service";
import { getSchemaTargetDefinition, type SchemaTargetDefinition } from "@/lib/schema-targets/catalog";
import type { PrismaEntityInput } from "@/lib/compiler/compiler.service";

type Row = { id: string; name: string; domain?: string; product?: string; refs?: Array<[string, Record<string, unknown>]> };

/** A fake client: entities of tenant t1 whose live fields are reference fields (decorators given), nothing published. */
function fakeDb(rows: Row[]) {
  const findMany = vi.fn(async ({ where }: { where: { tenantId: string } }) =>
    where.tenantId !== "t1"
      ? []
      : rows.map((r) => ({
          id: r.id,
          name: r.name,
          description: "",
          status: "DRAFT",
          version: 1,
          domainId: r.domain ? `d-${r.domain}` : null,
          metadata: null,
          latestVersionId: null,
          domain: r.domain ? { id: `d-${r.domain}`, name: r.domain, slug: r.domain } : null,
          product: r.product ? { name: r.product } : null,
        }))
  );
  const db = {
    entity: { findMany, findUnique: async () => ({ metadata: null }) },
    field: {
      findMany: async ({ where }: { where: { entityId: string } }) =>
        (rows.find((r) => r.id === where.entityId)?.refs ?? []).map(([name, decorators], i) => ({
          id: `${where.entityId}-${name}`, name, type: "reference", precision: null, scale: null, nullable: true, isKey: false, fieldNumber: null,
          description: "", classification: null, aliases: [], decorators, sortOrder: i,
        })),
    },
    entityVersion: { findUnique: async () => null },
  };
  return { db: db as never, findMany };
}

const target = (key: string) => getSchemaTargetDefinition(key) as SchemaTargetDefinition;
const ENTITY = { id: "a", name: "A", description: "", status: "DRAFT", version: 1, domainId: null, metadata: null, domain: null, tenantId: "t1" } as PrismaEntityInput & { tenantId: string };
const closureOk = (key: string) => ({
  success: true,
  data: { files: [{ path: `${key}.out`, content: key, target: key, entityId: "a" }], warnings: [], entityFiles: { a: [`${key}.out`] } },
});

beforeEach(() => {
  h.emitClosure.mockReset();
  h.emitStandalone.mockReset();
  h.emitClosure.mockImplementation(async (_closure: unknown, key: string) => closureOk(key));
  h.emitStandalone.mockResolvedValue({ output: "DDL", validationStatus: "VALID", warnings: [], errors: [] });
});

describe("emitTargetsForEntity", () => {
  it("loads the closure once for every closure target, emits each from it and describes the versions used", async () => {
    const { db, findMany } = fakeDb([
      { id: "a", name: "A", refs: [["b", { referencedEntityName: "B" }]] },
      { id: "b", name: "B" },
    ]);
    const run = await emitTargetsForEntity(db, ENTITY, [], [target("json-schema"), target("avro")], "draft");
    expect(findMany).toHaveBeenCalledTimes(1);
    expect(h.emitClosure).toHaveBeenCalledTimes(2);
    const closure = h.emitClosure.mock.calls[0][0] as { entities: Array<{ entityId: string }> };
    expect(closure.entities.map((e) => e.entityId)).toEqual(["a", "b"]);
    expect(run.refusal).toBeUndefined();
    expect(run.results.map((r) => [r.target.key, r.result.validationStatus, r.result.files?.length])).toEqual([["json-schema", "VALID", 1], ["avro", "VALID", 1]]);
    expect(run.resolution).toMatchObject({ mode: "draft", preview: true });
    expect(run.resolution?.entities.map((e) => e.ref.entity)).toEqual(["A", "B"]);
  });

  it("emits a DB target on its own from the entity it was given, with no closure and no files", async () => {
    const { db, findMany } = fakeDb([{ id: "a", name: "A" }]);
    const run = await emitTargetsForEntity(db, ENTITY, [], [target("bigquery")], "draft");
    expect(findMany).not.toHaveBeenCalled();
    expect(h.emitClosure).not.toHaveBeenCalled();
    expect(h.emitStandalone).toHaveBeenCalledWith(ENTITY, [], "bigquery");
    expect(run.results[0].result).toEqual({ output: "DDL", validationStatus: "VALID", warnings: [], errors: [] });
    expect(run.resolution).toBeUndefined();
  });

  it("does not hand the stored schema versions of the entity to a DB target (emission never reads them)", async () => {
    const { db } = fakeDb([{ id: "a", name: "A" }]);
    const withVersions = { ...ENTITY, metadata: { tags: ["t"], schemaVersions: { bigquery: [{ version: 1, output: "x" }] } } } as typeof ENTITY;
    await emitTargetsForEntity(db, withVersions, [], [target("bigquery")], "draft");
    expect(h.emitStandalone).toHaveBeenCalledWith({ ...ENTITY, metadata: { tags: ["t"] } }, [], "bigquery");
    expect(withVersions.metadata).toHaveProperty("schemaVersions"); // the caller's entity is untouched
  });

  it("refuses an ambiguous reference: closure targets are INVALID with the message, the DB target still emits, the refusal is structured", async () => {
    const { db } = fakeDb([
      { id: "a", name: "A", refs: [["addr", { referencedEntityName: "Address" }]] },
      { id: "x1", name: "Address", domain: "d1", product: "p1" },
      { id: "x2", name: "Address", domain: "d2", product: "p2" },
    ]);
    const run = await emitTargetsForEntity(db, ENTITY, [], [target("json-schema"), target("bigquery")], "draft");
    expect(run.refusal).toMatchObject({ code: "AMBIGUOUS_REFERENCE", details: { field: "addr", entityId: "a", fieldId: "a-addr" } });
    expect(h.emitClosure).not.toHaveBeenCalled();
    const [closureTarget, dbTarget] = run.results;
    expect(closureTarget.result).toMatchObject({ validationStatus: "INVALID", output: "", errors: [{ message: run.refusal?.message }] });
    expect(dbTarget.result.validationStatus).toBe("VALID");
    expect(run.resolution).toBeUndefined();
  });

  it("in published mode resolves through published versions only (a never-published root is refused by name)", async () => {
    const { db } = fakeDb([{ id: "a", name: "A" }]);
    const run = await emitTargetsForEntity(db, ENTITY, [], [target("openapi3")], "published");
    expect(run.refusal).toMatchObject({ code: "NEVER_PUBLISHED" });
    expect(run.refusal?.message).toContain("A");
    expect(h.emitClosure).not.toHaveBeenCalled();
  });
});
