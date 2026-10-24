import { describe, it, expect } from "vitest";
import { compileEntity, type PrismaFieldInput } from "@/lib/compiler/compiler.service";

const fld = (decorators: unknown): PrismaFieldInput => ({
  id: "f-ref", name: "ref", type: "reference", precision: null, scale: null, nullable: true, isKey: false,
  fieldNumber: null, description: "", classification: null, aliases: [], decorators, sortOrder: 0,
});

function compile(decorators: unknown) {
  const model = compileEntity(
    { id: "e1", name: "Thing", description: "", status: "DRAFT", version: 1, domainId: null, metadata: {}, domain: null },
    [fld(decorators)]
  );
  return model.fields[0].complexType;
}

describe("compileEntity reference identity", () => {
  it("exposes a validated EntityRef for a qualified reference", () => {
    const ct = compile({
      referencedEntityId: "e2", referencedEntityName: "Order",
      referencedQualifiedName: "sales/orders/Order", referencedEntityVersion: "3",
    });
    expect(ct?.reference).toEqual({
      entityId: "e2", domain: "sales", product: "orders", entity: "Order", pinnedVersion: "3",
    });
    expect(ct?.referencedEntityId).toBe("e2");
  });

  it("keeps the legacy name for a name-only reference and invents no version", () => {
    const ct = compile({ referencedEntityName: "Address" });
    expect(ct?.reference).toEqual({ legacyName: "Address" });
    expect(ct?.referencedEntityName).toBe("Address");
    expect(ct?.referencedEntityVersion).toBeUndefined();
  });

  it("does not pass non-string values through", () => {
    const ct = compile({ referencedQualifiedName: 5, referencedEntityVersion: { v: 1 }, referencedEntityId: 7 });
    expect(ct?.referencedQualifiedName).toBeUndefined();
    expect(ct?.referencedEntityVersion).toBeUndefined();
    expect(ct?.referencedEntityId).toBeUndefined();
    expect(ct?.reference).toBeUndefined();
  });
});
