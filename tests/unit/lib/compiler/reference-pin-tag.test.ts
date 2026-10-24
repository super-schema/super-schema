import { describe, it, expect, vi, beforeAll } from "vitest";
import { compileEntity, type PrismaFieldInput } from "@/lib/compiler/compiler.service";
import { generateTypeSpec } from "@/lib/compiler/typespec-generator";
import { parseTypeSpecDocument } from "@/lib/compiler/typespec-parser";
import { mergeSyncedField, type SyncExistingField, type SyncSourceField } from "@/lib/typespec-sync/merge-fields";
import { PIN_EXTENSION_KEY, pinDecorator } from "@/lib/compiler/governance-decorators";

vi.setConfig({ testTimeout: 60_000 });
vi.mock("server-only", () => ({}));

let compileTypeSpecDocument: typeof import("@/lib/compiler/typespec-compiler").compileTypeSpecDocument;
beforeAll(async () => {
  ({ compileTypeSpecDocument } = await import("@/lib/compiler/typespec-compiler"));
});

const fld = (name: string, type: string, sortOrder: number, decorators: Record<string, unknown>): PrismaFieldInput => ({
  id: `f-${name}`, name, type, precision: null, scale: null, nullable: false, isKey: false,
  fieldNumber: null, description: "", classification: null, aliases: [], decorators, sortOrder,
});

const pinned = (version?: string) => ({
  referencedEntityId: "e-c",
  referencedEntityName: "Customer",
  referencedQualifiedName: "sales/orders/Customer",
  ...(version ? { referencedEntityVersion: version } : {}),
});

const model = (version?: string) =>
  compileEntity(
    { id: "e-o", name: "Order", description: "", status: "DRAFT", version: 1, domainId: null, metadata: {}, domain: null },
    [
      fld("buyer", "reference", 0, pinned(version)),
      fld("buyers", "array", 1, { arrayElementType: "reference", ...pinned(version) }),
    ]
  );

describe("reference pin tag", () => {
  it("is written on a pinned reference (scalar and array) in the canonical source", () => {
    const source = generateTypeSpec(model("1.2"));
    expect(source).toContain('import "@typespec/openapi";');
    expect(source.match(/x-super-schema-pin", "1\.2"/g)).toHaveLength(2);
    expect(source).toContain(`${pinDecorator("1.2")}\n  buyer: Customer;`);
  });

  it("is not written for an unpinned reference, and never in the emission projection", () => {
    expect(generateTypeSpec(model())).not.toContain(PIN_EXTENSION_KEY);
    expect(generateTypeSpec(model("1.2"), { governance: false })).not.toContain(PIN_EXTENSION_KEY);
  });

  it("is read by the regex parser as referencedEntityVersion, not as a generic extension", () => {
    const parsed = parseTypeSpecDocument(generateTypeSpec(model("1.2")));
    const buyer = parsed.models[0].fields.find((f) => f.name === "buyer")!;
    expect(buyer.decorators.referencedEntityVersion).toBe("1.2");
    expect(buyer.decorators.extensions).toBeUndefined();
  });

  it("is read by the real compiler as referencedEntityVersion (and the source compiles)", async () => {
    const doc = await compileTypeSpecDocument(
      `import "@typespec/openapi";\nmodel Customer { id: string; }\nmodel Order {\n  ${pinDecorator("3.0")}\n  buyer: Customer;\n}\n`
    );
    const buyer = doc.models.find((m) => m.name === "Order")!.fields.find((f) => f.name === "buyer")!;
    expect(buyer.decorators.referencedEntityVersion).toBe("3.0");
    expect(buyer.decorators.extensions).toBeUndefined();
  });

  it("round-trips generate -> parse -> sync, and a removed tag drops the pin", () => {
    const m = model("1.2");
    const stored = (name: string): SyncExistingField => {
      const row = [fld("buyer", "reference", 0, pinned("1.2")), fld("buyers", "array", 1, { arrayElementType: "reference", ...pinned("1.2") })].find((f) => f.name === name)!;
      return { type: row.type, nullable: false, isKey: false, description: "", classification: null, decorators: row.decorators };
    };
    const parsed = parseTypeSpecDocument(generateTypeSpec(m));
    for (const name of ["buyer", "buyers"]) {
      const source = parsed.models[0].fields.find((f) => f.name === name)! as unknown as SyncSourceField;
      const merged = mergeSyncedField(stored(name), source);
      expect(merged.decorators.referencedEntityVersion).toBe("1.2");
      expect(merged.decorators.referencedEntityId).toBe("e-c");
      expect(merged.decorators.referencedQualifiedName).toBe("sales/orders/Customer");
      expect(merged.type).toBe(stored(name).type);
    }

    const without = parseTypeSpecDocument(generateTypeSpec(model()));
    const source = without.models[0].fields.find((f) => f.name === "buyer")! as unknown as SyncSourceField;
    expect(mergeSyncedField(stored("buyer"), source).decorators).not.toHaveProperty("referencedEntityVersion");
  });

  it("a hostile version string is escaped and read back verbatim", () => {
    const hostile = 'a"b\\c${x}';
    const parsed = parseTypeSpecDocument(`model M {\n  ${pinDecorator(hostile)}\n  r: Customer;\n}\n`);
    expect(parsed.models[0].fields[0].decorators.referencedEntityVersion).toBe(hostile);
  });
});
