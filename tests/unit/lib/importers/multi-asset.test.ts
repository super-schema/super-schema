import { readFileSync } from "node:fs";
import path from "node:path";
import { describe, it, expect } from "vitest";
import { parseProtobufDocument } from "@/lib/importers/protobuf.importer";
import { parseAvroDocument } from "@/lib/importers/avro.importer";
import { countImportAssets, toAssetImportResult } from "@/lib/importers/multi-asset";
import type { MultiEntityImportResult } from "@/lib/importers/types";

function fixture(name: string): string {
  return readFileSync(path.resolve(process.cwd(), "tests/fixtures/importers", name), "utf8");
}

function protoDoc(): MultiEntityImportResult {
  const r = parseProtobufDocument(fixture("order.proto"));
  if (!r.success) throw new Error(r.error.message);
  return r.data;
}

describe("toAssetImportResult", () => {
  it("maps every entity to a reviewable model recommended as an entity", () => {
    const result = toAssetImportResult(protoDoc());
    expect(result.sourceFormat).toBe("protobuf");
    expect(result.namespace).toBe("shop.orders.v1");
    expect(result.models.map((m) => m.name)).toEqual(["Order", "Order_LineItem", "Card", "Customer"]);
    expect(result.models.every((m) => m.recommendedAsEntity)).toBe(true);
    expect(result.models[0].fields.length).toBe(13);
  });

  it("derives the reference graph from reference fields (in-document targets only)", () => {
    const result = toAssetImportResult(protoDoc());
    const byName = Object.fromEntries(result.models.map((m) => [m.name, m]));
    expect(byName.Order.referencedModelNames).toEqual(["Order_LineItem", "Card", "Customer"]);
    expect(byName.Order_LineItem.referencedModelNames).toEqual([]); // Money is external
    expect(byName.Order_LineItem.referencedByModelNames.sort()).toEqual(["Card", "Order"]);
    expect(byName.Customer.referencedByModelNames).toEqual(["Order"]);
  });

  it("carries enums as shared enums and scalars as custom scalars", () => {
    const proto = toAssetImportResult(protoDoc());
    expect(proto.sharedEnums.map((e) => e.name)).toEqual(["OrderStatus", "Order_LineItem_Kind"]);

    const avro = parseAvroDocument(fixture("order.avsc"));
    if (!avro.success) throw new Error(avro.error.message);
    const result = toAssetImportResult(avro.data);
    expect(result.customScalars).toEqual([
      { name: "MD5", baseType: "bytes", description: "Avro fixed (16 bytes)" },
    ]);
    expect(result.unions).toEqual([]);
    expect(result.services).toEqual([]);
    expect(result.decoratorDefinitions).toEqual([]);
  });

  it("keeps importer warnings and adds low-confidence field notes", () => {
    const result = toAssetImportResult(protoDoc());
    expect(result.warnings.some((w) => w.includes("OrderService"))).toBe(true);
    expect(
      result.warnings.some((w) => w.includes("Order_LineItem.unit_price") && w.includes("low confidence"))
    ).toBe(true);
  });
});

describe("countImportAssets", () => {
  it("counts entities, enums and scalars", () => {
    expect(countImportAssets(protoDoc())).toBe(6);
  });
});
