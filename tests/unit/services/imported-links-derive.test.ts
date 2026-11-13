import { describe, it, expect, vi, beforeEach } from "vitest";

// A dangling reference that resolves (relinkDanglingFields) moves the field's ABC placement from `field` to `none`: the attribute key is dropped.

const listMock = vi.hoisted(() => vi.fn());
vi.mock("@/services/metadata-attribute.service", () => ({ listMetadataAttributes: listMock }));
vi.mock("@/services/classification-scale.service", () => ({ loadCustomClassMap: async () => new Map<string, number>() }));

import { relinkDanglingFields } from "@/services/imported-links";

const DEF = {
  key: "x-abc",
  label: "ABC",
  description: "",
  valueSchema: { type: "object", properties: { data_class: { type: "string" } } },
  targets: ["field"],
  scope: "schema",
  placement: "abc-primitive",
  derive: { data_class: "class{class}" },
  requiredWhen: "primitive",
  pack: "paypal",
};
const withKey = { typespec: { extensions: { openapi: { "x-abc": { data_class: "class2" } } } } };

const run = async () => {
  const update = vi.fn().mockResolvedValue({});
  const db = {
    field: {
      findMany: vi.fn().mockResolvedValue([
        { id: "f1", name: "tax", type: "reference", classification: "PII", entityId: "e1", entity: { productId: "p" },
          decorators: { referencedEntityName: "Address", danglingRef: { ref: "../Address.json" }, ...withKey } },
      ]),
      update,
    },
    entity: { findMany: vi.fn().mockResolvedValue([{ id: "ad", name: "Address", productId: "p" }]) },
    product: { findUnique: vi.fn().mockResolvedValue({ name: "customer", domainId: "d1", domain: { name: "CDS" } }) },
    auditLog: { create: vi.fn().mockResolvedValue({}) },
    metadataAttributeDefinition: {},
    classificationLevel: {},
  };
  const linked = await relinkDanglingFields(db as never, { productId: "p", entity: { id: "ad", name: "Address" }, actor: { userId: "u1", tenantId: "t1" } });
  return { linked, update };
};

beforeEach(() => vi.clearAllMocks());

describe("relinkDanglingFields derives attribute members", () => {
  it("drops the attribute key once the dangling reference resolves", async () => {
    listMock.mockResolvedValue({ success: true, data: [DEF] });
    const { linked, update } = await run();
    expect(linked).toBe(1);
    expect(listMock).toHaveBeenCalledWith("t1", "field", expect.anything());
    const decorators = update.mock.calls[0][0].data.decorators;
    expect(decorators).toMatchObject({ referencedEntityId: "ad" });
    expect(decorators).not.toHaveProperty("danglingRef");
    expect(decorators.typespec?.extensions?.openapi?.["x-abc"]).toBeUndefined();
  });

  it("keeps the key when the tenant has no definitions", async () => {
    listMock.mockResolvedValue({ success: true, data: [] });
    const { update } = await run();
    expect(update.mock.calls[0][0].data.decorators.typespec.extensions.openapi["x-abc"]).toEqual({ data_class: "class2" });
  });
});
