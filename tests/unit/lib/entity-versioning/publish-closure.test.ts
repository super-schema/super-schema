import { describe, it, expect } from "vitest";
import { readdirSync, readFileSync, statSync } from "node:fs";
import { join } from "node:path";
import {
  readReferencedVersions,
  referenceStaleness,
  type ReferencedVersion,
} from "@/lib/entity-versioning/referenced-versions";
import { loadPublishClosure } from "@/lib/entity-versioning/publish-closure";

// Task 8: publishing X is judged against X's REAL reference closure (X at its saved state, everything it references at its latest
// PUBLISHED version or pin, never a draft). This file covers the closure the publish gate loads, the record of the versions it
// used, and the staleness derived from that record. The service wiring is in tests/unit/services/entity-version-publish-closure.

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
  latest?: string;
};

const toField = (f: FieldRow, i: number) => ({
  id: f.id, name: f.name, type: "reference", precision: null, scale: null, nullable: true, isKey: false, fieldNumber: null,
  description: "", classification: null, aliases: [], decorators: f.decorators, sortOrder: i,
});

function fakeDb(rows: EntityRow[]) {
  const versions = rows.flatMap((r) => r.versions);
  return {
    entity: {
      findMany: async (args: { where: { tenantId: string } }) =>
        rows
          .filter((r) => r.tenantId === args.where.tenantId)
          .map((r) => ({
            id: r.id, name: r.name, description: "", status: "DRAFT", version: 1,
            domainId: r.domain ? `d-${r.domain}` : null, productId: r.product ? `p-${r.product}` : null,
            latestVersionId: r.latest ?? null,
            domain: r.domain ? { id: `d-${r.domain}`, name: r.domain, slug: `${r.domain}-slug` } : null,
            product: r.product ? { name: r.product } : null,
          })),
      findUnique: async (args: { where: { id: string } }) => (rows.some((r) => r.id === args.where.id) ? { metadata: null } : null),
    },
    field: {
      findMany: async ({ where }: { where: { entityId: string } }) => (rows.find((r) => r.id === where.entityId)?.fields ?? []).map(toField),
    },
    entityVersion: {
      findUnique: async ({ where }: { where: { id?: string; entityId_major_minor?: { entityId: string; major: number; minor: number } } }) => {
        if (where.id) return versions.find((v) => v.id === where.id) ?? null;
        const k = where.entityId_major_minor!;
        return versions.find((v) => v.entityId === k.entityId && v.major === k.major && v.minor === k.minor) ?? null;
      },
    },
  } as never;
}

const qref = (id: string, q: string, pin?: string) => ({
  referencedEntityId: id,
  referencedEntityName: q.split("/")[2],
  referencedQualifiedName: q,
  ...(pin ? { referencedEntityVersion: pin } : {}),
});

function ent(id: string, over: Partial<EntityRow> = {}, fields: Array<[string, Record<string, unknown>]> = []): EntityRow {
  return {
    id,
    name: id.toUpperCase(),
    tenantId: "t1",
    domain: "sales",
    product: "orders",
    fields: fields.map(([name, decorators]) => ({ id: `${id}-${name}`, name, decorators })),
    versions: [],
    ...over,
  };
}

/** A published version whose snapshot has one reference field per target id. */
const version = (entityId: string, major: number, minor: number, targets: string[] = []): VersionRow => ({
  id: `${entityId}-v${major}.${minor}`,
  entityId,
  major,
  minor,
  sequence: major * 10 + minor,
  fieldSnapshot: targets.map((t, i) => toField({ id: `${entityId}-s${i}`, name: `s${i}`, decorators: qref(t, `sales/orders/${t.toUpperCase()}`) }, i)),
});

const Q = (name: string) => `sales/orders/${name}`;
const root = { id: "a", tenantId: "t1", name: "A" };

