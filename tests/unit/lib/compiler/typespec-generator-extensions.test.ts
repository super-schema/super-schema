/**
 * Generic vendor-extension passthrough: field `decorators.typespec.extensions.openapi` and model
 * `metadata.custom.extensions` are written as paired `@TypeSpec.JsonSchema.extension` /
 * `@TypeSpec.OpenAPI.extension` decorators, independent of the governance flag.
 */
import { describe, it, expect, vi, beforeAll } from "vitest";
import { compileEntity, type PrismaFieldInput } from "@/lib/compiler/compiler.service";
import { generateTypeSpec } from "@/lib/compiler/typespec-generator";
import { typeSpecValueLiteral } from "@/lib/compiler/governance-decorators";

vi.mock("server-only", () => ({}));

let compiler: typeof import("@/lib/compiler/typespec-compiler");
beforeAll(async () => {
  compiler = await import("@/lib/compiler/typespec-compiler");
});

const fld = (name: string, i: number, extra: Partial<PrismaFieldInput> = {}): PrismaFieldInput => ({
  id: `f-${name}`, name, type: "string", precision: null, scale: null, nullable: true, isKey: false,
  fieldNumber: null, description: "", classification: null, aliases: [], decorators: {}, sortOrder: i, ...extra,
});

function build(opts: {
  fieldExt?: Record<string, unknown>;
  modelExt?: Record<string, unknown>;
  tags?: string[];
}) {
  const model = compileEntity(
    {
      id: "e1", name: "Thing", description: "", status: "DRAFT", version: 1, domainId: null,
      metadata: { ...(opts.tags ? { tags: opts.tags } : {}), ...(opts.modelExt ? { custom: { extensions: opts.modelExt } } : {}) },
      domain: null,
    },
    [fld("id", 0, { isKey: true, nullable: false }), fld("name", 1)]
  );
  if (opts.fieldExt) {
    const f = model.fields.find((x) => x.name === "name")!;
    f.decorators.typespec = { ...(f.decorators.typespec ?? {}), extensions: { openapi: opts.fieldExt } };
  }
  return model;
}

const count = (s: string, needle: string) => s.split(needle).length - 1;

describe("typeSpecValueLiteral", () => {
  it("renders the literal grammar", () => {
    expect(typeSpecValueLiteral("a\"b")).toBe('"a\\"b"');
    expect(typeSpecValueLiteral(3)).toBe("3");
    expect(typeSpecValueLiteral(true)).toBe("true");
    expect(typeSpecValueLiteral(null)).toBe("null");
    expect(typeSpecValueLiteral(["a", 1, [false]])).toBe('#["a", 1, #[false]]');
    expect(typeSpecValueLiteral({ extent: "EXTERNAL", "has-dash": { n: 1 } })).toBe(
      '#{extent: "EXTERNAL", `has-dash`: #{n: 1}}'
    );
  });
});

describe("generic extension decorators", () => {
  it("emits the dual pair above a field and both imports once", () => {
    const src = generateTypeSpec(build({ fieldExt: { "x-visibility": { extent: "EXTERNAL" } } }));
    expect(src).toContain(
      '@TypeSpec.JsonSchema.extension("x-visibility", #{extent: "EXTERNAL"})\n  @TypeSpec.OpenAPI.extension("x-visibility", #{extent: "EXTERNAL"})\n  name?: string'
    );
    expect(count(src, 'import "@typespec/json-schema";')).toBe(1);
    expect(count(src, 'import "@typespec/openapi";')).toBe(1);
  });

  it("emits the pair above the model line", () => {
    const src = generateTypeSpec(build({ modelExt: { "x-owner": "team-a" } }));
    expect(src).toMatch(
      /@TypeSpec\.JsonSchema\.extension\("x-owner", "team-a"\)\n@TypeSpec\.OpenAPI\.extension\("x-owner", "team-a"\)\nmodel Thing/
    );
    expect(count(src, 'import "@typespec/json-schema";')).toBe(1);
  });

  it("does not duplicate the openapi import when tags are also present", () => {
    const src = generateTypeSpec(build({ tags: ["a"], modelExt: { "x-a": 1 } }));
    expect(count(src, 'import "@typespec/openapi";')).toBe(1);
  });

  it("skips x-tags / x-classification and adds no imports for them", () => {
    const src = generateTypeSpec(build({ modelExt: { "x-tags": ["a"], "x-classification": "PII" } }));
    expect(src).not.toContain("JsonSchema.extension");
    expect(src).not.toContain("@typespec/json-schema");
  });

  it("is independent of the governance flag", () => {
    const src = generateTypeSpec(build({ fieldExt: { "x-a": true } }), { governance: false });
    expect(src).toContain('@TypeSpec.JsonSchema.extension("x-a", true)');
    expect(src).toContain('import "@typespec/json-schema";');
  });

  it("emits nothing when there are no extensions", () => {
    const src = generateTypeSpec(build({}));
    expect(src).not.toContain("extension(");
    expect(src).not.toContain("@typespec/json-schema");
  });

  it("compiles with zero errors under the real compiler (object-valued, field + model)", async () => {
    const src = generateTypeSpec(
      build({
        fieldExt: { "x-visibility": { extent: "EXTERNAL", tags: ["a", "b"], "odd-key": 1.5, nothing: null } },
        modelExt: { "x-owner": { team: "a", ok: true } },
      })
    );
    const result = await compiler.compileTypeSpecWithGovernance(src);
    expect(result.diagnostics.filter((d) => d.severity === "error")).toEqual([]);
    expect(result.success).toBe(true);
  }, 60_000);
});
