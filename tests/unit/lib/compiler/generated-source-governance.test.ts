/**
 * Story 16.6 — the canonical TypeSpec the generator emits for a tagged entity with classified fields
 * compiles with zero errors under the real @typespec/compiler (+ the governance package), and every
 * reader gets classification and tags back: the governance accessors, the real-compiler AST reader
 * (paste-import) and the regex parser. The legacy `@tag(...)` form stays readable.
 */
import { describe, it, expect, vi, beforeAll } from "vitest";
import { compileEntity, type PrismaFieldInput } from "@/lib/compiler/compiler.service";
import { generateTypeSpec } from "@/lib/compiler/typespec-generator";
import { parseTypeSpecDocument } from "@/lib/compiler/typespec-parser";
import { mapDocumentToImportResult, parseTypeSpecSchema } from "@/lib/importers/typespec.importer";

vi.mock("server-only", () => ({}));

let compiler: typeof import("@/lib/compiler/typespec-compiler");
beforeAll(async () => {
  compiler = await import("@/lib/compiler/typespec-compiler");
});

const fld = (name: string, classification: string | null, i: number, extra: Partial<PrismaFieldInput> = {}): PrismaFieldInput => ({
  id: `f-${name}`, name, type: "string", precision: null, scale: null, nullable: true, isKey: false,
  fieldNumber: null, description: "", classification, aliases: [], decorators: {}, sortOrder: i, ...extra,
});

const FIELDS = [
  fld("id", null, 0, { isKey: true, nullable: false }),
  fld("email", "PII", 1),
  fld("note", "SENSITIVE", 2),
  fld("ssnHash", "NEVER_STORED", 3),
  fld("region", "INTERNAL", 4),
  fld("code", "TOP_SECRET", 5),
];
const EXPECTED: Record<string, string | undefined> = {
  id: undefined, email: "PII", note: "SENSITIVE", ssnHash: "NEVER_STORED", region: "INTERNAL", code: "TOP_SECRET",
};

function canonical(opts: { namespace?: string } = {}) {
  const model = compileEntity(
    {
      id: "e1", name: "Customer", description: "Customers", status: "DRAFT", version: 1, domainId: null,
      metadata: { tags: ["sales", "core"] }, domain: null,
    },
    FIELDS
  );
  if (opts.namespace) model.namespace = opts.namespace;
  return generateTypeSpec(model);
}

describe("canonical source with tags + classified fields (Story 16.6)", () => {
  it("contains no @tag at all", () => {
    expect(canonical()).not.toContain("@tag(");
  });

  it.each([{}, { namespace: "Sales.Crm" }])(
    "compiles with ZERO errors under the real compiler + governance ruleset (%o)",
    async (opts) => {
      const result = await compiler.compileTypeSpecWithGovernance(canonical(opts));
      const errors = result.diagnostics.filter((d) => d.severity === "error");
      expect(errors).toEqual([]);
      expect(result.success).toBe(true);
    },
    60_000
  );

  it("governance accessors read the Enterprise decorator back as the app's level", async () => {
    const result = await compiler.compileTypeSpecWithGovernance(canonical());
    expect(result.success).toBe(true);
    if (!result.success) return;
    expect(result.fieldGovernance["Customer.email"]?.classification).toBe("PII");
    expect(result.fieldGovernance["Customer.note"]?.classification).toBe("SENSITIVE");
    expect(result.fieldGovernance["Customer.ssnHash"]?.classification).toBe("NEVER_STORED");
    expect(result.fieldGovernance["Customer.region"]?.classification).toBe("INTERNAL");
    // An admin-defined level has no enum member: it travels as x-classification, read by the AST reader.
    expect(result.fieldGovernance["Customer.code"]?.classification).toBeUndefined();
    const code = result.document.models[0].fields.find((f) => f.name === "code")!;
    expect(code.decorators.classification).toBe("TOP_SECRET");
    expect(code.decorators.extensions?.["x-classification"]).toBeUndefined();
    expect(result.document.models[0].tags).toEqual(["sales", "core"]);
  }, 60_000);

  it("paste-import (real-compiler AST reader → importer) gets classification and tags back", async () => {
    const source = canonical();
    const imported = mapDocumentToImportResult(await compiler.compileTypeSpecDocument(source), source);
    const model = imported.models[0];
    expect(model.tags).toEqual(["sales", "core"]);
    for (const f of model.fields) {
      expect([f.name, f.classification]).toEqual([f.name, EXPECTED[f.name]]);
      expect(f.extensions?.["x-classification"]).toBeUndefined();
    }
  }, 60_000);

  it("the regex parser (live-typing / single-entity import) gets classification and tags back", () => {
    const source = canonical();
    const doc = parseTypeSpecDocument(source);
    expect(doc.models[0].tags).toEqual(["sales", "core"]);
    const parsed = parseTypeSpecSchema(source);
    expect(parsed.success).toBe(true);
    if (!parsed.success) return;
    for (const f of parsed.data.fields) {
      expect([f.name, f.classification]).toEqual([f.name, EXPECTED[f.name]]);
    }
  });
});

