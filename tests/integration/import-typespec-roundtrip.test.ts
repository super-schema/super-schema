/**
 * Import → persist shape → compileEntity → generateTypeSpec → REAL compile.
 *
 * Multi-entity imports (Epic 15) produce collections of entities / enums. The
 * generated TypeSpec must compile with zero errors and use the referenced
 * entity / generated enum as the element / value type (`LineItem[]`,
 * `Record<LineItem>`), never the bare words "reference" / "enum".
 *
 * Each imported entity is generated on its own (as the app does), then all of
 * them are compiled together as one bundle — the same "every model in one
 * document" shape the TypeSpec import uses — so references between siblings
 * resolve. A type the source only references through an unresolved import
 * (proto `shop.common.v1.Money`) stands for an entity that already exists in
 * the catalog; it gets an empty stub model in the bundle.
 */
import { readFileSync } from "node:fs";
import path from "node:path";
import { beforeAll, describe, expect, it, vi } from "vitest";
import { parseProtobufDocument } from "@/lib/importers/protobuf.importer";
import { parseAvroDocument } from "@/lib/importers/avro.importer";
import { parseJsonSchemaDocument } from "@/lib/importers/jsonschema.importer";
import { toAssetImportResult } from "@/lib/importers/multi-asset";
import { buildImportAssetsPayload } from "@/lib/importers/import-payload";
import { compileEntity, type PrismaFieldInput } from "@/lib/compiler/compiler.service";
import { generateTypeSpec } from "@/lib/compiler/typespec-generator";
import type { MultiEntityImportResult } from "@/lib/importers/types";
import type { Result } from "@/types/result";

// server-only throws outside an RSC bundle; neutralize it for the Node test.
vi.mock("server-only", () => ({}));

let compileTypeSpecWithGovernance: typeof import("@/lib/compiler/typespec-compiler").compileTypeSpecWithGovernance;

beforeAll(async () => {
  ({ compileTypeSpecWithGovernance } = await import("@/lib/compiler/typespec-compiler"));
});

function fixture(name: string): string {
  return readFileSync(path.resolve(process.cwd(), "tests/fixtures/importers", name), "utf8");
}

function unwrap(result: Result<MultiEntityImportResult>): MultiEntityImportResult {
  if (!result.success) throw new Error(result.error.message);
  return result.data;
}

/** Generate every imported entity the way the app persists + compiles it, bundled into one document. */
function generateBundle(doc: MultiEntityImportResult): string {
  const review = toAssetImportResult(doc);
  const payload = buildImportAssetsPayload(review, {
    domainId: "domain-1",
    selectedModels: [],
    selectedEntities: review.models.map((_, index) => index),
    selectedEnums: [],
    selectedScalars: [],
    selectedUnions: [],
    selectedServices: [],
    selectedDecorators: [],
  });

  const sources = payload.entities.map((entity, entityIndex) => {
    const fields: PrismaFieldInput[] = entity.fields.map((f, index) => ({
      id: `${entity.name}-${index}`,
      name: f.name,
      type: f.type,
      precision: f.precision,
      scale: f.scale,
      nullable: f.nullable,
      isKey: f.isKey,
      fieldNumber: f.fieldNumber ?? null,
      description: f.description,
      classification: f.classification,
      aliases: f.aliases ?? [],
      decorators: f.decorators ?? {},
      sortOrder: index,
    }));
    const model = compileEntity(
      {
        id: `entity-${entityIndex}`,
        name: entity.name,
        description: entity.description ?? "",
        status: "DRAFT",
        version: 1,
        domainId: "domain-1",
        metadata: {},
        domain: { id: "domain-1", name: "Shop", slug: "shop" },
      },
      fields
    );
    return generateTypeSpec(model);
  });

  const defined = new Set(payload.entities.map((entity) => entity.name));
  const external = new Set(
    payload.entities
      .flatMap((entity) => entity.fields.map((f) => f.decorators?.referencedEntityName))
      .filter((name): name is string => typeof name === "string" && !defined.has(name))
  );
  const stubs = [...external].map((name) => `model ${name} {}\n`);

  return [...sources, ...stubs].join("\n");
}

async function expectCompiles(source: string) {
  const result = await compileTypeSpecWithGovernance(source);
  const errors = result.diagnostics.filter((d) => d.severity === "error");
  expect(errors, `${JSON.stringify(errors, null, 2)}\n--- source ---\n${source}`).toEqual([]);
  expect(result.success).toBe(true);
  if (!result.success) return;
  return result.document;
}

describe("multi-entity import → generated TypeSpec compiles (real compiler)", () => {
  it("order.proto: arrays and maps of messages use the nested message, enums resolve", async () => {
    const source = generateBundle(unwrap(parseProtobufDocument(fixture("order.proto"))));

    expect(source).toContain("items?: Order_LineItem[];");
    expect(source).toContain("items_by_sku?: Record<Order_LineItem>;");
    expect(source).toContain("labels?: Record<string>;");
    expect(source).toContain("tags?: string[];");
    expect(source).toContain("customer?: Customer;");
    expect(source).toContain("status?: Order_status;");
    expect(source).toContain("model Money {}"); // stub for the unresolved import
    expect(source).not.toMatch(/\breference\b|\benum\[\]|Record<enum>/);

    const document = await expectCompiles(source);
    expect(document?.models.map((m) => m.name)).toEqual(
      expect.arrayContaining(["Order", "Order_LineItem", "Card", "Customer"])
    );
  }, 30_000);

  it("order.avsc: arrays and maps of nested records use the record entity", async () => {
    const source = generateBundle(unwrap(parseAvroDocument(fixture("order.avsc"))));

    expect(source).toContain("items: LineItem[];");
    expect(source).toContain("items_by_sku: Record<LineItem>;");
    expect(source).toContain("shipping_address: Address;");
    expect(source).toContain("billing_address?: Address;");
    expect(source).not.toMatch(/\breference\b|\benum\[\]|Record<enum>/);

    const document = await expectCompiles(source);
    expect(document?.models.map((m) => m.name)).toEqual(
      expect.arrayContaining(["Order", "Address", "LineItem"])
    );
  }, 30_000);

  it("JSON Schema $defs: arrays of $ref use the definition entity", async () => {
    const source = generateBundle(unwrap(parseJsonSchemaDocument(fixture("order.schema.json"))));

    expect(source).toContain("items: LineItem[];");
    expect(source).toContain("addresses?: Address[];");
    expect(source).toContain("customer: Customer;");
    expect(source).toContain("parent_order?: Order;");
    expect(source).not.toMatch(/\breference\b|\benum\[\]|Record<enum>/);

    const document = await expectCompiles(source);
    expect(document?.models.map((m) => m.name)).toEqual(
      expect.arrayContaining(["Order", "Customer", "Address", "LineItem"])
    );
  }, 30_000);
});
