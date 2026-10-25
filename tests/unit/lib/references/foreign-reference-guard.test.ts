import { describe, expect, it, vi } from "vitest";
import { newReferencedEntityId, referencedEntityAllowed } from "@/lib/references/foreign-reference-guard";
import { mergeSyncedField } from "@/lib/typespec-sync/merge-fields";

describe("newReferencedEntityId", () => {
  it("is the id the decorators name", () => {
    expect(newReferencedEntityId({ referencedEntityId: "e1" }, undefined)).toBe("e1");
    expect(newReferencedEntityId({ referencedEntityId: " e1 " }, {})).toBe("e1");
  });

  it("is nothing when the id is the one the field already holds", () => {
    expect(newReferencedEntityId({ referencedEntityId: "e1" }, { referencedEntityId: "e1" })).toBeUndefined();
    expect(newReferencedEntityId({ referencedEntityId: "e2" }, { referencedEntityId: "e1" })).toBe("e2");
  });

  it.each([undefined, null, "x", 5, [], {}, { referencedEntityId: null }, { referencedEntityId: 5 }, { referencedEntityId: "  " }, { referencedEntityId: { id: "e1" } }])(
    "is nothing for %j (a value no reader looks at)",
    (decorators) => {
      expect(newReferencedEntityId(decorators, undefined)).toBeUndefined();
    }
  );

  it("reads own properties only", () => {
    const inherited = Object.create({ referencedEntityId: "e1" });
    expect(newReferencedEntityId(inherited, undefined)).toBeUndefined();
  });
});

describe("referencedEntityAllowed", () => {
  it("asks the callback only for a new id", async () => {
    const isAllowed = vi.fn(async (id: string) => id === "mine");
    expect(await referencedEntityAllowed({ referencedEntityId: "mine" }, {}, isAllowed)).toBe(true);
    expect(await referencedEntityAllowed({ referencedEntityId: "theirs" }, {}, isAllowed)).toBe(false);
    isAllowed.mockClear();
    expect(await referencedEntityAllowed({ referencedEntityId: "theirs" }, { referencedEntityId: "theirs" }, isAllowed)).toBe(true);
    expect(await referencedEntityAllowed({ semantics: {} }, {}, isAllowed)).toBe(true);
    expect(isAllowed).not.toHaveBeenCalled();
  });
});

describe("the TypeSpec Save merge does not carry a client-supplied entity id", () => {
  // applyTypeSpecAction takes the parsed fields from the client; the merge keeps only what the source text can express, so a forged
  // `referencedEntityId` on a parsed field never reaches the stored decorators (a server-made `reference` is the only way in).
  const forged = { name: "x", type: "reference", isOptional: false, isKey: false, decorators: { referencedEntityId: "eForeign", referencedQualifiedName: "a/b/c", doc: "d" } };

  it("a new field", () => {
    const merged = mergeSyncedField(null, forged as never, {} as never);
    expect(JSON.stringify(merged.decorators)).not.toContain("eForeign");
  });

  it("an existing field keeps its own id, not the forged one", () => {
    const existing = { id: "f", name: "x", type: "reference", decorators: { referencedEntityId: "eMine" }, description: "", classification: null, nullable: false, isKey: false };
    const merged = mergeSyncedField(existing as never, forged as never, {} as never);
    expect(merged.decorators).toMatchObject({ referencedEntityId: "eMine" });
    expect(JSON.stringify(merged.decorators)).not.toContain("eForeign");
  });
});