describe("a document that declares or references the name `Enterprise` (R53)", () => {
  // The governance library declares `namespace Enterprise`. A same-named model at global scope is a
  // duplicate-symbol; inside a namespace `Enterprise.dataClassification` resolves to the model. So every
  // classified field falls back to the lossless x-classification and the library is not imported.
  const enterpriseEntity = (namespace?: string, extra: PrismaFieldInput[] = []) => {
    const model = compileEntity(
      {
        id: "e2", name: "Enterprise", description: "", status: "DRAFT", version: 1, domainId: null,
        metadata: null, domain: null,
      },
      [fld("id", null, 0, { isKey: true, nullable: false }), fld("email", "PII", 1), ...extra]
    );
    if (namespace) model.namespace = namespace;
    return generateTypeSpec(model);
  };

  it("emits x-classification for every classified field and no enterprise import", () => {
    const source = enterpriseEntity();
    expect(source).not.toContain("typespec-enterprise");
    expect(source).not.toContain("@Enterprise.");
    expect(source).toContain('@TypeSpec.OpenAPI.extension("x-classification", "PII")\n  email?: string;');
  });

  it.each([undefined, "Sales.Crm"])(
    "compiles with zero errors (namespace %s) and imports back with the right classification",
    async (namespace) => {
      const source = enterpriseEntity(namespace);
      const result = await compiler.compileTypeSpecWithGovernance(source);
      expect(result.diagnostics.filter((d) => d.severity === "error")).toEqual([]);
      expect(result.success).toBe(true);

      const imported = mapDocumentToImportResult(await compiler.compileTypeSpecDocument(source), source);
      const model = imported.models.find((m) => m.name === "Enterprise")!;
      expect(model.fields.find((f) => f.name === "email")?.classification).toBe("PII");
    },
    60_000
  );

  it("falls back for a referenced name too: a closure whose member is called Enterprise compiles (the publish gate's real closure)", async () => {
    const orderFields = [
      fld("email", "PII", 0),
      fld("owner", null, 1, { type: "reference", decorators: { referencedEntityId: "e2", referencedEntityName: "Enterprise" } }),
    ];
    const entity = (id: string, name: string) => ({
      id, name, description: "", status: "DRAFT", version: 1, domainId: null, metadata: null, domain: null,
    });
    const model = compileEntity(entity("e3", "Order"), orderFields);
    model.namespace = "Sales";
    expect(generateTypeSpec(model)).not.toContain("@Enterprise.");

    const { generateClosureTypeSpec } = await import("@/lib/compiler/closure-source");
    const member = (id: string, name: string, fields: PrismaFieldInput[], source: "draft" | "published") => ({
      entityId: id,
      ref: { entityId: id, domain: "Sales", product: "Orders", entity: name },
      source,
      ...(source === "published" ? { version: "1.0" } : {}),
      fields,
      entity: entity(id, name),
    });
    const closure = {
      entities: [
        member("e3", "Order", orderFields, "draft"),
        member("e2", "Enterprise", [fld("id", null, 0, { isKey: true, nullable: false })], "published"),
      ],
    };
    const gated = generateClosureTypeSpec(closure, { target: "publish-gate", governance: true }).source;
    expect(gated).not.toContain("@Enterprise.");
    const result = await compiler.compileTypeSpecWithGovernance(gated);
    expect(result.diagnostics.filter((d) => d.severity === "error")).toEqual([]);
  }, 60_000);

  it("falls back for a shared enum named Enterprise and for an `Enterprise` namespace segment", () => {
    const base = compileEntity(
      { id: "e4", name: "Order", description: "", status: "DRAFT", version: 1, domainId: null, metadata: null, domain: null },
      [fld("email", "PII", 0)]
    );
    expect(generateTypeSpec({ ...base, sharedEnums: [{ name: "Enterprise", values: ["A"] }] })).not.toContain("@Enterprise.");
    expect(generateTypeSpec({ ...base, namespace: "Acme.Enterprise" })).not.toContain("@Enterprise.");
    // Unaffected: a name that merely contains it.
    expect(generateTypeSpec({ ...base, sharedEnums: [{ name: "EnterpriseTier", values: ["A"] }] })).toContain("@Enterprise.");
  });
});

describe("legacy @tag sources stay readable (stored before Story 16.6)", () => {
  const LEGACY = [
    '@doc("Orders")',
    '@tag("sales")',
    '@tag("pii")',
    "model Order {",
    "  @key",
    "  id: string;",
    '  @tag("classification:PII")',
    "  email?: string;",
    "}",
    "",
  ].join("\n");

  it("real-compiler AST reader → importer", async () => {
    const imported = mapDocumentToImportResult(await compiler.compileTypeSpecDocument(LEGACY), LEGACY);
    expect(imported.models[0].tags).toEqual(["sales", "pii"]);
    expect(imported.models[0].fields.find((f) => f.name === "email")?.classification).toBe("PII");
  }, 60_000);

  it("regex parser → importer", () => {
    const parsed = parseTypeSpecSchema(LEGACY);
    expect(parsed.success && parsed.data.fields.find((f) => f.name === "email")?.classification).toBe("PII");
    expect(parseTypeSpecDocument(LEGACY).models[0].tags).toEqual(["sales", "pii"]);
  });
});
