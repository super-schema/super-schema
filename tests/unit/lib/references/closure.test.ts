import { describe, it, expect } from "vitest";
import { loadReferenceClosure, type ClosureError } from "@/lib/references/closure";
import { qualifiedName, upgradeLegacyReference, writeFieldReference } from "@/lib/references/entity-reference";

type FieldRow = { id: string; name: string; decorators: Record<string, unknown>; type?: string };
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
  metadata?: unknown; // read per member by `entity.findUnique`, never by the tenant index
};

/** What the last `fakeDb` was asked: the tenant index query and the per-member metadata reads. */
const queries = { findMany: [] as Array<{ where: unknown; select: Record<string, unknown> }>, findUnique: [] as Array<{ where: { id: string }; select: unknown }> };

const toField = (f: FieldRow, i: number) => ({
  id: f.id,
  name: f.name,
  type: f.type ?? "reference",
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
  queries.findMany = [];
  queries.findUnique = [];
  return {
    entity: {
      // Like Prisma: only what `select` names is returned (the index must not name `metadata`, which can hold every schema version).
      findMany: async (args: { where: { tenantId: string }; select: Record<string, unknown> }) => {
        queries.findMany.push(args);
        return rows
          .filter((r) => r.tenantId === args.where.tenantId)
          .map((r) => ({
            id: r.id,
            name: r.name,
            description: "",
            status: "DRAFT",
            version: 1,
            domainId: r.domain ? `d-${r.domain}` : null,
            productId: r.product ? `p-${r.product}` : null,
            ...(args.select.metadata ? { metadata: r.metadata ?? null } : {}),
            latestVersionId: r.latest ?? null,
            domain: r.domain ? { id: `d-${r.domain}`, name: r.domain, slug: `${r.domain}-slug` } : null,
            product: r.product ? { name: r.product } : null,
          }));
      },
      findUnique: async (args: { where: { id: string }; select: unknown }) => {
        queries.findUnique.push(args);
        const row = rows.find((r) => r.id === args.where.id);
        return row ? { metadata: row.metadata ?? null } : null;
      },
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

/** A field of a type other than `reference` (the fixture default): `[name, decorators, type]`. */
type TypedField = [string, Record<string, unknown>, string?];

function ent(id: string, over: Partial<EntityRow> = {}, fields: TypedField[] = []): EntityRow {
  return {
    id,
    name: id.toUpperCase(),
    tenantId: "t1",
    fields: fields.map(([name, decorators, type]) => ({ id: `${id}-${name}`, name, decorators, ...(type ? { type } : {}) })),
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
  describe("a field that is not (or no longer) a reference", () => {
    it("ignores the stale reference keys of a retyped field: the old target is not in the closure, whatever it would have been", async () => {
      const db = fakeDb([
        ent("a", {}, [["was_ref", { ...qref("b", "_tenant/_tenant/B", "9.9") }, "string"]]),
        // never published and pinned to a version that does not exist: either would fail the closure if the field counted
        ent("b"),
      ]);
      const r = await loadReferenceClosure(db, "t1", "a", "published", { rootAtDraft: true });
      expect(r.success && names(r.data)).toEqual(["A"]);
    });

    it("ignores a stale name-only reference on a plain field (it would be an ambiguous pick for nothing)", async () => {
      const db = fakeDb([
        ent("a", {}, [["x", ref("Address"), "integer"]]),
        ent("x1", { name: "Address", domain: "d1", product: "p1" }),
        ent("x2", { name: "Address", domain: "d2", product: "p2" }),
      ]);
      const r = await loadReferenceClosure(db, "t1", "a", "draft");
      expect(r.success && names(r.data)).toEqual(["A"]);
    });

    it("still follows an array of references and a map of references", async () => {
      const db = fakeDb([
        ent("a", {}, [
          ["list", { arrayElementType: "reference", ...ref("B") }, "array"],
          ["byKey", { mapKeyType: "string", mapValueType: "reference", ...ref("C") }, "map"],
        ]),
        ent("b"),
        ent("c"),
      ]);
      const r = await loadReferenceClosure(db, "t1", "a", "draft");
      expect(r.success && names(r.data)).toEqual(["A", "B", "C"]);
    });

    it("an array whose elements are not references is not followed, even with a stale target", async () => {
      const db = fakeDb([ent("a", {}, [["list", { arrayElementType: "string", ...ref("B") }, "array"]]), ent("b")]);
      const r = await loadReferenceClosure(db, "t1", "a", "draft");
      expect(r.success && names(r.data)).toEqual(["A"]);
    });
  });

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

  it("two fields that pin DIFFERENT versions of one entity are a PIN_CONFLICT naming both fields and owners (no silent winner)", async () => {
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
    expect(r.success).toBe(false);
    if (r.success) return;
    expect(r.error).toMatchObject({ code: "PIN_CONFLICT", ref: { entity: "B" } });
    if (r.error.code !== "PIN_CONFLICT") return;
    expect(r.error.pins).toEqual([
      { field: "f1", owner: expect.objectContaining({ entity: "A" }), version: "1.0" },
      { field: "f2", owner: expect.objectContaining({ entity: "A" }), version: "1.1" },
    ]);
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

// Task 7 fix round 1: the tenant index must stay small, and a missing tenant must not mean "every tenant".
describe("loadReferenceClosure: what it reads", () => {
  const bulky = { schemaVersions: { json: [{ version: 1, output: "x".repeat(1000), files: [{ path: "a.json", content: "y".repeat(1000) }] }] } };

  it("does not select `metadata` in the tenant index, and reads it only for the members that are in the closure", async () => {
    const db = fakeDb([
      ent("a", { metadata: { tags: ["t"], ...bulky } }, [["b", ref("B")]]),
      ent("b", { metadata: bulky }),
      ent("u1", { metadata: bulky }),
      ent("u2", { metadata: bulky }),
      ent("u3", { metadata: bulky }),
    ]);
    const r = await loadReferenceClosure(db, "t1", "a", "draft");
    expect(r.success && names(r.data)).toEqual(["A", "B"]);
    expect(queries.findMany).toHaveLength(1);
    expect(queries.findMany[0].select).not.toHaveProperty("metadata");
    // One read per member (2), not one per entity of the tenant (5); each selects only the metadata.
    expect(queries.findUnique.map((q) => q.where.id).sort()).toEqual(["a", "b"]);
    expect(queries.findUnique.every((q) => JSON.stringify(q.select) === JSON.stringify({ metadata: true }))).toBe(true);
  });

  it("keeps what emission reads of the metadata and drops the schema versions, in draft and in published mode", async () => {
    const meta = { tags: ["t"], custom: { extensions: { "x-a": 1 } }, retentionPolicy: { days: 3 }, ...bulky };
    const draft = await loadReferenceClosure(fakeDb([ent("a", { metadata: meta })]), "t1", "a", "draft");
    expect(draft.success && draft.data.root.entity.metadata).toEqual({ tags: ["t"], custom: { extensions: { "x-a": 1 } }, retentionPolicy: { days: 3 } });
    const published = await loadReferenceClosure(
      fakeDb([ent("a", { metadata: meta, versions: [version("a", 1, 0, [])], latest: "a-v1.0" })]),
      "t1",
      "a",
      "published"
    );
    expect(published.success && published.data.root.entity.metadata).toEqual({ tags: ["t"], custom: { extensions: { "x-a": 1 } }, retentionPolicy: { days: 3 } });
  });

  it("passes a null or non-object metadata through unchanged", async () => {
    const db = fakeDb([ent("a"), ent("b", { metadata: ["not", "an", "object"] })]);
    const none = await loadReferenceClosure(db, "t1", "a", "draft");
    expect(none.success && none.data.root.entity.metadata).toBeNull();
    const odd = await loadReferenceClosure(db, "t1", "b", "draft");
    expect(odd.success && odd.data.root.entity.metadata).toEqual(["not", "an", "object"]);
  });

  it("does not mutate what the database returned", async () => {
    const meta = { tags: ["t"], ...bulky };
    await loadReferenceClosure(fakeDb([ent("a", { metadata: meta })]), "t1", "a", "draft");
    expect(meta).toHaveProperty("schemaVersions");
  });

  it.each([["empty string", ""], ["blank", "   "], ["undefined", undefined], ["null", null], ["a number", 5]])(
    "refuses %s as the tenant before querying (Prisma would read an undefined filter as no filter at all)",
    async (_label, tenantId) => {
      const db = fakeDb([ent("a")]);
      const r = await loadReferenceClosure(db, tenantId as never, "a", "draft");
      expect(r).toEqual({ success: false, error: { code: "CROSS_TENANT" } });
      expect(queries.findMany).toHaveLength(0);
    }
  );
});

describe("loadReferenceClosure: rootAtDraft (the closure a PUBLISH of the root is judged against)", () => {
  // A is being published, so it has no published version to read (or an older one): its CURRENT rows are what is frozen. What it
  // references must still be a PUBLISHED version, never a draft.
  const world = () =>
    fakeDb([
      ent("a", {}, [["cust", qref("b", "_tenant/_tenant/B")]]),
      ent("b", { versions: [version("b", 1, 0, ["C"])], latest: "b-v1.0" }, [["draft-only", ref("D")]]),
      ent("c", { versions: [version("c", 1, 0, [])], latest: "c-v1.0" }),
      ent("d"),
    ]);

  it("loads the root from its saved rows and every member from its latest published version", async () => {
    const r = await loadReferenceClosure(world(), "t1", "a", "published", { rootAtDraft: true });
    expect(r.success).toBe(true);
    if (!r.success) return;
    expect(r.data.entities.map((e) => [e.ref.entity, e.source, e.version])).toEqual([
      ["A", "draft", undefined],
      ["B", "published", "1.0"],
      ["C", "published", "1.0"],
    ]);
    // B's saved draft references D, B's published 1.0 does not: D is not part of a published closure.
    expect(names(r.data)).not.toContain("D");
    expect(r.data.draftEntities.map((e) => e.entity)).toEqual(["A"]);
  });

  it("a root that was never published is not NEVER_PUBLISHED, but a never-published member still is", async () => {
    const db = fakeDb([ent("a", {}, [["cust", qref("b", "_tenant/_tenant/B")]]), ent("b")]);
    const r = await loadReferenceClosure(db, "t1", "a", "published", { rootAtDraft: true });
    expect(r.success).toBe(false);
    if (r.success) return;
    expect(r.error).toMatchObject({ code: "NEVER_PUBLISHED", ref: { entity: "B" } });
  });

  it("without the option the same never-published root is refused (published mode reads the root's published version too)", async () => {
    const db = fakeDb([ent("a"), ent("b")]);
    const r = await loadReferenceClosure(db, "t1", "a", "published");
    expect(r.success).toBe(false);
    if (r.success) return;
    expect(r.error).toMatchObject({ code: "NEVER_PUBLISHED", ref: { entity: "A" } });
  });

  it("a member that refers back to the root does not load the root a second time", async () => {
    const db = fakeDb([
      ent("a", {}, [["cust", qref("b", "_tenant/_tenant/B")]]),
      ent("b", { versions: [version("b", 1, 0, ["A"])], latest: "b-v1.0" }),
    ]);
    const r = await loadReferenceClosure(db, "t1", "a", "published", { rootAtDraft: true });
    expect(r.success && r.data.entities.map((e) => [e.ref.entity, e.source])).toEqual([["A", "draft"], ["B", "published"]]);
    expect(r.success && r.data.cycles).toEqual([["_tenant/_tenant/A", "_tenant/_tenant/B"]]);
  });

  it("a pin on a member still wins", async () => {
    const db = fakeDb([
      ent("a", {}, [["cust", qref("b", "_tenant/_tenant/B", "1.0")]]),
      ent("b", { versions: [version("b", 1, 0, []), version("b", 1, 1, ["C"])], latest: "b-v1.1" }),
      ent("c", { versions: [version("c", 1, 0, [])], latest: "c-v1.0" }),
    ]);
    const r = await loadReferenceClosure(db, "t1", "a", "published", { rootAtDraft: true });
    expect(r.success && r.data.entities.map((e) => [e.ref.entity, e.source, e.version])).toEqual([
      ["A", "draft", undefined],
      ["B", "pinned", "1.0"],
    ]);
  });
});

// FINAL WAVE 2b, G1: a pin on ANY edge to an entity applies to the entity (a closure resolves each entity once).
describe("loadReferenceClosure: several edges to one entity, one of them pinned", () => {
  const b2 = () => ent("b", { versions: [version("b", 1, 0, ["C"]), version("b", 2, 0, ["D"])], latest: "b-v2.0" });
  const world = (aFields: TypedField[], extra: EntityRow[] = []) =>
    fakeDb([ent("a", {}, aFields), b2(), ent("c", { versions: [version("c", 1, 0, [])], latest: "c-v1.0" }), ent("d", { versions: [version("d", 1, 0, [])], latest: "d-v1.0" }), ...extra]);
  const pinned = qref("b", "_tenant/_tenant/B", "1.0");
  const unpinned = qref("b", "_tenant/_tenant/B");

  it.each([
    ["the unpinned field sorts first", [["a_unpinned", unpinned], ["b_pinned", pinned]] as TypedField[]],
    ["the pinned field sorts first", [["a_pinned", pinned], ["b_unpinned", unpinned]] as TypedField[]],
  ])("the pin wins over an unpinned edge to the same entity (%s)", async (_label, fields) => {
    const r = await loadReferenceClosure(world(fields), "t1", "a", "draft");
    expect(r.success).toBe(true);
    if (!r.success) return;
    expect(r.data.entities.map((e) => [e.ref.entity, e.source, e.version])).toEqual([
      ["A", "draft", undefined],
      ["B", "pinned", "1.0"],
      ["C", "draft", undefined],
    ]);
    // Both facts are recorded: which field was unpinned, which pinned.
    expect(r.data.notes).toHaveLength(1);
    expect(r.data.notes[0]).toMatch(/is unpinned but .* pins B 1\.0: the pin was used for both/);
    expect(r.data.notes[0]).toContain(fields.map((f) => f[0]).find((n) => n.includes("unpinned")) as string);
    expect(r.data.notes[0]).toContain(fields.map((f) => f[0]).find((n) => n.includes("_pinned") || n.startsWith("a_pinned")) as string);
  });

  it("the pin wins in published mode too (B resolves to 1.0, not the latest published 2.0)", async () => {
    const db = fakeDb([
      ent("a", { versions: [{ ...version("a", 1, 0, []), fieldSnapshot: [toField({ id: "s1", name: "a_unpinned", decorators: unpinned }, 0), toField({ id: "s2", name: "b_pinned", decorators: pinned }, 1)] }], latest: "a-v1.0" }),
      b2(),
      ent("c", { versions: [version("c", 1, 0, [])], latest: "c-v1.0" }),
      ent("d", { versions: [version("d", 1, 0, [])], latest: "d-v1.0" }),
    ]);
    const r = await loadReferenceClosure(db, "t1", "a", "published");
    expect(r.success && r.data.entities.map((e) => [e.ref.entity, e.source, e.version])).toEqual([
      ["A", "published", "1.0"],
      ["B", "pinned", "1.0"],
      ["C", "published", "1.0"],
    ]);
  });

  it("two fields that pin the SAME version are fine: no conflict and no note", async () => {
    const r = await loadReferenceClosure(world([["f1", pinned], ["f2", pinned]]), "t1", "a", "draft");
    expect(r.success).toBe(true);
    if (!r.success) return;
    expect(r.data.entities.map((e) => [e.ref.entity, e.source, e.version])).toEqual([
      ["A", "draft", undefined],
      ["B", "pinned", "1.0"],
      ["C", "draft", undefined],
    ]);
    expect(r.data.notes).toEqual([]);
  });

  it("a pin on an edge of ANOTHER member applies to the entity the root already reached unpinned", async () => {
    // A -> B (unpinned) and A -> M; M -> B pinned 1.0. B is loaded (at its latest) before M is walked: the closure re-resolves it.
    const db = world(
      [["b", unpinned], ["m", qref("m", "_tenant/_tenant/M")]],
      [ent("m", {}, [["viaM", pinned]])]
    );
    const r = await loadReferenceClosure(db, "t1", "a", "draft");
    expect(r.success).toBe(true);
    if (!r.success) return;
    expect(r.data.entities.map((e) => [e.ref.entity, e.source, e.version])).toEqual([
      ["A", "draft", undefined],
      ["B", "pinned", "1.0"],
      ["M", "draft", undefined],
      ["C", "draft", undefined],
    ]);
    // D (what B 2.0 references) is not in the closure: the entity is B 1.0 everywhere.
    expect(names(r.data)).not.toContain("D");
    expect(r.data.notes[0]).toMatch(/M\.viaM|viaM/);
  });

  it("different pins on edges of different members conflict, naming both owners", async () => {
    const db = world(
      [["p", pinned], ["m", qref("m", "_tenant/_tenant/M")]],
      [ent("m", {}, [["viaM", qref("b", "_tenant/_tenant/B", "2.0")]])]
    );
    const r = await loadReferenceClosure(db, "t1", "a", "draft");
    expect(r.success).toBe(false);
    if (r.success) return;
    expect(r.error.code).toBe("PIN_CONFLICT");
    if (r.error.code !== "PIN_CONFLICT") return;
    expect(r.error.pins.map((p) => [p.owner.entity, p.field, p.version])).toEqual([
      ["A", "p", "1.0"],
      ["M", "viaM", "2.0"],
    ]);
  });
});

// FINAL WAVE 2b, G2: an ambiguous bare name that sits in a FROZEN snapshot (published or pinned member) cannot be settled by a pick on
// the closure's behalf: the snapshot is immutable. The error says whose content it is so the refusal can say what actually helps.
describe("loadReferenceClosure: an ambiguous bare name inside a frozen snapshot", () => {
  const bare = (id: string) => [toField({ id: `${id}-s0`, name: "addr", decorators: ref("Address") }, 0)];
  const x1Fields = [toField({ id: "x-s0", name: "y", decorators: qref("y", "_tenant/_tenant/Y") }, 0)];
  const addresses = () => [
    ent("ad1", { name: "Address", versions: [version("ad1", 1, 0, [])], latest: "ad1-v1.0" }),
    ent("ad2", { name: "Address", domain: "d2", product: "p2", versions: [version("ad2", 1, 0, [])], latest: "ad2-v1.0" }),
  ];
  const world = (yVersions: VersionRow[], yLatest: string, yLive: TypedField[] = []) =>
    fakeDb([
      ent("x", { versions: [{ ...version("x", 1, 0, []), fieldSnapshot: x1Fields }], latest: "x-v1.0" }),
      ent("y", { versions: yVersions, latest: yLatest }, yLive),
      ...addresses(),
    ]);
  const y10 = { ...version("y", 1, 0, []), fieldSnapshot: bare("y") };

  it("published mode names the owner as frozen: the snapshot holds the bare name, whatever the live row says", async () => {
    const r = await loadReferenceClosure(world([y10], "y-v1.0", [["addr", qref("ad2", "d2/p2/Address")]]), "t1", "x", "published");
    expect(r.success).toBe(false);
    if (r.success) return;
    expect(r.error).toMatchObject({ code: "AMBIGUOUS_REFERENCE", entityId: "y", frozen: true, owner: { entity: "Y" } });
  });

  it("a pinned member is frozen too", async () => {
    const db = fakeDb([
      ent("x", {}, [["y", qref("y", "_tenant/_tenant/Y", "1.0")]]),
      ent("y", { versions: [y10], latest: "y-v1.0" }),
      ...addresses(),
    ]);
    const r = await loadReferenceClosure(db, "t1", "x", "draft");
    expect(r.success).toBe(false);
    if (r.success) return;
    expect(r.error).toMatchObject({ code: "AMBIGUOUS_REFERENCE", entityId: "y", frozen: true });
  });

  it("draft content is not frozen: the pick writes the very field that is read", async () => {
    const db = fakeDb([ent("x", {}, [["y", qref("y", "_tenant/_tenant/Y")]]), ent("y", {}, [["addr", ref("Address")]]), ...addresses()]);
    const r = await loadReferenceClosure(db, "t1", "x", "draft");
    expect(r.success).toBe(false);
    if (r.success) return;
    expect(r.error).toMatchObject({ code: "AMBIGUOUS_REFERENCE", entityId: "y", frozen: false });
  });

  // FINAL WAVE 2b, G3 lives below (names that hold "/").
  it("after the pick (the live row now holds the qualified reference) and a re-publish of Y, the closure resolves", async () => {
    const y11 = { ...version("y", 1, 1, []), fieldSnapshot: [toField({ id: "y-s0", name: "addr", decorators: qref("ad2", "d2/p2/Address") }, 0)] };
    const r = await loadReferenceClosure(world([y10, y11], "y-v1.1", [["addr", qref("ad2", "d2/p2/Address")]]), "t1", "x", "published");
    expect(r.success).toBe(true);
    if (!r.success) return;
    expect(r.data.entities.map((e) => [e.entityId, e.source, e.version])).toEqual([
      ["x", "published", "1.0"],
      ["y", "published", "1.1"],
      ["ad2", "published", "1.0"],
    ]);
  });
});

// FINAL WAVE 2b, G3: a name may hold "/" or "%": the reference still resolves (by id, by the qualified name) and keeps its pin.
describe("loadReferenceClosure: names that hold '/' and '%'", () => {
  const target = { id: "t", domain: "Sales/EU", product: "Orders", name: "Order/Line 100%" };
  const written = (over: { id?: string; pin?: string } = {}) =>
    writeFieldReference({}, { entityId: over.id ?? target.id, domain: target.domain, product: target.product, entity: target.name, ...(over.pin ? { pinnedVersion: over.pin } : {}) });
  const world = (decorators: Record<string, unknown>) =>
    fakeDb([
      ent("a", {}, [["line", decorators]]),
      ent("t", { name: target.name, domain: target.domain, product: target.product, versions: [version("t", 1, 0, []), version("t", 2, 0, ["Z"])], latest: "t-v2.0" }),
      ent("z", { versions: [version("z", 1, 0, [])], latest: "z-v1.0" }),
    ]);

  it("resolves a reference written with the segments, by id", async () => {
    const r = await loadReferenceClosure(world(written()), "t1", "a", "draft");
    expect(r.success && r.data.entities.map((e) => e.entityId)).toEqual(["a", "t"]);
    expect(r.success && r.data.upgrades).toEqual([]);
  });

  it("resolves it by the qualified name when its id is gone (the encoded string matches the entity's qualified name)", async () => {
    const r = await loadReferenceClosure(world(written({ id: "gone" })), "t1", "a", "draft");
    expect(r.success && r.data.entities.map((e) => e.entityId)).toEqual(["a", "t"]);
  });

  it("keeps the pin: the pinned version is used (not the latest), in draft and in published mode", async () => {
    const r = await loadReferenceClosure(world(written({ pin: "1.0" })), "t1", "a", "draft");
    expect(r.success && r.data.entities.map((e) => [e.entityId, e.source, e.version])).toEqual([["a", "draft", undefined], ["t", "pinned", "1.0"]]);
  });

  it("an old row whose qualified string cannot be split (raw '/' in the domain AND the entity name, no segment keys) still resolves by id, keeps its pin, and is upgraded ONCE", async () => {
    const old = { referencedEntityId: "t", referencedEntityName: target.name, referencedQualifiedName: "Sales/EU/Orders/Order/Line 100%", referencedEntityVersion: "1.0" };
    const r = await loadReferenceClosure(world(old), "t1", "a", "draft");
    expect(r.success).toBe(true);
    if (!r.success) return;
    expect(r.data.entities.map((e) => [e.entityId, e.source, e.version])).toEqual([["a", "draft", undefined], ["t", "pinned", "1.0"]]);
    expect(r.data.upgrades).toHaveLength(1);
    // what the upgrade writes reads as qualified: the next generation reports nothing to upgrade
    const upgraded = upgradeLegacyReference(old, r.data.upgrades[0].ref);
    const again = await loadReferenceClosure(world(upgraded), "t1", "a", "draft");
    expect(again.success && again.data.upgrades).toEqual([]);
    expect(again.success && again.data.entities.map((e) => [e.entityId, e.version])).toEqual([["a", undefined], ["t", "1.0"]]);
  });
});
