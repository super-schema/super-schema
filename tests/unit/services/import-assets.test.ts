import { readFileSync } from "node:fs";
import path from "node:path";
import { describe, it, expect } from "vitest";
import { importSchemaAssets } from "@/services/import.service";

function fixture(name: string): string {
  return readFileSync(path.resolve(process.cwd(), "tests/fixtures/importers", name), "utf8");
}

describe("importSchemaAssets — single vs multi-asset routing", () => {
  it("routes a multi-message proto to the multi-asset review", () => {
    const r = importSchemaAssets(fixture("order.proto"), "protobuf");
    expect(r.success).toBe(true);
    if (!r.success || r.data.kind !== "multi") throw new Error("expected multi");
    expect(r.data.result.sourceFormat).toBe("protobuf");
    expect(r.data.result.models).toHaveLength(4);
    expect(r.data.result.sharedEnums).toHaveLength(2);
  });

  it("auto-detects the format when none is given", () => {
    const r = importSchemaAssets(fixture("order.avsc"));
    expect(r.success).toBe(true);
    if (!r.success || r.data.kind !== "multi") throw new Error("expected multi");
    expect(r.data.result.sourceFormat).toBe("avro");
    expect(r.data.result.models.map((m) => m.name)).toEqual(["Order", "Address", "LineItem"]);
  });

  it("routes a JSON Schema with $defs to the multi-asset review", () => {
    const r = importSchemaAssets(fixture("order.schema.json"), "json-schema");
    expect(r.success).toBe(true);
    if (!r.success || r.data.kind !== "multi") throw new Error("expected multi");
    expect(r.data.result.models.map((m) => m.name)).toEqual(["Order", "Customer", "Address", "LineItem"]);
  });

  it("keeps a single-asset document on the single-entity path, with importer warnings", () => {
    const r = importSchemaAssets(
      `syntax = "proto3";\nimport "acme/money.proto";\nmessage User { string id = 1; acme.Money balance = 2; }`
    );
    expect(r.success).toBe(true);
    if (!r.success || r.data.kind !== "single") throw new Error("expected single");
    expect(r.data.result.parsedEntity.name).toBe("User");
    expect(r.data.result.warnings.some((w) => w.includes("acme/money.proto"))).toBe(true);
    expect(r.data.result.warnings.some((w) => w.includes("low confidence"))).toBe(true);
  });

  it("keeps formats without multi-asset support on the single path", () => {
    const r = importSchemaAssets("CREATE TABLE users (\n  id STRING NOT NULL\n);");
    expect(r.success).toBe(true);
    if (!r.success) return;
    expect(r.data.kind).toBe("single");
  });

  it("returns the parser error", () => {
    const r = importSchemaAssets(`syntax = "proto3";\nmessage { broken`, "protobuf");
    expect(r.success).toBe(false);
    if (r.success) return;
    expect(r.error.code).toBe("PARSE_ERROR");
  });

  it("fails with UNKNOWN_FORMAT for undetectable content", () => {
    const r = importSchemaAssets("just some text");
    expect(r.success).toBe(false);
    if (r.success) return;
    expect(r.error.code).toBe("UNKNOWN_FORMAT");
  });
});
