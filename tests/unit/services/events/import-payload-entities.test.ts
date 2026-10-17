import { describe, expect, it, vi } from "vitest";
import { ok, type Result } from "@/types/result";
import type { ParsedField } from "@/lib/importers/types";
import { resolveEntityNames, type NameAllocator, type PlannedPayload } from "@/services/events/import-payload-entities";

// The module's service imports reach `@/lib/db`; nothing here touches a database.
vi.mock("@/lib/db", () => ({ prisma: { tag: "prisma" } }));

// Field names whose URL slugs collide (the unique (entity, slug) index would turn them into an opaque failure after a clean preview).
// `resolveEntityNames` is pure apart from the allocator, which is a stand-in here (it keeps every name).

const keep: NameAllocator = { allocate: async (requested): Promise<Result<string>> => ok(requested) };
const field = (name: string): ParsedField => ({ name, type: "string", nullable: false, confidence: "high", originalType: "string" });
const plan = (...names: string[]): PlannedPayload => ({
  pinKey: "m:payload", sourcePointer: "/components/messages/m/payload", format: "json-schema",
  entities: [{ requestedName: "Order", sourceName: "Order", description: "", fields: names.map(field) }],
});
const namesOf = async (...fields: string[]) => {
  const resolved = await resolveEntityNames([plan(...fields)], keep);
  if (!resolved.success) throw new Error(resolved.error.message);
  return { names: resolved.data.payloads[0].entities[0].input.fields.map((f) => f.name), warnings: resolved.data.warnings };
};

describe("resolveEntityNames: field slug collisions", () => {
  it("leaves fields whose slugs differ alone, with no warning", async () => {
    const { names, warnings } = await namesOf("id", "Order Id", "order_total", "total");
    expect(names).toEqual(["id", "Order Id", "order_total", "total"]);
    expect(warnings).toEqual([]);
  });

  it("numbers the later of two fields with the same slug (a b / a-b / a_b are all a-b) and names entity and field in a SANITIZED_VALUE warning", async () => {
    const { names, warnings } = await namesOf("a b", "a-b", "a_b");
    expect(names).toEqual(["a b", "a-b2", "a_b3"]);
    expect(warnings.map((w) => [w.code, w.pointer, w.message])).toEqual([
      ["SANITIZED_VALUE", "/components/messages/m/payload", 'Entity "Order": the field "a-b" has the same URL slug as an earlier field, so it is named "a-b2"'],
      ["SANITIZED_VALUE", "/components/messages/m/payload", 'Entity "Order": the field "a_b" has the same URL slug as an earlier field, so it is named "a_b3"'],
    ]);
  });

  it("names with no Latin letter slug to empty: the first keeps its name, the others are numbered (and the numbers are free)", async () => {
    const jp = "日本語";
    const cn = "中文";
    const kr = "한국어";
    const { names } = await namesOf(jp, cn, kr, "2", "3");
    // `cn` -> "<cn>2" (slug "2"), `kr` -> "<kr>3" (slug "3"); the fields named "2" and "3" then collide and are numbered too
    expect(names.slice(0, 3)).toEqual([jp, `${cn}2`, `${kr}3`]);
    expect(new Set(names)).toHaveProperty("size", 5);
    expect(names[3]).not.toBe("2");
    expect(names[4]).not.toBe("3");
  });

  it("a number that is itself taken is skipped (a-b2 exists as a field already)", async () => {
    const { names } = await namesOf("a-b2", "a b", "a-b");
    expect(names).toEqual(["a-b2", "a b", "a-b3"]);
  });

  it("2,000 fields of empty slug stay fast (linear, not quadratic) and unique, and only 50 are reported plus one summary", async () => {
    const fields = Array.from({ length: 2000 }, (_, i) => String.fromCodePoint(0x4e00 + i)); // 2,000 different CJK characters, all slug ""
    const started = performance.now();
    const { names, warnings } = await namesOf(...fields);
    expect(performance.now() - started).toBeLessThan(2_000);
    expect(new Set(names).size).toBe(2000);
    expect(names[0]).toBe(fields[0]);
    expect(warnings.filter((w) => w.message.startsWith('Entity "Order"'))).toHaveLength(50);
    expect(warnings.at(-1)).toEqual({ pointer: "", code: "SANITIZED_VALUE", message: "1949 more fields were renamed because their URL slugs collided; they are not listed" });
    expect(warnings).toHaveLength(51);
  });
});
