/**
 * `loadTenantEntityRefs` and `createRefResolver`: what the Source tab save resolves a written name with, outside a closure walk.
 */
import { describe, it, expect, vi } from "vitest";
import type { PrismaClient } from "@/generated/prisma/client";
import { createRefResolver, loadTenantEntityRefs } from "@/lib/references/closure";
import type { EntityRef } from "@/lib/references/entity-reference";

const fakeDb = (rows: unknown[] = []) => {
  const findMany = vi.fn().mockResolvedValue(rows);
  return { db: { entity: { findMany } } as unknown as PrismaClient, findMany };
};

const row = (id: string, name: string, domain?: string, product?: string) => ({
  id,
  name,
  description: "",
  status: "DRAFT",
  version: 1,
  domainId: domain ? `dom-${domain}` : null,
  latestVersionId: null,
  domain: domain ? { id: `dom-${domain}`, name: domain, slug: domain.toLowerCase() } : null,
  product: product ? { name: product } : null,
});

describe("loadTenantEntityRefs", () => {
  it("a blank or missing tenant id fails closed with CROSS_TENANT and reads nothing (Prisma would read an undefined tenant as every tenant)", async () => {
    for (const tenantId of ["", "   ", undefined, null, 7] as unknown[]) {
      const { db, findMany } = fakeDb([row("e-1", "Address", "Billing", "Payments")]);

      const res = await loadTenantEntityRefs(db, tenantId as string);

      expect(res, String(tenantId)).toEqual({ success: false, error: { code: "CROSS_TENANT" } });
      expect(findMany, String(tenantId)).not.toHaveBeenCalled();
    }
  });

  it("reads only the tenant's entities, as qualified references with their ids (`_tenant` for a missing domain / product)", async () => {
    const { db, findMany } = fakeDb([row("e-1", "Address", "Billing", "Payments"), row("e-2", "Note")]);

    const res = await loadTenantEntityRefs(db, "tenant-1");

    expect(findMany.mock.calls[0][0]).toMatchObject({ where: { tenantId: "tenant-1" } });
    expect(res).toEqual({
      success: true,
      data: [
        { entityId: "e-1", domain: "Billing", product: "Payments", entity: "Address" },
        { entityId: "e-2", domain: "_tenant", product: "_tenant", entity: "Note" },
      ],
    });
  });
});

describe("createRefResolver", () => {
  const WITH_ID: EntityRef = { entityId: "e-1", domain: "Billing", product: "Payments", entity: "Address" };
  const NO_ID: EntityRef = { domain: "Sales", product: "Shipping", entity: "Parcel" };

  it("resolves by id, by qualified name and by a legacy bare name", () => {
    const resolve = createRefResolver([WITH_ID]);

    expect(resolve({ entityId: "e-1", domain: "x", product: "y", entity: "z" })).toEqual({ target: WITH_ID });
    expect(resolve({ domain: "Billing", product: "Payments", entity: "Address" })).toEqual({ target: WITH_ID });
    expect(resolve({ legacyName: "Address" })).toEqual({ target: WITH_ID });
    expect(resolve({ legacyName: "Nothing" })).toBeUndefined();
  });

  it("an entry without an id is not resolvable (skipped), by any of the three ways", () => {
    const resolve = createRefResolver([NO_ID, WITH_ID]);

    expect(resolve({ legacyName: "Parcel" })).toBeUndefined();
    expect(resolve({ domain: "Sales", product: "Shipping", entity: "Parcel" })).toBeUndefined();
    expect(resolve({ entityId: "none", domain: "Sales", product: "Shipping", entity: "Parcel" })).toBeUndefined();
    // the entries with an id are unaffected
    expect(resolve({ legacyName: "Address" })).toEqual({ target: WITH_ID });
  });

  it("an empty tenant resolves nothing", () => {
    expect(createRefResolver([])({ legacyName: "Address" })).toBeUndefined();
  });
});
