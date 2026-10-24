import { describe, expect, it, vi } from "vitest";
import { loadPickableEntities, MAX_PICKABLE_ENTITIES } from "@/lib/references/pickable-entities";

function fakeDb(rows: unknown[] | Error) {
  const findMany = vi.fn<(args: unknown) => Promise<unknown[]>>(async () => {
    if (rows instanceof Error) throw rows;
    return rows;
  });
  return { db: { entity: { findMany } } as never, findMany };
}

describe("loadPickableEntities", () => {
  it("lists the tenant's entities with their domain and product names, ordered by name, and asks for nothing else", async () => {
    const { db, findMany } = fakeDb([
      { id: "e1", name: "Address", domain: { name: "Billing" }, product: { name: "Core" } },
      { id: "e2", name: "Customer", domain: { name: "Sales" }, product: { name: "Crm" } },
    ]);

    const out = await loadPickableEntities(db, "tenant-1");

    expect(out).toEqual([
      { id: "e1", name: "Address", domain: "Billing", product: "Core" },
      { id: "e2", name: "Customer", domain: "Sales", product: "Crm" },
    ]);
    expect(findMany).toHaveBeenCalledTimes(1);
    const args = findMany.mock.calls[0][0] as { where: unknown; orderBy: unknown; select: Record<string, unknown>; take: number };
    expect(args.where).toEqual({ tenantId: "tenant-1" });
    expect(args.orderBy).toEqual([{ name: "asc" }, { id: "asc" }]);
    // names and ids only: never fields, metadata or schema versions
    expect(Object.keys(args.select).sort()).toEqual(["domain", "id", "name", "product"]);
    expect(args.take).toBe(MAX_PICKABLE_ENTITIES);
  });

  it("uses the tenant placeholder for an entity that has no domain or product", async () => {
    const { db } = fakeDb([{ id: "e1", name: "Money", domain: null, product: null }]);

    expect(await loadPickableEntities(db, "tenant-1")).toEqual([{ id: "e1", name: "Money", domain: "_tenant", product: "_tenant" }]);
  });

  it("is fail-soft: a failed lookup is logged and reads as no entities (the picker still takes a typed name)", async () => {
    const spy = vi.spyOn(console, "error").mockImplementation(() => {});
    const { db } = fakeDb(new Error("db down"));

    expect(await loadPickableEntities(db, "tenant-1")).toEqual([]);
    expect(spy).toHaveBeenCalled();
    spy.mockRestore();
  });

  it("returns nothing for a blank tenant instead of asking for every tenant's entities", async () => {
    const { db, findMany } = fakeDb([{ id: "e1", name: "X", domain: null, product: null }]);

    expect(await loadPickableEntities(db, "")).toEqual([]);
    expect(findMany).not.toHaveBeenCalled();
  });
});