describe("loadPublishClosure", () => {
  it("records every referenced entity (not the root) at the version the closure used, pinned or latest published, in closure order", async () => {
    const db = fakeDb([
      ent("a", {}, [["b", qref("b", Q("B"))], ["c", qref("c", Q("C"), "1.0")]]),
      ent("b", { versions: [version("b", 2, 0, ["d"])], latest: "b-v2.0" }),
      ent("c", { versions: [version("c", 1, 0), version("c", 1, 1)], latest: "c-v1.1" }),
      ent("d", { versions: [version("d", 1, 3)], latest: "d-v1.3" }),
    ]);
    const res = await loadPublishClosure(db, root);
    expect(res.success).toBe(true);
    if (!res.success) return;
    expect(res.data.referencedVersions).toEqual([
      { ref: { entityId: "b", domain: "sales", product: "orders", entity: "B" }, version: "2.0", pinned: false },
      { ref: { entityId: "c", domain: "sales", product: "orders", entity: "C" }, version: "1.0", pinned: true },
      { ref: { entityId: "d", domain: "sales", product: "orders", entity: "D" }, version: "1.3", pinned: false },
    ]);
  });

  // FINAL WAVE 2b, G1: a pin on any edge to an entity is what the publish records for it.
  it("records pinned:true (and the pinned version) for an entity reached by an unpinned field AND a pinned one", async () => {
    const db = fakeDb([
      ent("a", {}, [["a_plain", qref("b", Q("B"))], ["b_pinned", qref("b", Q("B"), "1.0")]]),
      ent("b", { versions: [version("b", 1, 0), version("b", 2, 0)], latest: "b-v2.0" }),
    ]);
    const res = await loadPublishClosure(db, root);
    expect(res.success).toBe(true);
    if (!res.success) return;
    expect(res.data.referencedVersions).toEqual([
      { ref: { entityId: "b", domain: "sales", product: "orders", entity: "B" }, version: "1.0", pinned: true },
    ]);
    expect(res.data.closure.notes[0]).toContain("is unpinned but A.b_pinned pins B 1.0");
  });

  it("two pins that disagree block the publish with PIN_CONFLICT naming both fields", async () => {
    const db = fakeDb([
      ent("a", {}, [["first", qref("b", Q("B"), "1.0")], ["second", qref("b", Q("B"), "2.0")]]),
      ent("b", { versions: [version("b", 1, 0), version("b", 2, 0)], latest: "b-v2.0" }),
    ]);
    const res = await loadPublishClosure(db, root);
    expect(res.success).toBe(false);
    if (res.success) return;
    expect(res.error.code).toBe("PIN_CONFLICT");
    expect(res.error.message).toContain("A.first");
    expect(res.error.message).toContain("A.second");
    expect(res.error.message).toContain("1.0");
    expect(res.error.message).toContain("2.0");
    expect(res.error.message).toMatch(/unpin|same version/i);
  });

  it("an entity that references nothing records nothing", async () => {
    const res = await loadPublishClosure(fakeDb([ent("a")]), root);
    expect(res.success && res.data.referencedVersions).toEqual([]);
  });

  it("never reads a draft of a referenced entity, even when one exists", async () => {
    // B was published with no fields; its saved draft has since gained a reference to D, which was never published.
    const db = fakeDb([
      ent("a", {}, [["b", qref("b", Q("B"))]]),
      ent("b", { versions: [version("b", 1, 0)], latest: "b-v1.0" }, [["d", qref("d", Q("D"))]]),
      ent("d"),
    ]);
    const res = await loadPublishClosure(db, root);
    expect(res.success).toBe(true);
    if (!res.success) return;
    expect(res.data.closure.entities.map((e) => [e.ref.entity, e.source])).toEqual([["A", "draft"], ["B", "published"]]);
    expect(res.data.closure.entities[1].fields).toEqual([]);
    expect(res.data.referencedVersions.map((r) => r.ref.entity)).toEqual(["B"]);
  });

  it("a root that was never published can be published (it is the draft being frozen)", async () => {
    const db = fakeDb([ent("a", {}, [["b", qref("b", Q("B"))]]), ent("b", { versions: [version("b", 1, 0)], latest: "b-v1.0" })]);
    expect((await loadPublishClosure(db, root)).success).toBe(true);
  });

  describe("blocks, naming the entity and saying how to fix it", () => {
    it("a directly referenced entity that was never published", async () => {
      const db = fakeDb([ent("a", {}, [["b", qref("b", Q("B"))]]), ent("b")]);
      const res = await loadPublishClosure(db, root);
      expect(res.success).toBe(false);
      if (res.success) return;
      expect(res.error).toMatchObject({ code: "NEVER_PUBLISHED", entityId: "b" });
      expect(res.error.message).toContain("Publish B first");
      expect(res.error.message).toContain("sales / orders / B");
      expect(res.error.message).toContain("never been published");
    });

    it("an entity only reachable through a published one (A -> B -> C, C never published)", async () => {
      const db = fakeDb([
        ent("a", {}, [["b", qref("b", Q("B"))]]),
        ent("b", { versions: [version("b", 1, 0, ["c"])], latest: "b-v1.0" }),
        ent("c"),
      ]);
      const res = await loadPublishClosure(db, root);
      expect(res.success).toBe(false);
      if (res.success) return;
      expect(res.error).toMatchObject({ code: "NEVER_PUBLISHED", entityId: "c" });
      expect(res.error.message).toContain("Publish C first");
    });

    it("a draft-only referenced entity: the draft is never used as a substitute", async () => {
      const db = fakeDb([ent("a", {}, [["b", qref("b", Q("B"))]]), ent("b", {}, [["x", qref("x", Q("X"))]]), ent("x")]);
      const res = await loadPublishClosure(db, root);
      expect(res.success).toBe(false);
      if (res.success) return;
      expect(res.error.entityId).toBe("b");
    });

    it("a pin whose version is gone, naming the field, the entity and the version", async () => {
      const db = fakeDb([
        ent("a", {}, [["cust", qref("b", Q("B"), "9.9")]]),
        ent("b", { versions: [version("b", 1, 0)], latest: "b-v1.0" }),
      ]);
      const res = await loadPublishClosure(db, root);
      expect(res.success).toBe(false);
      if (res.success) return;
      expect(res.error.code).toBe("PIN_NOT_FOUND");
      expect(res.error.message).toContain('"cust"');
      expect(res.error.message).toContain("9.9");
      expect(res.error.message).toContain("sales / orders / B");
      expect(res.error.message).toMatch(/unpin/i);
    });

    it("an ambiguous bare-name reference lists the candidates", async () => {
      const db = fakeDb([
        ent("a", {}, [["x", { referencedEntityName: "Address" }]]),
        ent("x1", { name: "Address", domain: "d1", product: "p1" }),
        ent("x2", { name: "Address", domain: "d2", product: "p2" }),
      ]);
      const res = await loadPublishClosure(db, root);
      expect(res.success).toBe(false);
      if (res.success) return;
      expect(res.error.code).toBe("AMBIGUOUS_REFERENCE");
      expect(res.error.message).toContain("d1 / p1 / Address");
      expect(res.error.message).toContain("d2 / p2 / Address");
    });

    it("an ambiguous reference held by the ROOT's saved rows carries the structure a pick dialog needs: the field, the name, the candidates and the entity + field row that hold it", async () => {
      const db = fakeDb([
        ent("a", {}, [["addr", { referencedEntityName: "Address" }]]),
        ent("x1", { name: "Address", domain: "d1", product: "p1" }),
        ent("x2", { name: "Address", domain: "d2", product: "p2" }),
      ]);
      const res = await loadPublishClosure(db, root);
      expect(res.success).toBe(false);
      if (res.success) return;
      expect(res.error.code).toBe("AMBIGUOUS_REFERENCE");
      expect(res.error.details).toEqual({
        field: "addr",
        name: "Address",
        candidates: [
          { entityId: "x1", domain: "d1", product: "p1", entity: "Address" },
          { entityId: "x2", domain: "d2", product: "p2", entity: "Address" },
        ],
        entityId: "a",
        fieldId: "a-addr",
      });
    });

    it("an ambiguous name frozen in a published MEMBER is marked frozen (no pick: the member must be published again) and says so", async () => {
      // The ambiguous reference is held by a MEMBER (B)'s published snapshot: a pick would write B's live row, which the publish does not read.
      const db = fakeDb([
        ent("a", {}, [["b", qref("b", Q("B"))]]),
        ent("b", { versions: [{ ...version("b", 1, 0), fieldSnapshot: [toField({ id: "b-addr", name: "addr", decorators: { referencedEntityName: "Address" } }, 0)] }], latest: "b-v1.0" }),
        ent("x1", { name: "Address", domain: "d1", product: "p1" }),
        ent("x2", { name: "Address", domain: "d2", product: "p2" }),
      ]);
      const res = await loadPublishClosure(db, root);
      expect(res.success).toBe(false);
      if (res.success) return;
      expect(res.error.code).toBe("AMBIGUOUS_REFERENCE");
      expect(res.error.details).toEqual({
        field: "addr",
        name: "Address",
        candidates: [
          { entityId: "x1", domain: "d1", product: "p1", entity: "Address" },
          { entityId: "x2", domain: "d2", product: "p2", entity: "Address" },
        ],
        entityId: "b",
        fieldId: "b-addr",
        frozen: true,
      });
      expect(res.error.message).toContain('This published version of B refers to "Address" by name');
    });

    it("the other blockers carry their own details (the entity, the pin)", async () => {
      const never = await loadPublishClosure(fakeDb([ent("a", {}, [["b", qref("b", Q("B"))]]), ent("b")]), root);
      expect(!never.success && never.error.details).toEqual({ ref: { entityId: "b", domain: "sales", product: "orders", entity: "B" } });
      const pin = await loadPublishClosure(
        fakeDb([ent("a", {}, [["cust", qref("b", Q("B"), "9.9")]]), ent("b", { versions: [version("b", 1, 0)], latest: "b-v1.0" })]),
        root
      );
      expect(!pin.success && pin.error.details).toEqual({ field: "cust", ref: { entityId: "b", domain: "sales", product: "orders", entity: "B" }, version: "9.9" });
    });

    it("a closure over the cap", async () => {
      const db = fakeDb([ent("a", {}, [["b", qref("b", Q("B"))]]), ent("b", { versions: [version("b", 1, 0)], latest: "b-v1.0" })]);
      const res = await loadPublishClosure(db, root, { maxEntities: 1 });
      expect(res.success).toBe(false);
      if (res.success) return;
      expect(res.error.code).toBe("CLOSURE_TOO_LARGE");
    });

    it("a root outside the tenant reads as a missing entity", async () => {
      const res = await loadPublishClosure(fakeDb([ent("a", { tenantId: "other" })]), root);
      expect(res.success).toBe(false);
      if (res.success) return;
      expect(res.error.message).toBe("Entity not found");
    });
  });
});

