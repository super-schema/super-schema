import { describe, it, expect, vi } from "vitest";
import { linkFields, linkImportedEntity, relinkDanglingFields } from "@/services/imported-links";
import type { CreateFieldInput } from "@/app/(dashboard)/schemas/[domainSlug]/actions";

const place = { domain: "CDS", product: "customer" };
const field = (name: string, decorators?: Record<string, unknown>): CreateFieldInput => ({
  name, type: "reference", nullable: true, isKey: false, description: "", classification: null, precision: null, scale: null, ...(decorators ? { decorators } : {}),
});
const dangling = (target: string) => ({ referencedEntityName: target, danglingRef: { ref: `../common/${target}.v1.json` } });

describe("linkFields", () => {
  it("replaces the dangling marker of a field whose target exists with a qualified reference", () => {
    const [linked] = linkFields([field("tax_address", dangling("Address"))], new Map([["Address", { id: "e1", name: "Address" }]]), place);
    expect(linked.decorators).toMatchObject({ referencedEntityId: "e1", referencedEntityName: "Address", referencedQualifiedName: "CDS/customer/Address" });
    expect(linked.decorators).not.toHaveProperty("danglingRef");
  });

  it("leaves a field whose target is unknown, and a field that is not dangling, as it is", () => {
    const fields = [field("a", dangling("Missing")), field("b", { referencedEntityName: "Address" }), field("c")];
    expect(linkFields(fields, new Map([["Address", { id: "e1", name: "Address" }]]), place)).toEqual(fields);
  });
});

describe("linkImportedEntity", () => {
  const tx = (entities: Array<{ id: string; name: string }>) => ({
    entity: { findMany: vi.fn().mockResolvedValue(entities) },
    product: { findUnique: vi.fn().mockResolvedValue({ name: "customer", domain: { name: "CDS" } }) },
  });

  it("asks nothing when there is nothing to link", async () => {
    const db = tx([]);
    const fields = [field("x")];
    expect(await linkImportedEntity(db as never, { productId: "p", fields })).toEqual({ fields });
    expect(db.entity.findMany).not.toHaveBeenCalled();
  });

  it("links the dangling fields in one lookup", async () => {
    const db = tx([{ id: "ad", name: "Address" }]);
    const result = await linkImportedEntity(db as never, { productId: "p", fields: [field("addr", dangling("Address"))] });
    expect(db.entity.findMany).toHaveBeenCalledTimes(1);
    expect(result.fields[0].decorators).toMatchObject({ referencedEntityId: "ad" });
  });
});

describe("relinkDanglingFields", () => {
  it("links the product's dangling fields that name the new entity, and only those", async () => {
    const update = vi.fn().mockResolvedValue({});
    const db = {
      field: {
        findMany: vi.fn().mockResolvedValue([
          { id: "f1", decorators: dangling("Address") },
          { id: "f2", decorators: { referencedEntityName: "Address", referencedEntityId: "x" } },
        ]),
        update,
      },
      product: { findUnique: vi.fn().mockResolvedValue({ name: "customer", domain: { name: "CDS" } }) },
    };
    expect(await relinkDanglingFields(db as never, { productId: "p", entity: { id: "ad", name: "Address" } })).toBe(1);
    expect(update).toHaveBeenCalledTimes(1);
    expect(update.mock.calls[0][0]).toMatchObject({ where: { id: "f1" }, data: { decorators: { referencedEntityId: "ad" } } });
    expect(update.mock.calls[0][0].data.decorators).not.toHaveProperty("danglingRef");
  });
});
