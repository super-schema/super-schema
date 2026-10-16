import { describe, it, expect } from "vitest";
import { assertNameAvailable, REGISTRY_DELEGATES, type RegistryDelegateKey, type RegistryKind } from "@/services/name-registry.service";
import { emptyRegistryDelegates } from "../../helpers/registry-mocks";

const KIND_LABELS: Record<RegistryKind, string> = {
  entity: "Entity",
  sharedEnum: "Enum",
  customScalar: "Scalar",
  unionType: "Union",
  service: "API",
  trait: "Trait",
  eventSpec: "Event Spec",
};

describe("registry delegates", () => {
  it("lists one distinct Prisma delegate per registry kind", () => {
    expect(Object.keys(REGISTRY_DELEGATES).sort()).toEqual(Object.keys(KIND_LABELS).sort());
    expect(new Set(Object.values(REGISTRY_DELEGATES)).size).toBe(Object.keys(KIND_LABELS).length);
  });

  it("emptyRegistryDelegates provides a findMany for every kind", () => {
    const delegates = emptyRegistryDelegates();
    for (const [kind, delegate] of Object.entries(REGISTRY_DELEGATES)) {
      expect(typeof delegates[delegate].findMany, kind).toBe("function");
    }
  });

  it("a clash under any kind's delegate is reported with that kind's label (no kind is skipped by the registry)", async () => {
    for (const [kind, delegate] of Object.entries(REGISTRY_DELEGATES) as Array<[RegistryKind, RegistryDelegateKey]>) {
      const db = emptyRegistryDelegates({ [delegate]: [{ id: "x1", name: "Orders", tenantId: "t", domainId: "d1", productId: "p1" }] });
      const r = await assertNameAvailable(db as never, { name: "orders", tenantId: "t", domainId: "d1", productId: "p1" });
      expect(r.success, kind).toBe(false);
      expect(!r.success && r.error.message, kind).toBe(`"orders" is already used by ${KIND_LABELS[kind]} "Orders" at Product level.`);
    }
  });
});
