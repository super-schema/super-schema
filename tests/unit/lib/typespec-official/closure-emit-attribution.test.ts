/**
 * Which entity a file written by an emitter belongs to (final wave 2b, G5). Avro and Java used to match a file to an entity by
 * lowercased alphanumerics and take the first match, so `OrderItem` and `Order_Item` of one product (two namespaces, `orderitem` and
 * `order_item`, that the emitter keeps apart) were one entity and the other failed with "emitter wrote no file" although both
 * files were written. A file is now attributed by the EXACT namespace / package and record / class the emitter writes, and two
 * entities that would be written as one record / class are refused up front, naming both.
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
    fields: [field("id", "uuid", 0, {}, { isKey: true }), ...fields],
    entity: { id, name: entity, description: "", status: "PUBLISHED", version: 1, domainId: null, metadata: {}, domain: null },
  };
}

const refTo = (id: string, entity: string) => writeFieldReference({}, { entityId: id, domain: "D", product: "P", entity }) as Record<string, unknown>;
const closureOf = (entities: ClosureEntity[]): ReferenceClosure => ({ root: entities[0], entities, draftEntities: [], cycles: [], upgrades: [], notes: [] });

/** Order -> OrderItem and Order -> Order_Item: two entities of one product whose names differ only by an underscore. */
const underscoreClosure = () =>
  closureOf([
    member("o", "Order", [field("a", "reference", 1, refTo("i1", "OrderItem")), field("b", "reference", 2, refTo("i2", "Order_Item"))]),
    member("i1", "OrderItem", [field("sku", "string", 1)]),
    member("i2", "Order_Item", [field("note", "string", 1)]),
  ]);

const JAVAC_AVAILABLE = spawnSync("javac", ["-version"]).status === 0;
function compileJava(files: EmittedFile[]): { status: number | null; stderr: string } {
  const dir = mkdtempSync(path.join(tmpdir(), "closure-attribution-javac-"));
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

describe("OrderItem and Order_Item in one product", () => {
  it.each(TARGETS)("%s: every entity is served by a file of its own", async (target) => {
    const result = await emitClosure(underscoreClosure(), target);
    expect(result.success, result.success ? "" : result.error.message).toBe(true);
    if (!result.success) return;
    const { files, entityFiles } = result.data;
    for (const id of ["o", "i1", "i2"]) expect(entityFiles[id], `${target}: ${id}`).toHaveLength(1);
    // each file is attributed to the entity it was written for (not the first one whose name looks alike)
    const owner = (id: string) => files.find((f) => f.entityId === id)?.path;
    expect(new Set(["o", "i1", "i2"].map(owner)).size).toBe(3);
  });

  it("avro: the two records live in the namespaces `orderitem` and `order_item`, each served by its own file", async () => {
    const result = await emitClosure(underscoreClosure(), "avro");
    expect(result.success).toBe(true);
    if (!result.success) return;
    expect(result.data.files.map((f) => [f.path, f.entityId])).toEqual([
      ["com.superschema.d.p.order.Order.avsc.json", "o"],
      ["com.superschema.d.p.order_item.OrderItem.avsc.json", "i2"],
      ["com.superschema.d.p.orderitem.OrderItem.avsc.json", "i1"],
    ]);
  });

  it("java: the two classes live in the packages `d.p.orderitem` and `d.p.order_item`, each served by its own file, and compile together", async () => {
    const result = await emitClosure(underscoreClosure(), "java-pojo");
    expect(result.success).toBe(true);
    if (!result.success) return;
    expect(result.data.files.map((f) => [f.path, f.entityId])).toEqual([
      ["d/p/order/Order.java", "o"],
      ["d/p/order_item/OrderItem.java", "i2"],
      ["d/p/orderitem/OrderItem.java", "i1"],
    ]);
    if (JAVAC_AVAILABLE) {
      const compiled = compileJava(result.data.files);
      expect(compiled.status, compiled.stderr).toBe(0);
    }
  });
});

describe("two entities that the emitter would write as one record / class", () => {
  // `order_item` and `Order_Item`: the emitters lowercase the namespace (`order_item` both) and PascalCase the record / class name
  // (`OrderItem` both), so one file would overwrite the other.
  const colliding = () =>
    closureOf([
      member("o", "Order", [field("a", "reference", 1, refTo("i1", "order_item")), field("b", "reference", 2, refTo("i2", "Order_Item"))]),
      member("i1", "order_item", [field("sku", "string", 1)]),
      member("i2", "Order_Item", [field("note", "string", 1)]),
    ]);

  it.each(["avro", "java-pojo"] as const)("%s: refused before anything is emitted, naming both entities and saying to rename one", async (target) => {
    const result = await emitClosure(colliding(), target);
    expect(result.success).toBe(false);
    if (result.success) return;
    expect(result.error.code).toBe("EMISSION_INVALID");
    expect(result.error.message).toContain("order_item");
    expect(result.error.message).toContain("Order_Item");
    expect(result.error.message).toMatch(/Rename one of them/);
    expect(result.error.message).not.toMatch(/wrote no file/);
  });

  it("avro: a pair that stays apart (different namespaces) is not refused", async () => {
    const result = await emitClosure(underscoreClosure(), "avro");
    expect(result.success).toBe(true);
  });
});
