/**
 * TypeSpec import decorator fidelity — via the real @typespec/compiler path.
 *
 * Verifies decorators flow: source → compileTypeSpecDocument → mapDocumentToImportResult
 * → ParsedField → buildDecoratorsFromParsedField (the stored decorators JSON).
 */
import { describe, it, expect, vi, beforeAll } from "vitest";

vi.mock("server-only", () => ({}));

let compileTypeSpecDocument: typeof import("@/lib/compiler/typespec-compiler").compileTypeSpecDocument;
import { mapDocumentToImportResult } from "@/lib/importers/typespec.importer";
import { buildDecoratorsFromParsedField } from "@/lib/importers/decorator-builder";
import type { ParsedField } from "@/lib/importers/types";

beforeAll(async () => {
  ({ compileTypeSpecDocument } = await import("@/lib/compiler/typespec-compiler"));
});

async function importModel(src: string) {
  const doc = await compileTypeSpecDocument(src);
  const result = mapDocumentToImportResult(doc, src);
  return result.models[0];
}

function field(fields: ParsedField[], name: string): ParsedField {
  const f = fields.find((x) => x.name === name);
  if (!f) throw new Error(`field ${name} not found`);
  return f;
}

describe("TypeSpec decorator fidelity (compiler path)", () => {
  it("maps @doc, @key, @format, constraints, @secret, @summary, @deprecated", async () => {
    const model = await importModel(`
      model UserProfile {
        @key @doc("Primary id") id: string;
        @format("email") email: string;
        @minLength(3) @maxLength(80) @pattern("^[a-z]+$") username: string;
        @minValue(0) @maxValue(120) age: int32;
        @secret token: string;
        @summary("Display name") name: string;
        #deprecated "use name"
        @deprecated legacyName?: string;
      }
    `);

    const f = (n: string) => field(model.fields, n);
    expect(f("id").isKey).toBe(true);
    expect(f("id").description).toBe("Primary id");
    expect(f("email").format).toBe("email");
    expect(f("username").constraints).toEqual(
      expect.arrayContaining([
        { type: "minLength", value: 3 },
        { type: "maxLength", value: 80 },
        { type: "pattern", value: "^[a-z]+$" },
      ])
    );
    expect(f("age").constraints).toEqual(
      expect.arrayContaining([
        { type: "minValue", value: 0 },
        { type: "maxValue", value: 120 },
      ])
    );
    expect(f("token").classification).toBe("SENSITIVE"); // @secret → SENSITIVE
    expect(f("name").summary).toBe("Display name");
  });

  it("maps @minValueExclusive / @maxValueExclusive and @encode", async () => {
    const model = await importModel(`
      model M {
        @minValueExclusive(0) @maxValueExclusive(100) ratio: float64;
        @encode("unixTimestamp", int32) ts: utcDateTime;
      }
    `);
    expect(field(model.fields, "ratio").minValueExclusive).toBe(0);
    expect(field(model.fields, "ratio").maxValueExclusive).toBe(100);
    expect(field(model.fields, "ts").encode).toBe("unixTimestamp");
  });

  it("maps @tag(\"classification:PII\") → classification PII", async () => {
    const model = await importModel(`
      model M { @tag("classification:PII") ssn: string; }
    `);
    expect(field(model.fields, "ssn").classification).toBe("PII");
  });

  it("maps @visibility and @extension (no std getter in 1.10 — read from AST)", async () => {
    const model = await importModel(`
      using TypeSpec;
      model M {
        @visibility(Lifecycle.Read, Lifecycle.Create) a: string;
        @extension("x-custom", "val") b: string;
      }
    `);
    expect(field(model.fields, "a").visibility).toEqual(["Read", "Create"]);
    expect(field(model.fields, "b").extensions).toEqual({ "x-custom": "val" });

    const aDecos = buildDecoratorsFromParsedField(field(model.fields, "a"));
    expect(aDecos).toMatchObject({ typespec: { visibility: { phases: ["Read", "Create"] } } });
    const bDecos = buildDecoratorsFromParsedField(field(model.fields, "b"));
    expect(bDecos).toMatchObject({ typespec: { extensions: { openapi: { "x-custom": "val" } } } });
  });

  it("flows decorators into the stored decorators JSON", async () => {
    const model = await importModel(`
      model M {
        @format("email") @minLength(5) email: string;
        @secret token: string;
      }
    `);
    const emailDecos = buildDecoratorsFromParsedField(field(model.fields, "email"));
    expect(emailDecos).toMatchObject({
      typespec: {
        identity: { format: "email" },
        validation: { minLength: 5 },
      },
    });
    const tokenDecos = buildDecoratorsFromParsedField(field(model.fields, "token"));
    expect(tokenDecos).toMatchObject({ classification: { level: "SENSITIVE" } });
  });
});
