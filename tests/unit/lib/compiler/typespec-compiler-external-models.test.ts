/**
 * `compileTypeSpecWithGovernance(source, { externalModels })`: a field typed with a name the source does not declare compiles when the
 * caller says the name is an entity of the tenant. The stand-in models live in a separate file of a second, validation-only compile.
 * Real compiler.
 */
import { describe, it, expect, vi, beforeAll } from "vitest";

vi.setConfig({ testTimeout: 60_000 });
vi.mock("server-only", () => ({}));

let compileTypeSpecWithGovernance: typeof import("@/lib/compiler/typespec-compiler").compileTypeSpecWithGovernance;
let isInStandInFile: typeof import("@/lib/compiler/typespec-compiler").isInStandInFile;

beforeAll(async () => {
  ({ compileTypeSpecWithGovernance, isInStandInFile } = await import("@/lib/compiler/typespec-compiler"));
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
      { model: "Customer", field: "id", written: "string", shape: "direct" },
      { model: "Customer", field: "tags", written: "string", shape: "array" },
      { model: "Customer", field: "owner", written: "Customer", shape: "direct" },
    ]);
  });
});

describe("externalModels", () => {
  it("is asked once, about the names the fields of EVERY model of the source could not find, as written, each once; the model is named in the list", async () => {
    const ask = accepting();
    const source = [
      "model Local { x: string; }",
      "model Customer {",
      "  @key id: string;",
      "  a: Address;",
      "  b: Billing.Payments.Address[];",
      "  c: Local;",
      "  d: Record<Pair>;",
      "  e: Mixed | string;",
      "  f: Address;",
      "}",
      "model Other {",
      "  z: Zip;",
      "}",
    ].join("\n");
    const res = await compileTypeSpecWithGovernance(source, { externalModels: ask });

    // The shapes of a field's type: Name, Name[], Record<Name>, a member of the field's own union. `Local` is declared, so it names nothing
    // unknown. A helper model (`Other`) is asked about too: the caller decides which model is the entity's, and links only that one's names.
    expect(res.success).toBe(false);
    expect(ask).toHaveBeenCalledTimes(1);
    expect(ask.mock.calls[0][0].sort()).toEqual(["Address", "Billing.Payments.Address", "Mixed", "Pair", "Zip"]);
    // `Mixed` is only ever a union member (not stored as a reference); the others are references
    expect([...((ask.mock.calls[0] as unknown[])[1] as ReadonlySet<string>)]).toEqual(["Mixed"]);
  });

  it("every shape is read from the syntax tree: the field type names list says how each name is held", async () => {
    const res = await compileTypeSpecWithGovernance(model("a: Address;", "b: Address[];", "c: Record<Address>;", "d: Card | Bank;", "e: string[];"), {
      externalModels: accepting("Address", "Card", "Bank"),
    });

    expect(res.success).toBe(true);
    if (!res.success) return;
    expect(res.fieldTypeNames).toEqual([
      { model: "Customer", field: "id", written: "string", shape: "direct" },
      { model: "Customer", field: "a", written: "Address", shape: "direct" },
      { model: "Customer", field: "b", written: "Address", shape: "array" },
      { model: "Customer", field: "c", written: "Address", shape: "map" },
      { model: "Customer", field: "d", written: "Card", shape: "union" },
      { model: "Customer", field: "d", written: "Bank", shape: "union" },
      { model: "Customer", field: "e", written: "string", shape: "array" },
    ]);
    expect(res.document.models.map((m) => m.name)).toEqual(["Customer"]);
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
      { model: "Customer", field: "id", written: "string", shape: "direct" },
      { model: "Customer", field: "a", written: "Address", shape: "direct" },
      { model: "Customer", field: "b", written: "Billing.Payments.Address", shape: "array" },
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

  it("a Record<Name>, and the members of a field's own union, get a stand-in too; the stand-ins are not in the document", async () => {
    const res = await compileTypeSpecWithGovernance(model("byKey: Record<Address>;", "payment: Card | Bank;", "qualified: Record<Billing.Payments.Address>;"), {
      externalModels: accepting("Address", "Card", "Bank", "Billing.Payments.Address"),
    });

    expect(res.success).toBe(true);
    if (!res.success) return;
    expect(res.diagnostics.filter((d) => d.severity === "error")).toEqual([]);
    expect(res.document.models.map((m) => m.name)).toEqual(["Customer"]);
    expect(res.document.models[0].fields.map((f) => [f.name, f.type])).toEqual([
      ["id", "string"],
      ["byKey", "map"],
      ["payment", "Card | Bank"],
      ["qualified", "map"],
    ]);
    expect(res.diagnostics.filter((d) => /Address|Card|Bank/.test(d.message))).toEqual([]);
  });

  it("a name the caller does not accept stays the compiler's error; the accepted ones no longer are", async () => {
    const res = await compileTypeSpecWithGovernance(model("a: Address;", "b: Nowhere;"), { externalModels: accepting("Address") });

    expect(res).toMatchObject({ success: false, diagnostics: [{ code: "invalid-ref", message: "Unknown identifier Nowhere" }] });
    if (!res.success) expect(res.diagnostics).toHaveLength(1);
  });

  it("is not asked when the source compiles, and not for a name that is only used outside the type of a field", async () => {
    const compiles = accepting("Address");
    expect((await compileTypeSpecWithGovernance(model("a: string;"), { externalModels: compiles })).success).toBe(true);
    expect(compiles).not.toHaveBeenCalled();

    for (const text of [
      "model Customer extends Address {\n  @key id: string;\n}\n",
      "model Customer {\n  @key id: string;\n  ...Address;\n}\n",
      `${model("a: string;")}alias Other = Address;\n`,
      `${model("a: string;")}union Payment {\n  Address,\n  string,\n}\n`,
      `${model("a: string;")}model Wrapper<T> {\n  v: T;\n}\nmodel Holder {\n  w: Wrapper<Address>;\n}\n`,
      model("a: Record<Address[]>;"),
      model("a: Record<Address | string>;"),
      model("a: (Address | string)[];"),
    ]) {
      const ask = accepting("Address");
      const res = await compileTypeSpecWithGovernance(text, { externalModels: ask });
      expect(res.success, text).toBe(false);
      expect(ask.mock.calls.flatMap((c) => c[0]), text).toEqual([]);
    }
  });

  it("a name that is ALSO used somewhere that is not part of the type of a field is not given a stand-in: every use stays an error", async () => {
    const names = accepting("Address", "Billing.Payments.Address", "Card");
    for (const text of [
      "model Customer {\n  @key id: string;\n  ...Address;\n  a: Address;\n}\n",
      "model Customer extends Address {\n  @key id: string;\n  a: Address;\n}\n",
      "model Customer {\n  @key id: string;\n  a: Address;\n  r: Record<Address[]>;\n}\n",
      `${model("a: Address;", "m: Record<Address>;")}alias Other = Address;\n`,
      `${model("a: Billing.Payments.Address;")}alias Other = Billing.Payments.Address;\n`,
      `${model("p: Card | Bank;")}union Payment {\n  Card,\n  string,\n}\n`,
      `${model("p: Card | string;")}model Wrapper<T> {\n  v: T;\n}\nmodel Holder {\n  w: Wrapper<Card>;\n}\n`,
    ]) {
      const res = await compileTypeSpecWithGovernance(text, { externalModels: names });
      expect(res.success, text).toBe(false);
      expect(res.diagnostics.some((d) => d.code === "invalid-ref"), text).toBe(true);
    }
  });

  it("the stand-in file is recognised by its FULL path, never by its name: a stubs.tsp somewhere else is not filtered", () => {
    const mine = "/work/job-1/stubs.tsp";
    const at = (path: string) => ({ target: { file: { path, text: "" }, pos: 0, end: 0 } }) as unknown as Parameters<typeof isInStandInFile>[0];

    expect(isInStandInFile(at(mine), new Set([mine]))).toBe(true);
    expect(isInStandInFile(at("/work/job-2/stubs.tsp"), new Set([mine]))).toBe(false);
    expect(isInStandInFile(at("/node_modules/@typespec/some-lib/lib/stubs.tsp"), new Set([mine]))).toBe(false);
    expect(isInStandInFile(at("/work/job-1/main.tsp"), new Set([mine]))).toBe(false);
    // a diagnostic with no usable target is never taken for the stand-in's
    expect(isInStandInFile({ target: undefined } as unknown as Parameters<typeof isInStandInFile>[0], new Set([mine]))).toBe(false);
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
