/**
 * An array of arrays read back from TypeSpec text. The TypeSpec tab saves the text the entity's own fields were written as; for
 * `matrix?: unknown[][]` the element of the outer array is the model `Array`, and it was stored as the element type "Array" (not the
 * logical type `array`), so every generation after a Save of ANY edit of that entity failed with
 * `invalid-template-args: Template argument 'Element' is required and not specified`. Found by the JSON Schema lifecycle matrix
 * (array-of-refs) once the multi-entity import no longer hid it behind an earlier failure. Real compiler.
 */
import { describe, it, expect, vi } from "vitest";

vi.setConfig({ testTimeout: 60_000 });
vi.mock("server-only", () => ({}));

const source = (...fields: string[]) => `model Order {\n  @key id: string;\n${fields.map((f) => `  ${f}\n`).join("")}}\n`;

describe("compileTypeSpecDocument: an array of arrays", () => {
  it("is an array whose element is the logical type `array`, as the importer stores it (never the model name `Array`)", async () => {
    const { compileTypeSpecDocument } = await import("@/lib/compiler/typespec-compiler");
    const doc = await compileTypeSpecDocument(source("matrix?: unknown[][];", "grid: int32[][];", "tags: string[];"));
    const fields = Object.fromEntries(doc.models[0].fields.map((f) => [f.name, f]));
    expect(fields.matrix).toMatchObject({ type: "array", arrayElementType: "array" });
    expect(fields.grid).toMatchObject({ type: "array", arrayElementType: "array" });
    // a plain array is unchanged
    expect(fields.tags).toMatchObject({ type: "array", arrayElementType: "string" });
  });
});
