// @vitest-environment node
/**
 * The sample documents of the browser suite's importer spec (tests/e2e/fixtures/importer-samples) must stay importable: a sample that
 * stops parsing would otherwise show up as a failure of a minutes-long browser run. Format detection is by file name and content, as
 * the workbench does it; the parse is the importer's own (the TypeSpec and OpenAPI samples are compiled by server actions that need a
 * session, so only their detection is checked here, the browser run compiles them).
 */
import { readFileSync } from "node:fs";
import path from "node:path";
import { describe, expect, it } from "vitest";
import { detectFormat } from "@/lib/importers/format-detector";
import { importSchemaAssets } from "@/services/import.service";

const DIR = path.join(__dirname, "../../e2e/fixtures/importer-samples");
const sample = (name: string) => readFileSync(path.join(DIR, name), "utf8");

describe("the importer samples of the browser suite", () => {
  it.each([
    ["order-placed.avsc", "avro"],
    ["shipment.proto", "protobuf"],
    ["store-api.openapi.yaml", "openapi"],
    ["sales-orders.sql", "bigquery-ddl"],
    ["catalog-models.tsp", "typespec"],
    ["support-ticket.schema.json", "json-schema"],
  ] as const)("%s is detected as %s", (file, format) => {
    expect(detectFormat(sample(file), file)).toBe(format);
    // Pasted (no file name) the content alone decides the same.
    expect(detectFormat(sample(file))).toBe(format);
  });

  function route(file: string) {
    const result = importSchemaAssets(sample(file), detectFormat(sample(file), file));
    if (!result.success) throw new Error(`${file} did not import: ${result.error.message}`);
    return result.data;
  }

  it("order-placed.avsc is a record and an enum: the multi-asset review", () => {
    const data = route("order-placed.avsc");
    expect(data.kind).toBe("multi");
    if (data.kind !== "multi") return;
    expect(data.result.models.map((m) => m.name)).toEqual(["OrderPlaced"]);
    expect(data.result.models[0].fields.map((f) => `${f.name}:${f.type}`)).toEqual([
      "orderId:string", "placedAt:utcDateTime", "shipDate:plainDate", "total:decimal", "couponCode:string", "lineSkus:array", "labels:map", "status:enum",
    ]);
    expect(data.result.sharedEnums.map((e) => e.name)).toEqual(["OrderStatus"]);
  });

  it("shipment.proto is two messages (the nested one) and an enum: the multi-asset review", () => {
    const data = route("shipment.proto");
    expect(data.kind).toBe("multi");
    if (data.kind !== "multi") return;
    expect(data.result.models.map((m) => m.name)).toEqual(["Shipment", "Shipment_Address"]);
    expect(data.result.models[0].fields.map((f) => f.name)).toEqual(["shipment_id", "carrier", "tracking_events", "attributes", "destination", "email", "phone"]);
    expect(data.result.sharedEnums.map((e) => e.name)).toEqual(["Carrier"]);
  });

  it("sales-orders.sql is one entity, with a low-confidence note for each of the nested types", () => {
    const data = route("sales-orders.sql");
    expect(data.kind).toBe("single");
    if (data.kind !== "single") return;
    const { parsedEntity, warnings } = data.result;
    expect(parsedEntity.name).toBe("orders");
    expect(parsedEntity.fields.map((f) => `${f.name}:${f.type}:${f.confidence}`)).toEqual([
      "order_id:string:high", "placed_at:utcDateTime:high", "total:decimal:high", "items:array:low", "shipping:object:low", "tags:array:low",
    ]);
    expect(warnings).toHaveLength(3);
  });

  it("support-ticket.schema.json is one entity of four fields", () => {
    const data = route("support-ticket.schema.json");
    expect(data.kind).toBe("single");
    if (data.kind !== "single") return;
    expect(data.result.parsedEntity.name).toBe("SupportTicket");
    expect(data.result.parsedEntity.fields.map((f) => `${f.name}:${f.type}`)).toEqual(["id:string", "subject:string", "priority:enum", "openedAt:utcDateTime"]);
  });
});
