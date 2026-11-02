/**
 * An entity stored before built-in names were refused (final wave 2b, G6) still emits valid output: the closure qualifies its name (a
 * deterministic `_Entity` suffix on the namespace segment and the model name, so on every file / package / record / class name) instead
 * of letting it shadow the built-in type. Before: an entity `url` next to a `url`-typed field failed JSON Schema / OpenAPI / Protobuf
 * with an opaque diagnostic, and an entity `String` made Java emit `import d.p.string.String;`, silently retyping `private String id`.
 *
 * Runs the real `tsp compile` through the emitter runner (about 1 s each).
 */
import { describe, it, expect, vi } from "vitest";
import { spawnSync } from "node:child_process";
import { mkdtempSync, mkdirSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import path from "node:path";

vi.setConfig({ testTimeout: 60_000, hookTimeout: 120_000 });
vi.mock("@/lib/db", () => ({ prisma: {} }));

import type { PrismaFieldInput } from "@/lib/compiler/compiler.service";
import type { ClosureEntity, ReferenceClosure } from "@/lib/references/closure";
import { writeFieldReference, type EntityRef } from "@/lib/references/entity-reference";
import { emitClosure, type EmittedFile } from "@/lib/typespec-official/closure-emit";

const TARGETS = ["json-schema", "openapi3", "protobuf", "avro", "java-pojo"] as const;

const field = (name: string, type: string, sortOrder: number, decorators: Record<string, unknown> = {}, extra: Partial<PrismaFieldInput> = {}): PrismaFieldInput => ({
  id: `f-${name}`, name, type, precision: null, scale: null, nullable: false, isKey: false,
  fieldNumber: null, description: "", classification: null, aliases: [], decorators, sortOrder, ...extra,
});

function member(id: string, entity: string, fields: PrismaFieldInput[] = [], domain = "D", product = "P"): ClosureEntity {
  const ref: EntityRef = { entityId: id, domain, product, entity };
  return {
    entityId: id,
    ref,
    source: "published",
    version: "1.0",
    fields: [field("id", "string", 0, {}, { isKey: true }), ...fields],
    entity: { id, name: entity, description: "", status: "PUBLISHED", version: 1, domainId: null, metadata: {}, domain: null },
  };
}

const refTo = (id: string, entity: string, domain = "D", product = "P") => writeFieldReference({}, { entityId: id, domain, product, entity }) as Record<string, unknown>;
const closureOf = (entities: ClosureEntity[]): ReferenceClosure => ({ root: entities[0], entities, draftEntities: [], cycles: [], upgrades: [], notes: [] });

/** Order has a field of the SCALAR `scalar` and a reference to the ENTITY of that very name. */
const closureFor = (entityName: string, scalar: string) =>
  closureOf([
    member("o", "Order", [field("home", scalar, 1), field("ref", "reference", 2, refTo("b", entityName))]),
    member("b", entityName, [field("note", "string", 1)]),
  ]);

const JAVAC_AVAILABLE = spawnSync("javac", ["-version"]).status === 0;
function compileJava(files: EmittedFile[]): { status: number | null; stderr: string } {
  const dir = mkdtempSync(path.join(tmpdir(), "closure-builtin-javac-"));
  try {
    const sources: string[] = [];
    for (const f of files) {
      const full = path.join(dir, "src", f.path);
      mkdirSync(path.dirname(full), { recursive: true });
      writeFileSync(full, f.content);
      sources.push(full);
    }
    const compiled = spawnSync("javac", ["-d", path.join(dir, "out"), ...sources], { encoding: "utf8" });
    return { status: compiled.status, stderr: compiled.stderr };
  } finally {
    rmSync(dir, { recursive: true, force: true });
  }
}

describe("an entity named like a built-in scalar that another entity's field uses", () => {
  it.each([
    ["url", "url"],
    ["int32", "int32"],
    ["duration", "duration"],
    ["Url", "url"],
  ])("entity %s next to a %s field: every target emits, each entity with a file of its own", async (entityName, scalar) => {
    for (const target of TARGETS) {
      const result = await emitClosure(closureFor(entityName, scalar), target);
      expect(result.success, `${target}: ${result.success ? "" : result.error.message}`).toBe(true);
      if (!result.success) continue;
      expect(result.data.files, target).toHaveLength(2);
      expect(result.data.entityFiles.o, target).toHaveLength(1);
      expect(result.data.entityFiles.b, target).toHaveLength(1);
    }
  });

  it("names the qualified entity with the suffix on every target (the namespace segment, the model, the files)", async () => {
    const paths = async (target: (typeof TARGETS)[number]) => {
      const result = await emitClosure(closureFor("url", "url"), target);
      if (!result.success) throw new Error(`${target}: ${result.error.message}`);
      return result.data.files.map((f) => f.path);
    };
    expect(await paths("json-schema")).toEqual(["Order.json", "url_Entity.json"]);
    expect(await paths("openapi3")).toEqual(["openapi.D.P.Order.yaml", "openapi.D.P.url_Entity.yaml"]);
    expect(await paths("protobuf")).toEqual(["D/P/Order.proto", "D/P/url_Entity.proto"]);
    expect(await paths("avro")).toEqual(["com.superschema.d.p.order.Order.avsc.json", "com.superschema.d.p.url_entity.UrlEntity.avsc.json"]);
    expect(await paths("java-pojo")).toEqual(["d/p/order/Order.java", "d/p/url_entity/UrlEntity.java"]);
  });

  it("an entity that is NOT a built-in keeps its own name (nothing is suffixed)", async () => {
    const result = await emitClosure(closureFor("Customer", "url"), "json-schema");
    expect(result.success && result.data.files.map((f) => f.path)).toEqual(["Customer.json", "Order.json"]);
  });

  it("a domain or product named like a built-in is qualified too", async () => {
    const closure = closureOf([
      member("o", "Order", [field("home", "url", 1), field("ref", "reference", 2, refTo("b", "Address", "url", "string"))]),
      member("b", "Address", [field("zip", "string", 1)], "url", "string"),
    ]);
    for (const target of TARGETS) {
      const result = await emitClosure(closure, target);
      expect(result.success, `${target}: ${result.success ? "" : result.error.message}`).toBe(true);
    }
  });
});

// M6: the suffix changes generated namespaces, packages and file paths (a product named `Record` moves every file of the product), so the
// emission SAYS so, once per name, instead of changing paths without a word.
describe("the note that a built-in name is qualified", () => {
  const warningsOf = async (closure: ReferenceClosure, target: (typeof TARGETS)[number] = "json-schema") => {
    const result = await emitClosure(closure, target);
    if (!result.success) throw new Error(result.error.message);
    return result.data.warnings.filter((w) => w.includes("built-in type name"));
  };

  it("names the domain, the product and the entity that are qualified, once each, with the name they get", async () => {
    const closure = closureOf([
      member("o", "Order", [field("ref", "reference", 1, refTo("b", "Address", "url", "string")), field("ref2", "reference", 2, refTo("c", "url"))]),
      member("b", "Address", [field("zip", "string", 1)], "url", "string"),
      member("c", "url", [field("note", "string", 1)]),
      member("d", "Other", [field("zip", "string", 1)], "url", "string"),
    ]);
    const notes = await warningsOf(closure);
    expect(notes).toHaveLength(3);
    expect(notes.find((n) => n.startsWith('The domain "url"'))).toContain('"url_Entity"');
    expect(notes.find((n) => n.startsWith('The product "string"'))).toContain('"string_Entity"');
    expect(notes.find((n) => n.startsWith('The entity "url"'))).toContain('"url_Entity"');
    // one line per name, however many entities live in it (Address and Other are both in url / string)
    expect(notes.filter((n) => n.startsWith('The domain "url"'))).toHaveLength(1);
  });

  it("says nothing when no name is a built-in", async () => {
    expect(await warningsOf(closureFor("Customer", "url"))).toEqual([]);
  });
});

describe("Java: an entity named like a java.lang type", () => {
  const closure = () =>
    closureOf([
      member("o", "Order", [field("ref", "reference", 1, refTo("s", "String")), field("other", "reference", 2, refTo("j", "Object")), field("label", "string", 3)]),
      member("s", "String", [field("note", "string", 1)]),
      member("j", "Object", [field("note", "string", 1)]),
    ]);

  it("keeps `private String label` the java.lang type: no entity class is imported as String or Object", async () => {
    const result = await emitClosure(closure(), "java-pojo");
    expect(result.success, result.success ? "" : result.error.message).toBe(true);
    if (!result.success) return;
    const order = result.data.files.find((f) => f.path.endsWith("/Order.java"))?.content ?? "";
    expect(order).toMatch(/private String label;/);
    expect(order).not.toMatch(/import [\w.]+\.String;/);
    expect(order).not.toMatch(/import [\w.]+\.Object;/);
    expect(result.data.files.map((f) => f.path)).toEqual(["d/p/object_entity/ObjectEntity.java", "d/p/order/Order.java", "d/p/string_entity/StringEntity.java"]);
    if (JAVAC_AVAILABLE) {
      const compiled = compileJava(result.data.files);
      expect(compiled.status, compiled.stderr).toBe(0);
    }
  });
});
