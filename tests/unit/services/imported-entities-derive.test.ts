import { describe, expect, it, vi, beforeEach } from "vitest";
import type { Prisma } from "@/generated/prisma/client";

// An imported field is re-derived against its FINAL classification before the row is written (the importer writes rows itself).

const listMock = vi.hoisted(() => vi.fn());
vi.mock("@/services/metadata-attribute.service", () => ({ listMetadataAttributes: listMock }));
vi.mock("@/services/classification-scale.service", () => ({ loadCustomClassMap: async () => new Map<string, number>() }));

import { createImportedEntities } from "@/services/imported-entities";
import { parseJsonSchemaDocument } from "@/lib/importers/jsonschema.importer";
import { toAssetImportResult } from "@/lib/importers/multi-asset";
import { buildImportAssetsPayload } from "@/lib/importers/import-payload";
import { resetClassificationConfigWarnings } from "@/lib/importers/classification-config";

const KEY = "x-securityClassification";
const DEF = {
  key: KEY,
  label: "Security classification",
  description: "",
  valueSchema: { type: "object", properties: { data_class: { type: "string" }, data_category: { type: "string" } } },
  targets: ["field"],
  scope: "schema",
  placement: "abc-primitive",
  derive: { data_class: "class{class}" },
  requiredWhen: "primitive",
  pack: "paypal",
};

type Stored = {
  classification: string | null;
  decorators: { typespec: { extensions: { openapi: Record<string, unknown> } }; governance?: unknown };
};

async function importAndPersist(schema: object): Promise<Stored[]> {
  const parsed = parseJsonSchemaDocument(JSON.stringify(schema));
  if (!parsed.success) throw new Error("import failed");
  const r = toAssetImportResult(parsed.data);
  const payload = buildImportAssetsPayload(r, {
    domainId: "d", selectedModels: [], selectedEntities: r.models.map((_, i) => i),
    selectedEnums: [], selectedScalars: [], selectedUnions: [], selectedServices: [], selectedDecorators: [],
  });
  const create = vi.fn(async ({ data }: { data: { name: string } }) => ({ id: `id-${data.name}` }));
  const tx = {
    auditLog: { create: vi.fn(async () => ({})) },
    field: { findMany: vi.fn(async () => []) },
    entity: { create, findFirst: vi.fn().mockResolvedValue(null), findMany: vi.fn(async () => []) },
    metadataAttributeDefinition: {},
    classificationLevel: {},
  } as unknown as Prisma.TransactionClient;
  await createImportedEntities(tx, {
    entities: payload.entities as never,
    productScope: { tenantId: "t", domainId: "d", productId: "p" },
    productId: "p", ownerId: "u", isNameFree: async () => true, skip: () => {}, refs: new Map(),
  });
  return (create.mock.calls[0][0].data as unknown as { fields: { create: Stored[] } }).fields.create;
}

const schema = (block: unknown) => ({ title: "Thing", type: "object", properties: { a: { type: "string", [KEY]: block } } });

beforeEach(() => {
  vi.clearAllMocks();
  vi.unstubAllEnvs();
  delete process.env.SCHEMA_CLASSIFICATION_VALUE_MAP;
  resetClassificationConfigWarnings();
});

describe("createImportedEntities derives attribute members", () => {
  it("re-derives an imported value that disagrees with the final classification", async () => {
    listMock.mockResolvedValue({ success: true, data: [DEF] });
    vi.stubEnv("SCHEMA_CLASSIFICATION_VALUE_MAP", '{"class2":"SENSITIVE"}');
    const [f] = await importAndPersist(schema({ data_class: "class2", data_category: "ConsumerPersonal" }));
    expect(f.classification).toBe("SENSITIVE");
    expect(f.decorators.typespec.extensions.openapi[KEY]).toEqual({ data_class: "class3", data_category: "ConsumerPersonal" });
    expect(listMock).toHaveBeenCalledWith("t", "field", expect.anything());
  });

  it("keeps an agreeing value intact", async () => {
    listMock.mockResolvedValue({ success: true, data: [DEF] });
    const [f] = await importAndPersist(schema({ data_class: "class2", data_category: "ConsumerPersonal" }));
    expect(f.classification).toBe("PII");
    expect(f.decorators.typespec.extensions.openapi[KEY]).toEqual({ data_class: "class2", data_category: "ConsumerPersonal" });
  });

  it("stores the block untouched when the tenant has no definitions", async () => {
    listMock.mockResolvedValue({ success: true, data: [] });
    vi.stubEnv("SCHEMA_CLASSIFICATION_VALUE_MAP", '{"class2":"SENSITIVE"}');
    const [f] = await importAndPersist(schema({ data_class: "class2", data_category: "ConsumerPersonal" }));
    expect(f.decorators.typespec.extensions.openapi[KEY]).toEqual({ data_class: "class2", data_category: "ConsumerPersonal" });
    expect(f.decorators.governance).toBeUndefined();
  });
});
