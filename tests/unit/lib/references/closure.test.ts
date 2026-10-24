import { describe, it, expect } from "vitest";
import { loadReferenceClosure, type ClosureError } from "@/lib/references/closure";
import { qualifiedName } from "@/lib/references/entity-reference";

type FieldRow = { id: string; name: string; decorators: Record<string, unknown> };
type VersionRow = { id: string; entityId: string; major: number; minor: number; sequence: number; fieldSnapshot: unknown[] };
type EntityRow = {
  id: string;
  name: string;
  tenantId: string;
  domain?: string;
  product?: string;
  fields: FieldRow[];
  versions: VersionRow[];
  latest?: string; // version id
};

const toField = (f: FieldRow, i: number) => ({
  id: f.id,
  name: f.name,
  type: "reference",
  precision: null,
  scale: null,
  nullable: true,
  isKey: false,
  fieldNumber: null,
  description: "",
  classification: null,
  aliases: [],
  decorators: f.decorators,
  sortOrder: i,
});

function fakeDb(rows: EntityRow[]) {
  const versions = rows.flatMap((r) => r.versions);
  return {
    entity: {
      findMany: async ({ where }: { where: { tenantId: string } }) =>
        rows
          .filter((r) => r.tenantId === where.tenantId)
          .map((r) => ({
            id: r.id,
            name: r.name,
            description: "",
            status: "DRAFT",
            version: 1,
            domainId: r.domain ? `d-${r.domain}` : null,
            productId: r.product ? `p-${r.product}` : null,
            metadata: null,
            latestVersionId: r.latest ?? null,
            domain: r.domain ? { id: `d-${r.domain}`, name: r.domain, slug: `${r.domain}-slug` } : null,
            product: r.product ? { name: r.product } : null,
          })),
    },
    field: {
      findMany: async ({ where }: { where: { entityId: string } }) =>
        (rows.find((r) => r.id === where.entityId)?.fields ?? []).map(toField),
    },
    entityVersion: {
      findUnique: async ({
        where,
      }: {
        where: { id?: string; entityId_major_minor?: { entityId: string; major: number; minor: number } };
      }) => {
        if (where.id) return versions.find((v) => v.id === where.id) ?? null;
        const k = where.entityId_major_minor!;
        return versions.find((v) => v.entityId === k.entityId && v.major === k.major && v.minor === k.minor) ?? null;
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

function ent(id: string, over: Partial<EntityRow> = {}, fields: Array<[string, Record<string, unknown>]> = []): EntityRow {
  return {
    id,
    name: id.toUpperCase(),
    tenantId: "t1",
    fields: fields.map(([name, decorators]) => ({ id: `${id}-${name}`, name, decorators })),
    versions: [],
    ...over,
  };
}

/** A published version whose snapshot has one bare-name reference field per target. */
const version = (entityId: string, major: number, minor: number, targets: string[]): VersionRow => ({
  id: `${entityId}-v${major}.${minor}`,
  entityId,
  major,
  minor,
  sequence: major * 10 + minor,
  fieldSnapshot: targets.map((t, i) => toField({ id: `${entityId}-s${i}`, name: `s${i}`, decorators: ref(t) }, i)),
});

const names = (r: { entities: Array<{ ref: { entity: string } }> }) => r.entities.map((e) => e.ref.entity);

describe("loadReferenceClosure", () => {
  it("returns a chain A -> B -> C in order, root first", async () => {
    const db = fakeDb([ent("a", {}, [["b", ref("B")]]), ent("b", {}, [["c", ref("C")]]), ent("c")]);
    const r = await loadReferenceClosure(db, "t1", "a", "draft");
    expect(r.success).toBe(true);
    if (!r.success) return;
    expect(names(r.data)).toEqual(["A", "B", "C"]);
    expect(r.data.root.entityId).toBe("a");
    expect(r.data.cycles).toEqual([]);
    expect(r.data.entities[0].fields).toHaveLength(1);
  });

  it("terminates on a cycle A -> B -> A and reports it", async () => {
    const db = fakeDb([ent("a", {}, [["b", ref("B")]]), ent("b", {}, [["a", ref("A")]])]);
    const r = await loadReferenceClosure(db, "t1", "a", "draft");
    expect(r.success).toBe(true);
    if (!r.success) return;
    expect(names(r.data)).toEqual(["A", "B"]);
    expect(r.data.cycles).toEqual([["_tenant/_tenant/A", "_tenant/_tenant/B"]]);
  });

  it("reports a self loop as a cycle", async () => {
    const db = fakeDb([ent("a", {}, [["me", ref("A")]])]);
    const r = await loadReferenceClosure(db, "t1", "a", "draft");
    expect(r.success && r.data.cycles).toEqual([["_tenant/_tenant/A"]]);
  });

  it("orders breadth-first by qualified name", async () => {
    const db = fakeDb([
      ent("a", {}, [["z", ref("Z")], ["m", ref("M")]]),
      ent("z", {}, [["q", ref("Q")]]),
      ent("m"),
      ent("q"),
    ]);
    const r = await loadReferenceClosure(db, "t1", "a", "draft");
    expect(r.success && names(r.data)).toEqual(["A", "M", "Z", "Q"]);
  });

  it("returns AMBIGUOUS_REFERENCE for a bare name matching two entities", async () => {
    const db = fakeDb([
      ent("a", {}, [["addr", ref("Address")]]),
      ent("x1", { name: "Address", domain: "d1", product: "p1" }),
      ent("x2", { name: "Address", domain: "d2", product: "p2" }),
    ]);
    const r = await loadReferenceClosure(db, "t1", "a", "draft");
    expect(r.success).toBe(false);
    if (r.success) return;
    const e = r.error as Extract<ClosureError, { code: "AMBIGUOUS_REFERENCE" }>;
    expect(e.code).toBe("AMBIGUOUS_REFERENCE");
    expect(e.field).toBe("addr");
    expect(e.name).toBe("Address");
    expect(e.candidates.map(qualifiedName)).toEqual(["d1/p1/Address", "d2/p2/Address"]);
  });

  it("a qualified ref picks the right entity of two same-named", async () => {
    const db = fakeDb([
      ent("a", {}, [["addr", { referencedEntityName: "Address", referencedQualifiedName: "d2/p2/Address" }]]),
      ent("x1", { name: "Address", domain: "d1", product: "p1" }),
      ent("x2", { name: "Address", domain: "d2", product: "p2" }),
    ]);
    const r = await loadReferenceClosure(db, "t1", "a", "draft");
    expect(r.success && r.data.entities.map((e) => e.entityId)).toEqual(["a", "x2"]);
  });

  it("an entity id wins over the qualified name", async () => {
    const db = fakeDb([
      ent("a", {}, [["addr", qref("x1", "d2/p2/Address")]]),
      ent("x1", { name: "Address", domain: "d1", product: "p1" }),
      ent("x2", { name: "Address", domain: "d2", product: "p2" }),
    ]);
    const r = await loadReferenceClosure(db, "t1", "a", "draft");
    expect(r.success && r.data.entities.map((e) => e.entityId)).toEqual(["a", "x1"]);
  });

  describe("version modes", () => {
    // B: published 1.0 -> C, published 1.1 -> D, saved draft -> E
    const build = () =>
      fakeDb([
        ent("a", { versions: [version("a", 1, 0, ["B"])], latest: "a-v1.0" }, [["b", ref("B")]]),
        ent("b", { versions: [version("b", 1, 0, ["C"]), version("b", 1, 1, ["D"])], latest: "b-v1.1" }, [["e", ref("E")]]),
        ent("c", { versions: [version("c", 1, 0, [])], latest: "c-v1.0" }),
        ent("d", { versions: [version("d", 1, 0, [])], latest: "d-v1.0" }),
        ent("e", { versions: [version("e", 1, 0, [])], latest: "e-v1.0" }),
      ]);

    it("published mode uses the latest published content, not the newer draft", async () => {
      const r = await loadReferenceClosure(build(), "t1", "a", "published");
      expect(r.success).toBe(true);
      if (!r.success) return;
      expect(names(r.data)).toEqual(["A", "B", "D"]);
      expect(r.data.entities.map((e) => e.source)).toEqual(["published", "published", "published"]);
      expect(r.data.entities[1].version).toBe("1.1");
      expect(r.data.draftEntities).toEqual([]);
    });

    it("draft mode uses the latest saved rows", async () => {
      const r = await loadReferenceClosure(build(), "t1", "a", "draft");
      expect(r.success).toBe(true);
      if (!r.success) return;
      expect(names(r.data)).toEqual(["A", "B", "E"]);
      expect(r.data.entities.map((e) => e.source)).toEqual(["draft", "draft", "draft"]);
      expect(r.data.draftEntities.map((x) => x.entity)).toEqual(["A", "B", "E"]);
    });

    it("a pin overrides published mode", async () => {
      const aSnapshot = [toField({ id: "s", name: "b", decorators: qref("b", "_tenant/_tenant/B", "1.0") }, 0)];
      const db = fakeDb([
        ent("a", { versions: [{ ...version("a", 1, 0, []), fieldSnapshot: aSnapshot }], latest: "a-v1.0" }),
        ent("b", { versions: [version("b", 1, 0, ["C"]), version("b", 1, 1, ["D"])], latest: "b-v1.1" }),
        ent("c", { versions: [version("c", 1, 0, [])], latest: "c-v1.0" }),
        ent("d", { versions: [version("d", 1, 0, [])], latest: "d-v1.0" }),
      ]);
      const r = await loadReferenceClosure(db, "t1", "a", "published");
      expect(r.success).toBe(true);
      if (!r.success) return;
      expect(names(r.data)).toEqual(["A", "B", "C"]);
      expect(r.data.entities[1].source).toBe("pinned");
      expect(r.data.entities[1].version).toBe("1.0");
    });

    it("a pin overrides draft mode too", async () => {
      const db = fakeDb([
        ent("a", {}, [["b", qref("b", "_tenant/_tenant/B", "1.0")]]),
        ent("b", { versions: [version("b", 1, 0, ["C"])], latest: "b-v1.0" }, [["e", ref("E")]]),
        ent("c"),
        ent("e"),
      ]);
      const r = await loadReferenceClosure(db, "t1", "a", "draft");
      expect(r.success && names(r.data)).toEqual(["A", "B", "C"]);
    });

    it("returns PIN_NOT_FOUND for a missing pinned version", async () => {
      const db = fakeDb([
        ent("a", {}, [["b", qref("b", "_tenant/_tenant/B", "9.9")]]),
        ent("b", { versions: [version("b", 1, 0, [])], latest: "b-v1.0" }),
      ]);
      const r = await loadReferenceClosure(db, "t1", "a", "draft");
      expect(r.success).toBe(false);
      if (r.success) return;
      expect(r.error).toMatchObject({ code: "PIN_NOT_FOUND", field: "b", version: "9.9" });
    });

    it("published mode returns NEVER_PUBLISHED for a never-published target", async () => {
      const db = fakeDb([ent("a", { versions: [version("a", 1, 0, ["B"])], latest: "a-v1.0" }), ent("b")]);
      const r = await loadReferenceClosure(db, "t1", "a", "published");
      expect(r.success).toBe(false);
      if (r.success) return;
      expect(r.error).toMatchObject({ code: "NEVER_PUBLISHED", ref: { entity: "B" } });
    });
  });

  it("published mode ignores post-publish field and description edits; draft mode sees them", async () => {
    const mk = () =>
      fakeDb([
        ent("a", { versions: [version("a", 1, 0, ["B"])], latest: "a-v1.0" }, [["x", ref("C")]]),
        ent("b", { versions: [version("b", 1, 0, [])], latest: "b-v1.0" }),
        ent("c", { versions: [version("c", 1, 0, [])], latest: "c-v1.0" }),
      ]);
    const db = mk();
    const pub = await loadReferenceClosure(db, "t1", "a", "published");
    expect(pub.success && names(pub.data)).toEqual(["A", "B"]);
    expect(pub.success && pub.data.root.fields[0].name).toBe("s0");
    const dr = await loadReferenceClosure(db, "t1", "a", "draft");
    expect(dr.success && names(dr.data)).toEqual(["A", "C"]);
    // description is not snapshotted: documented limit, entity-level data stays live
    expect(pub.success && pub.data.root.entity.description).toBe("");
  });

  it("passes the real domain slug through", async () => {
    const db = fakeDb([ent("a", { domain: "Sales Dom", product: "p" })]);
    const r = await loadReferenceClosure(db, "t1", "a", "draft");
    expect(r.success && r.data.root.entity.domain?.slug).toBe("Sales Dom-slug");
  });

  it("pin conflict: the first visited pin wins", async () => {
    const db = fakeDb([
      ent("a", {}, [
        ["f1", qref("b", "_tenant/_tenant/B", "1.0")],
        ["f2", qref("b", "_tenant/_tenant/B", "1.1")],
      ]),
      ent("b", { versions: [version("b", 1, 0, ["C"]), version("b", 1, 1, ["D"])], latest: "b-v1.1" }),
      ent("c"),
      ent("d"),
    ]);
    const r = await loadReferenceClosure(db, "t1", "a", "draft");
    expect(r.success && names(r.data)).toEqual(["A", "B", "C"]);
    expect(r.success && r.data.entities[1].version).toBe("1.0");
  });

  it("a dangling id falls back to the qualified name", async () => {
    const db = fakeDb([
      ent("a", {}, [["x", qref("old-id", "d1/p1/Address")]]),
      ent("x1", { name: "Address", domain: "d1", product: "p1" }),
    ]);
    const r = await loadReferenceClosure(db, "t1", "a", "draft");
    expect(r.success && r.data.entities.map((e) => e.entityId)).toEqual(["a", "x1"]);
  });

  it("never includes an entity of another tenant (dangling)", async () => {
    const db = fakeDb([
      ent("a", {}, [["x", qref("x", "_tenant/_tenant/X")]]),
      ent("x", { tenantId: "t2", name: "X" }),
    ]);
    const r = await loadReferenceClosure(db, "t1", "a", "draft");
    expect(r.success && names(r.data)).toEqual(["A"]);
  });

  it("returns CROSS_TENANT when the root is not in the tenant", async () => {
    const db = fakeDb([ent("x", { tenantId: "t2" })]);
    const r = await loadReferenceClosure(db, "t1", "x", "draft");
    expect(r.success).toBe(false);
    if (!r.success) expect(r.error.code).toBe("CROSS_TENANT");
  });

  it("leaves a deleted target dangling without error", async () => {
    const db = fakeDb([ent("a", {}, [["gone", qref("deleted-id", "d/p/Gone")]])]);
    const r = await loadReferenceClosure(db, "t1", "a", "draft");
    expect(r.success && names(r.data)).toEqual(["A"]);
  });

  it("returns CLOSURE_TOO_LARGE for a 201-entity chain, ok at the limit", async () => {
    const nm = (i: number) => `E${String(i).padStart(3, "0")}`;
    const chain = (n: number) =>
      Array.from({ length: n }, (_, i) =>
        ent(`e${i}`, { name: nm(i) }, i < n - 1 ? [["n", ref(nm(i + 1))]] : [])
      );
    const big = await loadReferenceClosure(fakeDb(chain(201)), "t1", "e0", "draft");
    expect(big.success).toBe(false);
    if (!big.success) expect(big.error).toEqual({ code: "CLOSURE_TOO_LARGE", limit: 200 });
    const okr = await loadReferenceClosure(fakeDb(chain(200)), "t1", "e0", "draft");
    expect(okr.success && okr.data.entities).toHaveLength(200);
    const small = await loadReferenceClosure(fakeDb(chain(5)), "t1", "e0", "draft", { maxEntities: 3 });
    expect(small.success).toBe(false);
  });
});

// Task 7: what the generate action needs of the loader (who owns an ambiguous field, which legacy references resolved).
describe("loadReferenceClosure: ambiguity owner and legacy resolutions", () => {
  it("names the entity and the field row that own an ambiguous reference, also when it sits in a member", async () => {
    const db = fakeDb([
      ent("a", {}, [["b", ref("B")]]),
      ent("b", {}, [["addr", ref("Address")]]),
      ent("x1", { name: "Address", domain: "d1", product: "p1" }),
      ent("x2", { name: "Address", domain: "d2", product: "p2" }),
    ]);
    const r = await loadReferenceClosure(db, "t1", "a", "draft");
    expect(r.success).toBe(false);
    if (r.success) return;
    expect(r.error).toMatchObject({ code: "AMBIGUOUS_REFERENCE", field: "addr", entityId: "b", fieldId: "b-addr" });
  });

  it("reports a legacy name that resolved to exactly one entity, with the owner, the field row and the qualified target", async () => {
    const db = fakeDb([
      ent("a", {}, [["cust", ref("Customer")], ["plain", {}]]),
      ent("c", { name: "Customer", domain: "Sales", product: "Crm" }),
    ]);
    const r = await loadReferenceClosure(db, "t1", "a", "draft");
    expect(r.success).toBe(true);
    if (!r.success) return;
    expect(r.data.upgrades).toEqual([
      { entityId: "a", fieldId: "a-cust", fieldName: "cust", ref: { entityId: "c", domain: "Sales", product: "Crm", entity: "Customer" } },
    ]);
  });

  it("reports no upgrade for a qualified reference, a dangling one, or published content (a frozen snapshot is never rewritten)", async () => {
    const db = fakeDb([
      ent("a", {}, [["q", qref("c", "Sales/Crm/Customer")], ["gone", ref("Nowhere")]]),
      ent("c", { name: "Customer", domain: "Sales", product: "Crm" }),
    ]);
    const draft = await loadReferenceClosure(db, "t1", "a", "draft");
    expect(draft.success && draft.data.upgrades).toEqual([]);
    const published = await loadReferenceClosure(
      fakeDb([ent("a", { versions: [version("a", 1, 0, ["C"])], latest: "a-v1.0" }), ent("c", { versions: [version("c", 1, 0, [])], latest: "c-v1.0" })]),
      "t1",
      "a",
      "published"
    );
    expect(published.success).toBe(true);
    expect(published.success && published.data.upgrades).toEqual([]);
  });
});
