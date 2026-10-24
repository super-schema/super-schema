import { describe, it, expect } from "vitest";
import { draftReferencedEntities, draftReferenceRefusal } from "@/lib/entity-versioning/schema-version-publishability";
import type { SchemaVersionResolution } from "@/types/schema-version";

const ref = (id: string, entity: string, domain = "Sales", product = "Orders") => ({ entityId: id, domain, product, entity });
const entry = (id: string, entity: string, source: "published" | "draft" | "pinned", version?: string) => ({
  ref: ref(id, entity),
  ...(version ? { version } : {}),
  source,
});
const resolution = (mode: "draft" | "published", entities: SchemaVersionResolution["entities"]): SchemaVersionResolution => ({
  mode,
  preview: entities.some((e) => e.source === "draft"),
  entities,
});

describe("draftReferencedEntities (what makes a stored schema version unpublishable)", () => {
  it("lists every REFERENCED entity resolved at draft state, in the order recorded", () => {
    const r = resolution("draft", [entry("a", "Order", "draft"), entry("c", "Customer", "draft"), entry("p", "Address", "published", "1.0"), entry("z", "Zip", "draft")]);
    expect(draftReferencedEntities(r, "a")).toEqual([ref("c", "Customer"), ref("z", "Zip")]);
  });

  it("never counts the root itself: it is always at draft state in draft mode, with or without references", () => {
    expect(draftReferencedEntities(resolution("draft", [entry("a", "Order", "draft")]), "a")).toEqual([]);
  });

  it("pinned and published references are fine, even beside a draft root", () => {
    const r = resolution("draft", [entry("a", "Order", "draft"), entry("c", "Customer", "pinned", "1.0"), entry("p", "Address", "published", "2.1")]);
    expect(draftReferencedEntities(r, "a")).toEqual([]);
  });

  it("a version regenerated in published mode has none", () => {
    const r = resolution("published", [entry("a", "Order", "published", "1.0"), entry("c", "Customer", "published", "1.0")]);
    expect(draftReferencedEntities(r, "a")).toEqual([]);
  });

  it("a version with no resolution (a DB or native target, or one stored before references) has none", () => {
    expect(draftReferencedEntities(undefined, "a")).toEqual([]);
  });

  it("the root is found by id wherever it sits in the list", () => {
    const r = resolution("draft", [entry("c", "Customer", "draft"), entry("a", "Order", "draft")]);
    expect(draftReferencedEntities(r, "a")).toEqual([ref("c", "Customer")]);
  });

  it("when no entry carries the root's id the first entry (the root, by construction) is the root", () => {
    const r = resolution("draft", [entry("legacy", "Order", "draft"), entry("c", "Customer", "draft")]);
    expect(draftReferencedEntities(r, "a")).toEqual([ref("c", "Customer")]);
  });

  it.each([
    ["entities is not an array", { mode: "draft", preview: true, entities: "x" }],
    ["entities is missing", { mode: "draft", preview: true }],
    ["resolution is null", null],
    ["resolution is a string", "draft"],
    ["entries are junk", { mode: "draft", preview: true, entities: [null, 3, { ref: null, source: "draft" }, { source: "draft" }] }],
  ])("malformed stored data (%s) reads as nothing to refuse, never throws", (_label, stored) => {
    expect(draftReferencedEntities(stored as never, "a")).toEqual([]);
  });
});

describe("draftReferenceRefusal", () => {
  it("names each draft entity (domain / product / entity) and says how to fix it", () => {
    const message = draftReferenceRefusal([ref("c", "Customer"), ref("z", "Zip", "Geo", "Codes")]);
    expect(message).toContain("Sales / Orders / Customer");
    expect(message).toContain("Geo / Codes / Zip");
    expect(message).toMatch(/published mode/);
    expect(message).toMatch(/regenerate/i);
  });

  it("does not tell the user to publish what may already be published: draft-mode generation lists every member as draft", () => {
    // The common case is that they ARE published (a page-generated version records every member at its saved state), so the
    // instruction is conditional, never "publish them first".
    for (const drafts of [[ref("c", "Customer")], [ref("c", "Customer"), ref("z", "Zip")]]) {
      const message = draftReferenceRefusal(drafts);
      expect(message).not.toMatch(/Publish (them|it) first/);
      expect(message).toMatch(/Publish any of them that are not yet published, then regenerate/);
      expect(message).toMatch(/from the published versions/);
    }
  });

  it("says the entity's own unpublished edits are not part of a regeneration from the published versions", () => {
    expect(draftReferenceRefusal([ref("c", "Customer")])).toMatch(/unpublished edits to this entity itself are not included/);
  });

  it("names at most five, then +N more", () => {
    const many = Array.from({ length: 8 }, (_, i) => ref(`e${i}`, `E${i}`));
    const message = draftReferenceRefusal(many);
    expect(message).toContain("E4");
    expect(message).not.toContain("E5");
    expect(message).toContain("+3 more");
  });
});