describe("readReferencedVersions", () => {
  const entry: ReferencedVersion = { ref: { entityId: "b", domain: "d", product: "p", entity: "B" }, version: "1.0", pinned: false };

  it("reads what a publish stored next to the other bookkeeping", () => {
    expect(readReferencedVersions({ referencedVersions: [entry], somethingElse: 1 })).toEqual([entry]);
  });

  it.each([[null], [undefined], [{}], [[]], ["x"], [{ referencedVersions: "x" }], [{ referencedVersions: {} }]])(
    "reads %j (a version published before references were recorded, or garbage) as nothing recorded",
    (stored) => {
      expect(readReferencedVersions(stored)).toEqual([]);
    }
  );

  it("drops a malformed entry and keeps the good ones", () => {
    const stored = {
      referencedVersions: [
        entry,
        { ref: { domain: "d", product: "p" }, version: "1.0", pinned: false },
        { ref: entry.ref, version: 3, pinned: false },
        { ref: entry.ref, version: "1.0", pinned: "yes" },
        null,
      ],
    };
    expect(readReferencedVersions(stored)).toEqual([entry]);
  });
});

describe("referenceStaleness", () => {
  const rec = (id: string, version: string, pinned: boolean): ReferencedVersion => ({
    ref: { entityId: id, domain: "d", product: "p", entity: id.toUpperCase() },
    version,
    pinned,
  });

  it("reports an unpinned reference whose entity has a newer published version, with the recorded and the latest label", () => {
    const stale = referenceStaleness({ referencedVersions: [rec("b", "1.0", false)] }, new Map([["b", "1.1"]]));
    expect(stale).toEqual([{ ref: rec("b", "1.0", false).ref, recorded: "1.0", latest: "1.1" }]);
  });

  it("never reports a pinned reference, however far behind it is", () => {
    expect(referenceStaleness({ referencedVersions: [rec("b", "1.0", true)] }, new Map([["b", "3.0"]]))).toEqual([]);
  });

  it("compares versions as numbers, not text (1.10 is newer than 1.9)", () => {
    const stale = referenceStaleness({ referencedVersions: [rec("b", "1.9", false), rec("c", "2.0", false)] }, new Map([["b", "1.10"], ["c", "1.99"]]));
    expect(stale.map((s) => s.ref.entityId)).toEqual(["b"]);
  });

  it("is quiet when the latest is the recorded version, or unknown (deleted, never published)", () => {
    expect(referenceStaleness({ referencedVersions: [rec("b", "1.0", false), rec("c", "1.0", false)] }, new Map([["b", "1.0"]]))).toEqual([]);
  });

  it("keeps the order the versions were recorded in and mixes pinned and unpinned correctly", () => {
    const stale = referenceStaleness(
      { referencedVersions: [rec("b", "1.0", false), rec("c", "1.0", true), rec("d", "2.0", false)] },
      new Map([["b", "1.2"], ["c", "1.5"], ["d", "2.1"]])
    );
    expect(stale.map((s) => [s.ref.entityId, s.recorded, s.latest])).toEqual([["b", "1.0", "1.2"], ["d", "2.0", "2.1"]]);
  });

  it("a reference recorded without an id cannot be looked up and is skipped", () => {
    const noId: ReferencedVersion = { ref: { domain: "d", product: "p", entity: "B" }, version: "1.0", pinned: false };
    expect(referenceStaleness({ referencedVersions: [noId] }, new Map([["b", "2.0"]]))).toEqual([]);
  });
});

describe("no stub models", () => {
  const SRC = join(__dirname, "../../../../src");
  function sources(dir: string): string[] {
    return readdirSync(dir).flatMap((name) => {
      const path = join(dir, name);
      if (statSync(path).isDirectory()) return name === "generated" ? [] : sources(path);
      return /\.(ts|tsx)$/.test(name) ? [path] : [];
    });
  }

  it("`stubUnresolvedReferences` does not exist anywhere in src", () => {
    const hits = sources(SRC).filter((file) => readFileSync(file, "utf8").includes("stubUnresolvedReferences"));
    expect(hits).toEqual([]);
    // It reads every file of src: 5 s is not enough when the whole unit suite runs on eight workers (a load flake of 5061 ms was seen).
  }, 60_000);
});
