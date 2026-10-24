/**
 * `compileTypeSpecWithGovernance(source, { externalModels })`: a field typed with a name the source does not declare compiles when the
 * caller says the name is an entity of the tenant. The stand-in models live in a separate file of a second, validation-only compile.
 * Real compiler.
 */
import { describe, it, expect, vi, beforeAll } from "vitest";

vi.setConfig({ testTimeout: 60_000 });
vi.mock("server-only", () => ({}));

let compileTypeSpecWithGovernance: typeof import("@/lib/compiler/typespec-compiler").compileTypeSpecWithGovernance;

beforeAll(async () => {
  ({ compileTypeSpecWithGovernance } = await import("@/lib/compiler/typespec-compiler"));
});

const model = (...fields: string[]) => `model Customer {\n  @key id: string;\n${fields.map((f) => `  ${f}\n`).join("")}}\n`;
const accepting = (...names: string[]) => vi.fn(async (written: string[]) => new Set(written.filter((w) => names.includes(w))));

describe("without the option nothing changes", () => {
  it("an undeclared name is the compiler's own invalid-ref error, and a source that compiles lists its field types and no stand-ins", async () => {
    const bad = await compileTypeSpecWithGovernance(model("address: Address;"));
    expect(bad).toMatchObject({ success: false, diagnostics: [{ code: "invalid-ref", message: "Unknown identifier Address" }] });

    const good = await compileTypeSpecWithGovernance(model("tags: string[];", "owner: Customer;"));
    expect(good.success).toBe(true);
    if (!good.success) return;
    expect(good.externalModels.size).toBe(0);
    expect(good.fieldTypeNames).toEqual([
      { field: "id", written: "string", element: false },
      { field: "tags", written: "string", element: true },
      { field: "owner", written: "Customer", element: false },
    ]);
  });
});

