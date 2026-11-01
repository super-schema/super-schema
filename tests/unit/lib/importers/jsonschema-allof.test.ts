import { describe, it, expect } from "vitest";
import { parseJsonSchemaDocument } from "@/lib/importers/jsonschema.importer";

function data(content: unknown) {
  const result = parseJsonSchemaDocument(JSON.stringify(content));
  if (!result.success) throw new Error("import failed");
  return result.data;
}

describe("JSON Schema importer: allOf merge semantics", () => {
  it("1. root allOf with an external $ref base becomes extends + inline fields + warning (Acme address)", () => {
    const d = data({
      title: "address",
      type: "object",
      allOf: [
        { $ref: "../../common_components/v5/schema/json/types/address_portable.json" },
        {
          type: "object",
          properties: {
            id: { type: "string", description: "The address ID." },
            tags: { type: "array", items: { type: "string" } },
          },
          required: ["id"],
        },
      ],
    });
    const entity = d.entities.find((e) => e.name === "address");
    expect(entity?.extends).toBe("address_portable");
    expect(entity?.fields.map((f) => f.name)).toEqual(["id", "tags"]);
    expect(entity?.fields.find((f) => f.name === "id")?.nullable).toBe(false);
    expect(d.warnings.some((w) => w.includes("base entity `address_portable` is referenced but not defined in this document"))).toBe(true);
  });

  it("1b. in-document base: extends the asset name, no warning, no duplicated base fields", () => {
    const d = data({
      title: "Root",
      type: "object",
      allOf: [{ $ref: "#/$defs/Base" }, { type: "object", properties: { id: { type: "string" } } }],
      $defs: { Base: { type: "object", properties: { created: { type: "string", format: "date-time" } } } },
    });
    const root = d.entities.find((e) => e.name === "Root");
    expect(root?.extends).toBe("Base");
    expect(root?.fields.map((f) => f.name)).toEqual(["id"]);
    expect(d.warnings.filter((w) => w.includes("not defined"))).toEqual([]);
  });

  it("2. property-level allOf [$ref, {description}] is a reference field carrying the description", () => {
    const d = data({
      title: "Thing",
      type: "object",
      properties: {
        status: { allOf: [{ $ref: "#/$defs/Status" }, { description: "the status", "x-note": 1 }] },
        own: { description: "own wins", allOf: [{ $ref: "#/$defs/Status" }, { description: "member" }] },
      },
      $defs: { Status: { type: "object", properties: { code: { type: "string" } } } },
    });
    const f = d.entities[0].fields.find((x) => x.name === "status");
    expect(f?.type).toBe("reference");
    expect(f?.referencedEntityName).toBe("Status");
    expect(f?.description).toBe("the status");
    expect(f?.extensions).toEqual({ "x-note": 1 });
    expect(d.entities[0].fields.find((x) => x.name === "own")?.description).toBe("own wins");
  });

  it("3. constraint-only members all apply", () => {
    const d = data({
      title: "T",
      type: "object",
      properties: { name: { allOf: [{ minLength: 1 }, { maxLength: 10 }] } },
    });
    const c = d.entities[0].fields[0].constraints ?? [];
    expect(c).toContainEqual({ type: "minLength", value: 1 });
    expect(c).toContainEqual({ type: "maxLength", value: 10 });
  });

  it("4. two $ref members: first is extends, second is warned about, inline fields still used", () => {
    const d = data({
      title: "Child",
      type: "object",
      allOf: [{ $ref: "#/$defs/A" }, { $ref: "#/$defs/B" }],
      $defs: {
        A: { type: "object", properties: { a: { type: "string" } } },
        B: { type: "object", properties: { b: { type: "string" } } },
      },
    });
    const child = d.entities.find((e) => e.name === "Child");
    expect(child?.extends).toBe("A");
    expect(child?.fields).toEqual([]);
    expect(d.warnings.some((w) => w.includes("allOf lists more than one base; only the first is used as `extends`; `B` is not merged"))).toBe(true);

    const d2 = data({
      title: "Child",
      type: "object",
      allOf: [{ $ref: "#/$defs/A" }, { $ref: "#/$defs/B" }, { properties: { own: { type: "string" } } }],
      $defs: { A: { type: "object", properties: { a: {} } }, B: { type: "object", properties: { b: {} } } },
    });
    expect(d2.entities.find((e) => e.name === "Child")?.fields.map((f) => f.name)).toEqual(["own"]);
  });

  it("5. allOf inside a $defs entry behaves like the root case", () => {
    const d = data({
      title: "Doc",
      type: "object",
      properties: { x: { type: "string" } },
      $defs: {
        Derived: {
          type: "object",
          allOf: [{ $ref: "#/$defs/Base" }, { type: "object", properties: { extra: { type: "integer" } } }],
        },
        Base: { type: "object", properties: { id: { type: "string" } } },
      },
    });
    const derived = d.entities.find((e) => e.name === "Derived");
    expect(derived?.extends).toBe("Base");
    expect(derived?.fields.map((f) => f.name)).toEqual(["extra"]);
  });

  it("6. conflicting constraining members keep the first member at low confidence", () => {
    const d = data({
      title: "T",
      type: "object",
      properties: { v: { allOf: [{ type: "string" }, { type: "number" }] } },
    });
    const f = d.entities[0].fields[0];
    expect(f.type).toBe("string");
    expect(f.confidence).toBe("low");
  });

  it("7. nested allOf flattens, and hostile depth is bounded", () => {
    const d = data({
      title: "T",
      type: "object",
      properties: { v: { allOf: [{ allOf: [{ type: "string" }, { maxLength: 5 }] }, { minLength: 2 }] } },
    });
    const f = d.entities[0].fields[0];
    expect(f.type).toBe("string");
    expect(f.constraints).toContainEqual({ type: "maxLength", value: 5 });
    expect(f.constraints).toContainEqual({ type: "minLength", value: 2 });

    // The hostile documents are built as TEXT, by repetition: building the 5000-level nest as an object and calling JSON.stringify on it
    // throws a RangeError on Node 20 (a smaller stack than Node 22 and later) BEFORE the importer is ever called, and the test then
    // failed for a reason that is not the importer's. JSON.parse reads these (its own recursion is iterative in V8), the importer bounds them.
    const nest = (depth: number, inner: string) => '{"allOf":['.repeat(depth) + inner + "]}".repeat(depth);
    const root = nest(5000, '{"type":"string"}');
    const raw = `{"title":"T","type":"object","properties":{"v":{"type":"string"}},"allOf":[${root}]}`;
    const rawProp = `{"title":"T","type":"object","properties":{"v":${nest(2000, '{"type":"string"}')}}}`;
    for (const [name, text] of [["5000 levels under the root", raw], ["2000 levels in a property", rawProp]] as const) {
      // Not "does not throw": it ANSWERS. Either the import succeeded (the bound truncated the nest) or it is a PARSE_ERROR that says the document is too deep.
      const result = parseJsonSchemaDocument(text);
      if (result.success) {
        expect(result.data.entities.length, name).toBeGreaterThan(0);
      } else {
        expect(result.error.code, name).toBe("PARSE_ERROR");
        expect(result.error.message.length, name).toBeGreaterThan(0);
      }
    }
    // And a document just under the bound is imported, not refused: the bound is not tighter than it says.
    const fine = parseJsonSchemaDocument(`{"title":"T","type":"object","properties":{"v":${nest(50, '{"type":"string"}')}}}`);
    expect(fine.success).toBe(true);
  });

  describe("inheritance cycles", () => {
    const ent = (ref?: string, props: Record<string, unknown> = { p: { type: "string" } }) => ({
      type: "object",
      ...(ref ? { allOf: [{ $ref: ref }, { type: "object", properties: props }] } : { properties: props }),
    });
    const cycleWarnings = (w: string[]) => w.filter((x) => x.includes("Inheritance cycle"));

    it("a. mutual A<->B: exactly one extends removed, fields kept", () => {
      const d = data({ title: "Doc", type: "object", properties: { x: {} }, $defs: { A: ent("#/$defs/B"), B: ent("#/$defs/A") } });
      const a = d.entities.find((e) => e.name === "A")!;
      const b = d.entities.find((e) => e.name === "B")!;
      expect(a.extends).toBe("B");
      expect(b.extends).toBeUndefined();
      expect(b.fields.map((f) => f.name)).toEqual(["p"]);
      expect(cycleWarnings(d.warnings)).toEqual(["Inheritance cycle A -> B -> A: `extends` removed from `B`."]);
    });

    it("b. 3-cycle A->B->C->A removes only the closing C", () => {
      const d = data({
        title: "Doc", type: "object", properties: { x: {} },
        $defs: { A: ent("#/$defs/B"), B: ent("#/$defs/C"), C: ent("#/$defs/A") },
      });
      const ext = Object.fromEntries(d.entities.map((e) => [e.name, e.extends]));
      expect(ext).toMatchObject({ A: "B", B: "C", C: undefined });
      expect(cycleWarnings(d.warnings)).toHaveLength(1);
      expect(cycleWarnings(d.warnings)[0]).toContain("removed from `C`");
    });

    it("c. root extending D where D allOfs # breaks at D", () => {
      const d = data({
        title: "Root", type: "object",
        allOf: [{ $ref: "#/$defs/D" }, { type: "object", properties: { r: { type: "string" } } }],
        $defs: { D: { type: "object", allOf: [{ $ref: "#" }] } },
      });
      expect(d.entities.find((e) => e.name === "Root")?.extends).toBe("D");
      expect(d.entities.find((e) => e.name === "D")?.extends).toBeUndefined();
      expect(cycleWarnings(d.warnings)).toHaveLength(1);
    });

    it("d. chains and diamonds are untouched and silent", () => {
      const d = data({
        title: "Doc", type: "object", properties: { x: {} },
        $defs: { C: ent(), B: ent("#/$defs/C"), A: ent("#/$defs/B"), A2: ent("#/$defs/B") },
      });
      const ext = Object.fromEntries(d.entities.map((e) => [e.name, e.extends]));
      expect(ext).toMatchObject({ A: "B", A2: "B", B: "C" });
      expect(cycleWarnings(d.warnings)).toEqual([]);
    });

    it("e. a direct self reference warns", () => {
      const d = data({ title: "Doc", type: "object", properties: { x: {} }, $defs: { S: ent("#/$defs/S") } });
      expect(d.entities.find((e) => e.name === "S")?.extends).toBeUndefined();
      expect(d.warnings.some((w) => w.includes('Entity "S"') && w.includes("itself"))).toBe(true);
    });
  });

  it("skips malformed members and keeps first on duplicate property names with a warning", () => {
    const d = data({
      title: "T",
      type: "object",
      allOf: [null, 3, [], { properties: { a: { type: "string" } } }, { properties: { a: { type: "integer" } } }],
    });
    expect(d.entities[0].fields).toHaveLength(1);
    expect(d.entities[0].fields[0].type).toBe("string");
    expect(d.warnings.some((w) => w.includes("`a`"))).toBe(true);
  });
});
