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