describe("externalModels", () => {
  it("is asked once, about the names of the FIRST model's fields the compiler could not find, as written (bare, qualified, an array's element), each once", async () => {
    const ask = accepting();
    const source = [
      "model Local { x: string; }",
      "model Customer {",
      "  @key id: string;",
      "  a: Address;",
      "  b: Billing.Payments.Address[];",
      "  c: Local;",
      "  d: Record<Nowhere>;",
      "  e: Address | string;",
      "  f: Address;",
      "}",
      "model Other {",
      "  z: Zip;",
      "}",
    ].join("\n");
    // The model the document lists first is the entity's, whatever it is called: here `Local`, which names nothing unknown.
    await compileTypeSpecWithGovernance(source, { externalModels: ask });
    expect(ask).not.toHaveBeenCalled();

    const entityFirst = ["model Customer {", "  @key id: string;", "  a: Address;", "  b: Billing.Payments.Address[];", "  c: Record<Nowhere>;", "  d: Mixed | string;", "  e: Address;", "}", "model Other {", "  z: Zip;", "}"].join("\n");
    const res = await compileTypeSpecWithGovernance(entityFirst, { externalModels: ask });

    // `Record<Nowhere>`, `Mixed | string` (not plain names) and `Zip` (not a field of the first model) are never offered.
    expect(res.success).toBe(false);
    expect(ask).toHaveBeenCalledTimes(1);
    expect(ask.mock.calls[0][0].sort()).toEqual(["Address", "Billing.Payments.Address"]);
  });

  it("accepted names compile, and are returned with the field type names; the stand-ins are not part of the document", async () => {
    const res = await compileTypeSpecWithGovernance(model("a: Address;", "b: Billing.Payments.Address[];"), {
      externalModels: accepting("Address", "Billing.Payments.Address"),
    });

    expect(res.success).toBe(true);
    if (!res.success) return;
    expect(res.diagnostics.filter((d) => d.severity === "error")).toEqual([]);
    expect([...res.externalModels].sort()).toEqual(["Address", "Billing.Payments.Address"]);
    expect(res.fieldTypeNames).toEqual([
      { field: "id", written: "string", element: false },
      { field: "a", written: "Address", element: false },
      { field: "b", written: "Billing.Payments.Address", element: true },
    ]);
    expect(res.document.models.map((m) => m.name)).toEqual(["Customer"]);
    expect(res.document.models[0].fields.map((f) => [f.name, f.type, f.arrayElementType])).toEqual([
      ["id", "string", undefined],
      ["a", "Address", undefined],
      ["b", "array", "Address"],
    ]);
    // A lint on the stand-in (an empty model needs no classification) is not about the source.
    expect(res.diagnostics.filter((d) => /Address/.test(d.message))).toEqual([]);
  });

  it("a name the caller does not accept stays the compiler's error; the accepted ones no longer are", async () => {
    const res = await compileTypeSpecWithGovernance(model("a: Address;", "b: Nowhere;"), { externalModels: accepting("Address") });

    expect(res).toMatchObject({ success: false, diagnostics: [{ code: "invalid-ref", message: "Unknown identifier Nowhere" }] });
    if (!res.success) expect(res.diagnostics).toHaveLength(1);
  });

  it("is not asked when the source compiles, and not for a name in another position (extends, spread, a map value)", async () => {
    const compiles = accepting("Address");
    expect((await compileTypeSpecWithGovernance(model("a: string;"), { externalModels: compiles })).success).toBe(true);
    expect(compiles).not.toHaveBeenCalled();

    for (const text of [
      "model Customer extends Address {\n  @key id: string;\n}\n",
      "model Customer {\n  @key id: string;\n  ...Address;\n}\n",
      model("m: Record<Address>;"),
    ]) {
      const ask = accepting("Address");
      const res = await compileTypeSpecWithGovernance(text, { externalModels: ask });
      expect(res.success, text).toBe(false);
      expect(ask.mock.calls.flatMap((c) => c[0]), text).toEqual([]);
    }
  });

  it("a name that is ALSO used somewhere that is not the type of a field (a spread, extends, a map value) is not given a stand-in: that use stays an error", async () => {
    for (const text of [
      "model Customer {\n  @key id: string;\n  ...Address;\n  a: Address;\n}\n",
      "model Customer {\n  @key id: string;\n  a: Address;\n  m: Record<Address>;\n}\n",
      "model Customer {\n  @key id: string;\n  a: Billing.Payments.Address;\n  m: Record<Billing.Payments.Address>;\n}\n",
    ]) {
      const res = await compileTypeSpecWithGovernance(text, { externalModels: accepting("Address", "Billing.Payments.Address") });
      expect(res.success, text).toBe(false);
      expect(res.diagnostics.some((d) => d.code === "invalid-ref"), text).toBe(true);
    }
  });

  it("works in a source with a file-level namespace, a using and a library import", async () => {
    const source = 'import "@typespec/openapi";\nusing TypeSpec.OpenAPI;\n\nnamespace Sales;\n\nmodel Customer {\n  @key id: string;\n  a: Address;\n}\n';

    const res = await compileTypeSpecWithGovernance(source, { externalModels: accepting("Address") });

    expect(res.success).toBe(true);
    if (res.success) expect(res.document.models.map((m) => m.name)).toEqual(["Customer"]);
  });

  it("another blocking error in the source is reported as it is, whatever the stand-ins accepted", async () => {
    const res = await compileTypeSpecWithGovernance(model("a: Address;", "@minLength(2) n: int32;"), { externalModels: accepting("Address") });

    expect(res.success).toBe(false);
    expect(res.diagnostics.some((d) => d.code === "decorator-wrong-target")).toBe(true);
    expect(res.diagnostics.some((d) => /Address/.test(d.message))).toBe(false);
  });

  it("the positions of the diagnostics are the same as without the stand-in import line", async () => {
    const source = model("a: Address;", "@minLength(2) n: int32;");
    const withoutStandIns = await compileTypeSpecWithGovernance(model("@minLength(2) n: int32;"));
    const withStandIns = await compileTypeSpecWithGovernance(source, { externalModels: accepting("Address") });

    const wrongTarget = (r: Awaited<ReturnType<typeof compileTypeSpecWithGovernance>>) => r.diagnostics.find((d) => d.code === "decorator-wrong-target");
    // `a: Address;` (17 characters + a newline + the indent) sits between the two sources: the offset moves by exactly that, not by the import line.
    const shift = source.indexOf("@minLength") - model("@minLength(2) n: int32;").indexOf("@minLength");
    const base = Number((wrongTarget(withoutStandIns)?.target ?? "").replace("line ", ""));
    expect(Number((wrongTarget(withStandIns)?.target ?? "").replace("line ", ""))).toBe(base + shift);
  });

  it("a hostile name cannot overflow the reader: a very long member chain is simply not a name", async () => {
    const chain = Array.from({ length: 5000 }, () => "a").join(".");
    const ask = accepting();

    const res = await compileTypeSpecWithGovernance(model(`x: ${chain};`), { externalModels: ask });

    expect(res.success).toBe(false);
    expect(ask.mock.calls.flatMap((c) => c[0])).toEqual([]);
  });
});
