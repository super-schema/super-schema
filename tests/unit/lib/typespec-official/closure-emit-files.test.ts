/**
 * Which files of an emitter run reach the set. The emitter run is faked here (no `tsp`), so the files can be anything an emitter might
 * write: files that match no entity of the closure are dropped on EVERY target, and an entity the emitter left without a file is an
 * error, never a smaller "valid" set.
 */
import { describe, it, expect, vi } from "vitest";

const h = vi.hoisted(() => ({ files: [] as Array<{ relativePath: string; content: string }> }));

vi.mock("@/lib/db", () => ({ prisma: {} }));
vi.mock("@/lib/typespec-official/emitter.service", async (importOriginal) => {
  const actual = await importOriginal<typeof import("@/lib/typespec-official/emitter.service")>();
  return { ...actual, runTypeSpecEmitterWithWarnings: async () => ({ success: true as const, data: { files: h.files, warnings: [] } }) };
});

import type { PrismaFieldInput } from "@/lib/compiler/compiler.service";
import type { ClosureEntity } from "@/lib/references/closure";
import { emitClosure } from "@/lib/typespec-official/closure-emit";

const field = (name: string, sortOrder: number): PrismaFieldInput => ({
  id: `f-${name}`, name, type: "string", precision: null, scale: null, nullable: false, isKey: false,
  fieldNumber: null, description: "", classification: null, aliases: [], decorators: {}, sortOrder,
});
const member = (id: string, entity: string): ClosureEntity => ({
  entityId: id,
  ref: { entityId: id, domain: "D", product: "P", entity },
  source: "published",
  fields: [field("id", 0)],
  entity: { id, name: entity, description: "", status: "PUBLISHED", version: 1, domainId: null, metadata: {}, domain: null },
});
const closure = () => ({ entities: [member("a", "A"), member("b", "B")], cycles: [] as string[][] });

const avro = (name: string, namespace: string) => JSON.stringify({ type: "record", name, namespace, fields: [] });
const proto = (name: string) => `syntax = "proto3";\nmessage ${name} {\n  string id = 1;\n}\n`;

/** The files a well-behaved emitter writes for the closure of A and B, plus one file that belongs to nothing. */
const SETS: Record<string, { own: Array<[string, string]>; foreign: [string, string] }> = {
  "json-schema": { own: [["A.json", "{}"], ["B.json", "{}"]], foreign: ["Foreign.json", "{}"] },
  openapi3: {
    own: [["openapi.SuperSchemaClosure.D.P.A.yaml", "openapi: 3.1.0\n"], ["openapi.SuperSchemaClosure.D.P.B.yaml", "openapi: 3.1.0\n"]],
    foreign: ["openapi.SuperSchemaClosure.Other.X.Y.yaml", "openapi: 3.1.0\n"],
  },
  protobuf: { own: [["D/P/A.proto", proto("A")], ["D/P/B.proto", proto("B")]], foreign: ["Foreign/Thing.proto", proto("Thing")] },
  avro: {
    own: [["com.superschema.d.p.a.A.avsc.json", avro("A", "com.superschema.d.p.a")], ["com.superschema.d.p.b.B.avsc.json", avro("B", "com.superschema.d.p.b")]],
    foreign: ["com.elsewhere.Foreign.avsc.json", avro("Foreign", "com.elsewhere")],
  },
  "java-pojo": { own: [["d/p/a/A.java", "class A {}"], ["d/p/b/B.java", "class B {}"]], foreign: ["lib/Foreign.java", "class Foreign {}"] },
};

const run = async (target: string, files: Array<[string, string]>) => {
  h.files = files.map(([relativePath, content]) => ({ relativePath, content }));
  return emitClosure(closure(), target);
};

describe("files of an emitter run that match no entity of the closure", () => {
  it.each(Object.keys(SETS))("%s: dropped, the entities' files kept", async (target) => {
    const { own, foreign } = SETS[target];
    const result = await run(target, [...own, foreign]);
    expect(result.success).toBe(true);
    if (!result.success) return;
    expect(result.data.files.map((f) => f.entityId).sort()).toEqual(["a", "b"]);
    expect(result.data.files.map((f) => f.path).join("\n")).not.toMatch(/Foreign|Thing|Other/);
    expect(Object.keys(result.data.entityFiles).sort()).toEqual(["a", "b"]);
  });

  it.each(Object.keys(SETS))("%s: an entity the emitter wrote no file for is an error naming it", async (target) => {
    const { own, foreign } = SETS[target];
    const result = await run(target, [own[0], foreign]);
    expect(result).toMatchObject({ success: false, error: { code: "EMISSION_INVALID" } });
    expect(!result.success && result.error.message).toMatch(/wrote no (file|document|message)[^\n]* for B/);
  });

  it("only foreign files: nothing is left, which is an error too", async () => {
    const result = await run("json-schema", [SETS["json-schema"].foreign]);
    expect(result).toMatchObject({ success: false, error: { code: "EMITTER_NO_OUTPUT" } });
  });
});
