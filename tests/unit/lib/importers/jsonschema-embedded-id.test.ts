import { describe, expect, it } from "vitest";
import { parseJsonSchemaDocument } from "@/lib/importers/jsonschema.importer";

// Found by the corpus round trip: the app's own JSON Schema output bundles every declaration under `$defs` with its own `$id`
// (`"$defs": { "Order_s": { "$id": "Order_s.json", ... } }`) and points at it by that `$id` (`"$ref": "Order_s.json"`). That is how
// a compound document refers to an embedded resource, but the importer only knew `#/$defs/...` pointers, so re-importing its own
// output turned every enum into a dangling reference to a file that is in the same document.
const bundle = (defs: Record<string, unknown>) => JSON.stringify({ $schema: "https://json-schema.org/draft/2020-12/schema", $id: "Order", $defs: defs });

describe("a $ref that names the $id of an embedded $defs resource", () => {
  const doc = bundle({
    Order: {
      $schema: "https://json-schema.org/draft/2020-12/schema", $id: "Order.json", type: "object",
      properties: { status: { $ref: "Order_status.json" }, line: { $ref: "Line.json" }, lines: { type: "array", items: { $ref: "Line.json" } } },
      required: ["status"],
    },
    Order_status: { $id: "Order_status.json", type: "string", enum: ["NEW", "PAID"] },
    Line: { $id: "Line.json", type: "object", properties: { sku: { type: "string" } } },
  });

  it("resolves to the embedded enum, with its values and no dangling marker", () => {
    const parsed = parseJsonSchemaDocument(doc);
    expect(parsed.success).toBe(true);
    if (!parsed.success) return;
    const order = parsed.data.entities.find((e) => e.name === "Order")!;
    const status = order.fields.find((f) => f.name === "status")!;
    expect(status.type).toBe("enum");
    expect(status.enumValues).toEqual(["NEW", "PAID"]);
    expect(status.danglingRef).toBeUndefined();
  });

  it("resolves to the embedded entity, also as the items of an array", () => {
    const parsed = parseJsonSchemaDocument(doc);
    if (!parsed.success) throw new Error(parsed.error.message);
    const order = parsed.data.entities.find((e) => e.name === "Order")!;
    const line = order.fields.find((f) => f.name === "line")!;
    const lines = order.fields.find((f) => f.name === "lines")!;
    expect(line).toMatchObject({ type: "reference", referencedEntityName: "Line", confidence: "high" });
    expect(line.danglingRef).toBeUndefined();
    expect(lines).toMatchObject({ type: "array", arrayElementType: "reference", referencedEntityName: "Line" });
    expect(lines.danglingRef).toBeUndefined();
  });

  it("still treats a $ref that matches no embedded $id as a dangling external reference", () => {
    const parsed = parseJsonSchemaDocument(JSON.stringify({ title: "T", type: "object", properties: { x: { $ref: "other.json" } }, $defs: { Y: { $id: "y.json", type: "string", enum: ["a"] } } }));
    if (!parsed.success) throw new Error(parsed.error.message);
    expect(parsed.data.entities[0].fields[0].danglingRef).toMatchObject({ ref: "other.json" });
  });
});
