// @vitest-environment node
/**
 * KD-045: the reference closure only includes what the caller may read. `loadReferenceClosure(..., { reader })` asks `reader` about every entity it
 * is about to add, BEFORE it reads one row of that entity's content; an entity the caller may not read refuses the whole closure with one generic
 * `REFERENCE_NOT_READABLE` that names nothing of it (not its name, domain, product or id), never an omission and never a different error that
 * would carry its name (a missing pin, "never published", an ambiguous bare name that lists it).
 */
import { describe, expect, it, vi } from "vitest";
import { loadReferenceClosure, type ClosureReader } from "@/lib/references/closure";
import { entityReader } from "@/lib/access";
import { closureFailure } from "@/lib/emission/closure-generation";
import { assign } from "../../../helpers/access-mocks";

type FieldRow = { id: string; name: string; decorators: Record<string, unknown> };
type EntityRow = {
  id: string;
  name: string;
  tenantId: string;
  domain?: string;
  product?: string;
  fields: FieldRow[];
  latest?: string;
};

const T = "t1";

/** What the fake database was asked to read about which entity: the proof that an unreadable entity's content is never touched. */
const reads = { fieldsOf: [] as string[], versionsOf: [] as string[], metadataOf: [] as string[] };

const toField = (f: FieldRow, i: number) => ({
  id: f.id, name: f.name, type: "reference", precision: null, scale: null, nullable: true, isKey: false, fieldNumber: null,
  description: "", classification: null, aliases: [], decorators: f.decorators, sortOrder: i,
});

function fakeDb(rows: EntityRow[]) {
  reads.fieldsOf = [];
  reads.versionsOf = [];
  reads.metadataOf = [];
  return {
    entity: {
      findMany: async (args: { where: { tenantId: string } }) =>
        rows
          .filter((r) => r.tenantId === args.where.tenantId)
          .map((r) => ({
            id: r.id,
            name: r.name,
            description: "",
            status: "DRAFT",
            version: 1,
            domainId: r.domain ? `d-${r.domain}` : null,
            productId: r.product ? `p-${r.product}` : null,
            latestVersionId: r.latest ?? null,
            domain: r.domain ? { id: `d-${r.domain}`, name: r.domain, slug: `${r.domain}-slug` } : null,
            product: r.product ? { name: r.product, domainId: r.domain ? `d-${r.domain}` : null } : null,
          })),
      findUnique: async (args: { where: { id: string } }) => {
        reads.metadataOf.push(args.where.id);
        return rows.some((r) => r.id === args.where.id) ? { metadata: null } : null;
      },
    },
    field: {
      findMany: async ({ where }: { where: { entityId: string } }) => {
        reads.fieldsOf.push(where.entityId);
        return (rows.find((r) => r.id === where.entityId)?.fields ?? []).map(toField);
      },
    },
    entityVersion: {
      findUnique: async ({ where }: { where: { id?: string; entityId_major_minor?: { entityId: string } } }) => {
        reads.versionsOf.push(where.id ?? where.entityId_major_minor?.entityId ?? "?");
        return null;
      },
    },
  } as never;
}

const ref = (name: string) => ({ referencedEntityName: name });
const qref = (id: string, q: string, ver?: string) => ({
  referencedEntityId: id,
  referencedEntityName: q.split("/")[2],
  referencedQualifiedName: q,
  ...(ver ? { referencedEntityVersion: ver } : {}),
});
const ent = (id: string, over: Partial<EntityRow> = {}, fields: Array<[string, Record<string, unknown>]> = []): EntityRow => ({
  id,
  name: id.toUpperCase(),
  tenantId: T,
  fields: fields.map(([name, decorators]) => ({ id: `${id}-${name}`, name, decorators })),
  ...over,
});

const names = (r: { entities: Array<{ ref: { entity: string } }> }) => r.entities.map((e) => e.ref.entity);

/** A domain-scoped author of domain "own": the principal of the KD-045 scenario. */
const ownDomainOnly = entityReader([assign.domain("AUTHOR", T, "d-own")]);

