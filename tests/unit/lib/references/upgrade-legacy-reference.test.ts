import { describe, expect, it } from "vitest";
import { upgradeLegacyReference } from "@/lib/references/entity-reference";

const RESOLVED = { entityId: "e2", domain: "Sales", product: "Crm", entity: "Customer" };

describe("upgradeLegacyReference", () => {
  it("adds the qualified name and id, preserving other decorator keys", () => {
    const out = upgradeLegacyReference({ referencedEntityName: "Customer", cardinality: "one-to-one" }, RESOLVED);
    expect(out).toEqual({
      cardinality: "one-to-one",
      referencedEntityName: "Customer",
      referencedEntityId: "e2",
      referencedQualifiedName: "Sales/Crm/Customer",
    });
  });

  it("never adds a version", () => {
    expect(upgradeLegacyReference({ referencedEntityName: "Customer" }, RESOLVED)).not.toHaveProperty("referencedEntityVersion");
  });

  it("keeps an existing pin", () => {
    const out = upgradeLegacyReference({ referencedEntityName: "Customer", referencedEntityVersion: "1.2" }, RESOLVED);
    expect(out.referencedEntityVersion).toBe("1.2");
  });

  it("does not mutate its input", () => {
    const input = { referencedEntityName: "Customer" };
    upgradeLegacyReference(input, RESOLVED);
    expect(input).toEqual({ referencedEntityName: "Customer" });
  });
});
