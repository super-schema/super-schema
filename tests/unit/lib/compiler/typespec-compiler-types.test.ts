/**
 * What the real compiler's import reads of a type: a declared scalar is its base, `void` and `never` are not `string`, and a text the compiler
 * refuses has no document (its errors are thrown instead). Real @typespec/compiler compiles, as in the sibling extraction tests.
 */
import { describe, it, expect, vi, beforeAll } from "vitest";
vi.setConfig({ testTimeout: 60_000 });

vi.mock("server-only", () => ({}));

let compileTypeSpecDocument: typeof import("@/lib/compiler/typespec-compiler").compileTypeSpecDocument;
let TypeSpecCompileError: typeof import("@/lib/compiler/typespec-compiler").TypeSpecCompileError;

beforeAll(async () => {
  ({ compileTypeSpecDocument, TypeSpecCompileError } = await import("@/lib/compiler/typespec-compiler"));
});

describe("a declared scalar is the logical type it stands for", () => {
  it("a scalar that extends a standard scalar reads as that scalar", async () => {
    const doc = await compileTypeSpecDocument(`
      scalar Price extends decimal;
      model Order { total: Price; }
    `);
    expect(doc.models[0].fields[0]).toMatchObject({ name: "total", type: "decimal" });
  });

  it("a chain of declared scalars reads as the first standard scalar at its foot, and an array of one as the element", async () => {
    const doc = await compileTypeSpecDocument(`
      scalar Price extends decimal;
      scalar Money extends Price;
      model Order { total: Money; amounts: Money[]; }
    `);
    expect(doc.models[0].fields).toMatchObject([
      { name: "total", type: "decimal" },
      { name: "amounts", type: "array", arrayElementType: "decimal" },
    ]);
  });
});

describe("`void` and `never` have no type of their own", () => {
  it("an operation that returns void reads its return type as void, not as string", async () => {
    const doc = await compileTypeSpecDocument(`
      model Pet { id: string; }
      op ping(): void;
    `);
    expect(doc.operations[0]).toMatchObject({ name: "ping", returnType: "void" });
  });

  it("a property typed never holds no value: it is no field of the model", async () => {
    const doc = await compileTypeSpecDocument(`
      model Order { id: string; retired: never; }
    `);
    expect(doc.models[0].fields.map((f) => f.name)).toEqual(["id"]);
  });
});

describe("a text the compiler refuses has no document to import", () => {
  it("an unresolved type name throws the compiler's errors, and yields no document", async () => {
    const error = await compileTypeSpecDocument(`model Order { total: Moneyy; }`).then(
      () => undefined,
      (e: unknown) => e,
    );
    expect(error).toBeInstanceOf(TypeSpecCompileError);
    const diagnostics = (error as InstanceType<typeof TypeSpecCompileError>).diagnostics;
    expect(diagnostics).toEqual([expect.objectContaining({ severity: "error", code: "invalid-ref", message: "Unknown identifier Moneyy" })]);
    expect((error as Error).message).toBe("The TypeSpec does not compile: Unknown identifier Moneyy");
  });
});