describe("loadReferenceClosure with a reader (KD-045)", () => {
  it("without a reader nothing changes: every entity of the tenant is in the closure (the loader is policy-free; its callers pass the reader)", async () => {
    const db = fakeDb([ent("a", { domain: "own" }, [["b", ref("B")]]), ent("b", { domain: "other" })]);
    const r = await loadReferenceClosure(db, T, "a", "draft");
    expect(r.success && names(r.data)).toEqual(["A", "B"]);
  });

  it("a reader that reads everything gives the same closure as no reader", async () => {
    const db = fakeDb([ent("a", { domain: "own" }, [["b", ref("B")]]), ent("b", { domain: "other" })]);
    const r = await loadReferenceClosure(db, T, "a", "draft", { reader: () => true });
    expect(r.success && names(r.data)).toEqual(["A", "B"]);
  });

  it("a domain-scoped author whose entity references an entity of another domain is REFUSED, naming only their own field", async () => {
    const db = fakeDb([
      ent("a", { domain: "own", product: "p" }, [["customer", qref("b", "other/crm/Customer")]]),
      ent("b", { name: "Customer", domain: "other", product: "crm" }),
    ]);
    const r = await loadReferenceClosure(db, T, "a", "draft", { reader: ownDomainOnly });
    expect(r).toEqual({ success: false, error: { code: "REFERENCE_NOT_READABLE", field: "customer" } });
  });

  it("refuses BEFORE any row of the unreadable entity is read: no fields, no version, no metadata", async () => {
    const db = fakeDb([
      ent("a", { domain: "own" }, [["customer", qref("b", "other/crm/Customer")]]),
      ent("b", { name: "Customer", domain: "other", product: "crm" }, [["secret", ref("Z")]]),
      ent("z", { domain: "other" }),
    ]);
    await loadReferenceClosure(db, T, "a", "draft", { reader: ownDomainOnly });
    expect(reads.fieldsOf).toEqual(["a"]);
    expect(reads.versionsOf).toEqual([]);
    expect(reads.metadataOf).not.toContain("b");
    expect(reads.metadataOf).not.toContain("z");
  });

  it("the same domain is fine: the closure is whole, tenant-level entities excepted", async () => {
    const db = fakeDb([
      ent("a", { domain: "own", product: "p1" }, [["b", ref("B")]]),
      ent("b", { domain: "own", product: "p2" }, [["c", ref("C")]]),
      ent("c", { domain: "own" }),
    ]);
    const r = await loadReferenceClosure(db, T, "a", "draft", { reader: ownDomainOnly });
    expect(r.success && names(r.data)).toEqual(["A", "B", "C"]);
  });

  it("a tenant administrator, a tenant-wide viewer and a platform administrator are unaffected", async () => {
    for (const assignment of [assign.tenant("ADMIN", T), assign.tenant("VIEWER", T), assign.global()]) {
      const db = fakeDb([ent("a", { domain: "own" }, [["b", ref("B")]]), ent("b", { domain: "other" }), ent("c")]);
      const r = await loadReferenceClosure(db, T, "a", "draft", { reader: entityReader([assignment]) });
      expect(r.success && names(r.data)).toEqual(["A", "B"]);
    }
  });

  it("a TRANSITIVE reference the caller cannot read refuses too (A -> B readable -> C not), and the field named is B's own", async () => {
    const db = fakeDb([
      ent("a", { domain: "own" }, [["b", ref("B")]]),
      ent("b", { domain: "own" }, [["ledger", ref("C")]]),
      ent("c", { domain: "finance", product: "gl" }),
    ]);
    const r = await loadReferenceClosure(db, T, "a", "draft", { reader: ownDomainOnly });
    expect(r).toEqual({ success: false, error: { code: "REFERENCE_NOT_READABLE", field: "ledger" } });
    expect(reads.fieldsOf).toEqual(["a", "b"]);
  });

  it("a reference to a tenant-level entity is refused for a domain-scoped caller (only tenant and global roles cover it)", async () => {
    const db = fakeDb([ent("a", { domain: "own" }, [["t", ref("T")]]), ent("t")]);
    const r = await loadReferenceClosure(db, T, "a", "draft", { reader: ownDomainOnly });
    expect(r.success).toBe(false);
    expect(!r.success && r.error.code).toBe("REFERENCE_NOT_READABLE");
  });

  it("a dangling reference (nothing is there) is still simply absent: the refusal is about what exists and is not readable", async () => {
    const db = fakeDb([ent("a", { domain: "own" }, [["gone", ref("Nothing")]])]);
    const r = await loadReferenceClosure(db, T, "a", "draft", { reader: ownDomainOnly });
    expect(r.success && names(r.data)).toEqual(["A"]);
  });

  it("a pin on an unreadable entity is REFERENCE_NOT_READABLE, not PIN_NOT_FOUND (which would carry its name)", async () => {
    const db = fakeDb([
      ent("a", { domain: "own" }, [["b", qref("b", "other/crm/Customer", "9.9")]]),
      ent("b", { name: "Customer", domain: "other", product: "crm" }),
    ]);
    // Control: without the reader the very same closure fails with the error that names the entity (so the test below is not vacuous).
    const open = await loadReferenceClosure(db, T, "a", "draft");
    expect(!open.success && open.error.code).toBe("PIN_NOT_FOUND");
    const r = await loadReferenceClosure(db, T, "a", "draft", { reader: ownDomainOnly });
    expect(!r.success && r.error.code).toBe("REFERENCE_NOT_READABLE");
    expect(JSON.stringify(r)).not.toMatch(/Customer|crm|other|9\.9/);
  });

  it("an unreadable entity that was never published is REFERENCE_NOT_READABLE, not NEVER_PUBLISHED (which would carry its name)", async () => {
    const db = fakeDb([ent("a", { domain: "own" }, [["b", ref("Customer")]]), ent("b", { name: "Customer", domain: "other", product: "crm" })]);
    const open = await loadReferenceClosure(db, T, "a", "published", { rootAtDraft: true });
    expect(!open.success && open.error.code).toBe("NEVER_PUBLISHED");
    const r = await loadReferenceClosure(db, T, "a", "published", { rootAtDraft: true, reader: ownDomainOnly });
    expect(!r.success && r.error.code).toBe("REFERENCE_NOT_READABLE");
    expect(JSON.stringify(r)).not.toMatch(/Customer|crm|other/);
  });

  it("an ambiguous bare name with an unreadable candidate does NOT list the candidates: REFERENCE_NOT_READABLE", async () => {
    const db = fakeDb([
      ent("a", { domain: "own" }, [["addr", ref("Address")]]),
      ent("x1", { name: "Address", domain: "own", product: "p1" }),
      ent("x2", { name: "Address", domain: "other", product: "secret-product" }),
    ]);
    const r = await loadReferenceClosure(db, T, "a", "draft", { reader: ownDomainOnly });
    expect(r).toEqual({ success: false, error: { code: "REFERENCE_NOT_READABLE", field: "addr" } });
    expect(JSON.stringify(r)).not.toMatch(/secret-product|other|x2/);
  });

  it("an ambiguous bare name whose candidates are all readable is still the question it was (the pick dialog)", async () => {
    const db = fakeDb([
      ent("a", { domain: "own" }, [["addr", ref("Address")]]),
      ent("x1", { name: "Address", domain: "own", product: "p1" }),
      ent("x2", { name: "Address", domain: "own", product: "p2" }),
    ]);
    const r = await loadReferenceClosure(db, T, "a", "draft", { reader: ownDomainOnly });
    expect(!r.success && r.error.code).toBe("AMBIGUOUS_REFERENCE");
  });

  it("asks the reader the entity's own place: tenant, the domain (a product row with no domain column takes its product's), the product", async () => {
    const seen: Array<{ tenantId: string; domainId: string | null; productId: string | null }> = [];
    const reader: ClosureReader = (place) => {
      seen.push(place);
      return true;
    };
    const db = fakeDb([ent("a", { domain: "own", product: "p1" }, [["b", ref("B")]]), ent("b", { domain: "other", product: "p2" })]);
    await loadReferenceClosure(db, T, "a", "draft", { reader });
    expect(seen).toContainEqual({ tenantId: T, domainId: "d-other", productId: "p-p2" });
  });

  it("the root is not asked about (the caller authorized it); only what it reaches is", async () => {
    const reader = vi.fn(() => true);
    const db = fakeDb([ent("a", { domain: "own" }, [["b", ref("B")]]), ent("b", { domain: "own" })]);
    await loadReferenceClosure(db, T, "a", "draft", { reader });
    expect(reader).toHaveBeenCalledTimes(1);
  });

  it("a cycle through an unreadable entity is refused all the same", async () => {
    const db = fakeDb([ent("a", { domain: "own" }, [["b", ref("B")]]), ent("b", { domain: "other" }, [["a", ref("A")]])]);
    const r = await loadReferenceClosure(db, T, "a", "draft", { reader: ownDomainOnly });
    expect(!r.success && r.error.code).toBe("REFERENCE_NOT_READABLE");
  });
});

describe("the refusal the caller sees (closureFailure)", () => {
  it("is one generic message that names the caller's own field and nothing of the entity, with the field in `details` and a way forward", () => {
    const failure = closureFailure({ code: "REFERENCE_NOT_READABLE", field: "customer" });
    expect(failure.code).toBe("REFERENCE_NOT_READABLE");
    expect(failure.message).toContain('"customer"');
    expect(failure.details).toEqual({ field: "customer" });
    expect(failure.suggestedFix).toBeTruthy();
    expect(JSON.stringify(failure)).not.toMatch(/Customer|crm|other|d-other|tenant/);
  });
});
