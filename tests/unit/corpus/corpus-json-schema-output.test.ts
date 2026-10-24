/**
 * The corpus judges the app's JSON Schema output. Since closure emission there is no `bundleId`: the output is one bare document,
 * or several `===== <Name>.json =====` documents that reference each other by file. The validator and the round trip must read both.
 */
import { describe, it, expect, vi } from "vitest";

vi.mock("server-only", () => ({}));

import { validateJsonSchema, splitBundledFiles } from "../../helpers/corpus/validators";
import { asImportableDocument, compareRoundTrip } from "../../helpers/corpus/roundtrip";
import { parseJsonSchemaDocument } from "@/lib/importers/jsonschema.importer";

const DIALECT = "https://json-schema.org/draft/2020-12/schema";
const doc = (id: string, body: Record<string, unknown>) => JSON.stringify({ $schema: DIALECT, $id: id, type: "object", ...body }, null, 2);
const bundle = (files: Record<string, string>) => Object.entries(files).map(([name, body]) => `===== ${name} =====\n${body}`).join("\n\n");

describe("validateJsonSchema", () => {
  it("accepts one bare document", async () => {
    const result = await validateJsonSchema(doc("Order.json", { properties: { id: { type: "string" } } }));
    expect(result).toMatchObject({ ok: true });
  });

  it("resolves a $ref to a sibling file of a multi-file output", async () => {
    const output = bundle({
      "Order.json": doc("Order.json", { properties: { ship: { $ref: "Address.json" } } }),
      "Address.json": doc("Address.json", { properties: { city: { type: "string" } } }),
    });
    expect(splitBundledFiles(output).map((f) => f.name)).toEqual(["Order.json", "Address.json"]);
    expect(await validateJsonSchema(output)).toMatchObject({ ok: true, tier: "ajv 8 meta-schema compile" });
  });

  it("tolerates an external $ref that no document of the output defines (kept dangling on purpose), with and without a pointer", async () => {
    const bare = doc("Evt.json", { properties: { when: { $ref: "common_components/v4/date_time.json" }, money: { $ref: "../shared/common.json#/$defs/Money" } } });
    expect(await validateJsonSchema(bare)).toMatchObject({ ok: true, tier: expect.stringContaining("dangling external $ref tolerated") });
    const output = bundle({ "Evt.json": bare, "Other.json": doc("Other.json", { properties: { x: { $ref: "Evt.json" } } }) });
    expect(await validateJsonSchema(output)).toMatchObject({ ok: true });
  });

  it("still fails a document that is not a valid schema, or not JSON, in any file of the output", async () => {
    const broken = bundle({ "A.json": doc("A.json", { properties: {} }), "B.json": doc("B.json", { properties: { x: { type: 5 } } }) });
    expect(await validateJsonSchema(broken)).toMatchObject({ ok: false });
    expect(await validateJsonSchema(bundle({ "A.json": "{ nope" }))).toMatchObject({ ok: false, error: expect.stringContaining("A.json") });
    expect(await validateJsonSchema("[]")).toMatchObject({ ok: false });
  });
});

describe("the round trip reads the multi-file output", () => {
  const original = () => {
    const parsed = parseJsonSchemaDocument(JSON.stringify({ title: "Order", type: "object", required: ["id"], properties: { id: { type: "string" }, status: { enum: ["open", "closed"] } } }));
    if (!parsed.success) throw new Error(parsed.error.message);
    return parsed.data.entities[0];
  };

  it("builds the bundle shape the importer reads: root first, each document keeping its $id", () => {
    const output = bundle({
      "Order.json": doc("Order.json", { properties: { status: { $ref: "Order_status.json" } } }),
      "Order_status.json": JSON.stringify({ $schema: DIALECT, $id: "Order_status.json", type: "string", enum: ["open", "closed"] }),
    });
    const built = JSON.parse(asImportableDocument(output, "Order")) as { $id: string; $defs: Record<string, { $id: string; $schema?: unknown }> };
    expect(built.$id).toBe("Order");
    expect(Object.keys(built.$defs)).toEqual(["Order", "Order_status"]);
    expect(built.$defs.Order.$id).toBe("Order.json");
    expect(built.$defs.Order.$schema).toBeUndefined();
  });

  it("wraps a bare document the same way, and leaves text that is not JSON for the importer to report", () => {
    const built = JSON.parse(asImportableDocument(doc("Order.json", { properties: {} }), "Order")) as { $id: string; $defs: Record<string, unknown> };
    expect(built).toMatchObject({ $id: "Order" });
    expect(Object.keys(built.$defs)).toEqual(["Order"]);
    expect(asImportableDocument("{ nope", "Order")).toBe("{ nope");
  });

  it("compares an entity with the files the app writes for it (enum in a sibling file): same entity back", () => {
    const output = bundle({
      "Order.json": doc("Order.json", { required: ["id"], properties: { id: { type: "string" }, status: { $ref: "Order_status.json" } } }),
      "Order_status.json": JSON.stringify({ $schema: DIALECT, $id: "Order_status.json", type: "string", enum: ["open", "closed"] }),
    });
    const result = compareRoundTrip(original(), output);
    expect(result.status).not.toBe("REIMPORT_FAILED");
    expect(result.differences.filter((d) => d.classification === "DEFECT")).toEqual([]);
  });
});
