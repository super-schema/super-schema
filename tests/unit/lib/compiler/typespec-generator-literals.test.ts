/**
 * A stored default and a documentation example are written as TypeSpec literals of the field's own type, so the generated text compiles.
 * A text default on a numeric field is coerced when that is lossless and withheld (with a warning) when it is not; an enum default names a
 * member of the enum; a text example is a quoted string and an object example a `#{...}` value. Every case is compiled by the REAL
 * TypeSpec compiler (the publish gate's entry point).
 */
import { describe, it, expect, vi, beforeAll } from "vitest";
import { compileEntity } from "@/lib/compiler/compiler.service";
import type { PrismaEntityInput, PrismaFieldInput } from "@/lib/compiler/compiler.service";
import { generateTypeSpecWithDiagnostics, type GeneratorDiagnostic } from "@/lib/compiler/typespec-generator";
import { generateClosureTypeSpec } from "@/lib/compiler/closure-source";
import type { ClosureEntity } from "@/lib/references/closure";
import type { SuperSchemaModel } from "@/types/super-schema-model";
import { compareSourceLiterals, projectSourceFields } from "@/lib/entity-versioning/source-projection";

vi.mock("server-only", () => ({}));

let compileTypeSpecWithGovernance: typeof import("@/lib/compiler/typespec-compiler").compileTypeSpecWithGovernance;

beforeAll(async () => {
  ({ compileTypeSpecWithGovernance } = await import("@/lib/compiler/typespec-compiler"));
});

const entity = (overrides: Partial<PrismaEntityInput> = {}): PrismaEntityInput => ({
  id: "e1",
  name: "Ticket",
  description: "",
  status: "DRAFT",
  version: 1,
  domainId: "d1",
  metadata: {},
  domain: { id: "d1", name: "Sales", slug: "sales" },
  ...overrides,
});

let seq = 0;
const field = (overrides: Partial<PrismaFieldInput>): PrismaFieldInput => ({
  id: `f${seq++}`,
  name: "x",
  type: "string",
  precision: null,
  scale: null,
  nullable: false,
  isKey: false,
  fieldNumber: null,
  description: "",
  classification: null,
  aliases: [],
  decorators: {},
  sortOrder: seq,
  ...overrides,
});

/** A field carrying the default / example the Field Studio and the Documentation panel store (only the keys given are set). */
function stored(
  name: string,
  type: string,
  values: { defaultValue?: unknown; example?: unknown },
  extra: Partial<PrismaFieldInput> = {}
): PrismaFieldInput {
  const typespec: Record<string, unknown> = {};
  if ("defaultValue" in values) typespec.identity = { defaultValue: values.defaultValue };
  if ("example" in values) typespec.documentation = { example: values.example };
  return field({ name, type, ...extra, decorators: { ...(extra.decorators ?? {}), typespec } });
}

function generate(fields: PrismaFieldInput[], overrides: Partial<SuperSchemaModel> = {}) {
  const model: SuperSchemaModel = { ...compileEntity(entity(), fields), ...overrides };
  return generateTypeSpecWithDiagnostics(model, { governance: false });
}

async function compileClean(source: string) {
  const r = await compileTypeSpecWithGovernance(source);
  if (!r.success) {
    throw new Error(`does not compile:\n${r.diagnostics.map((d) => `${d.code}: ${d.message}`).join("\n")}\n---\n${source}`);
  }
  return r.document;
}

/** The literal warnings only (the withheld default / example), in the order the generator reports them. */
function withheld(diagnostics: GeneratorDiagnostic[]) {
  return diagnostics
    .filter((d) => d.code === "DEFAULT_NOT_EMITTED" || d.code === "EXAMPLE_NOT_EMITTED")
    .map((d) => ({ code: d.code, fieldName: d.fieldName, severity: d.severity }));
}

describe("a stored default is written for the field's type", () => {
  it("writes numbers and booleans as literals, and text that reads as one as that number or boolean", async () => {
    const { source, diagnostics } = generate([
      stored("count", "int32", { defaultValue: 5 }),
      stored("price", "decimal", { defaultValue: "19.99" }),
      stored("ratio", "float64", { defaultValue: 0.5 }),
      stored("attempts", "int32", { defaultValue: "0" }),
      stored("enabled", "boolean", { defaultValue: true }),
      stored("archived", "boolean", { defaultValue: "false" }),
    ]);
    expect(diagnostics).toEqual([]);
    expect(source).toContain("  count: int32 = 5;");
    expect(source).toContain("  price: decimal = 19.99;");
    expect(source).toContain("  ratio: float64 = 0.5;");
    expect(source).toContain("  attempts: int32 = 0;");
    expect(source).toContain("  enabled: boolean = true;");
    expect(source).toContain("  archived: boolean = false;");
    await compileClean(source);
  }, 60_000);

  it("withholds a default that does not fit its type, with a warning, and keeps the others", async () => {
    const { source, diagnostics } = generate([
      stored("code", "int32", { defaultValue: "abc" }),
      stored("half", "int32", { defaultValue: 1.5 }),
      stored("huge", "int32", { defaultValue: "3000000000" }),
      stored("flag", "boolean", { defaultValue: "yes" }),
      stored("kept", "int32", { defaultValue: 7 }),
    ]);
    expect(source).toContain("  code: int32;");
    expect(source).toContain("  half: int32;");
    expect(source).toContain("  huge: int32;");
    expect(source).toContain("  flag: boolean;");
    expect(source).toContain("  kept: int32 = 7;");
    expect(withheld(diagnostics)).toEqual([
      { code: "DEFAULT_NOT_EMITTED", fieldName: "code", severity: "warning" },
      { code: "DEFAULT_NOT_EMITTED", fieldName: "half", severity: "warning" },
      { code: "DEFAULT_NOT_EMITTED", fieldName: "huge", severity: "warning" },
      { code: "DEFAULT_NOT_EMITTED", fieldName: "flag", severity: "warning" },
    ]);
    await compileClean(source);
  }, 60_000);

  it("writes a text default with every escape the TypeSpec scanner reads, and interpolation escaped", async () => {
    const text = 'He said "hi"\\ then\nnew line\ttab ${name} $5 \u0008';
    const { source, diagnostics } = generate([stored("note", "string", { defaultValue: text })]);
    expect(diagnostics).toEqual([]);
    expect(source).toContain('  note: string = "He said \\"hi\\"\\\\ then\\nnew line\\ttab \\${name} $5 \u0008";');
    await compileClean(source);
  }, 60_000);

  it("withholds a default holding a NUL character, which TypeSpec text cannot carry", async () => {
    const { source, diagnostics } = generate([stored("blob", "string", { defaultValue: "a\u0000b" })]);
    expect(source).toContain("  blob: string;");
    expect(withheld(diagnostics)).toEqual([{ code: "DEFAULT_NOT_EMITTED", fieldName: "blob", severity: "warning" }]);
    await compileClean(source);
  }, 60_000);

  it("writes no default, and no warning, for a cleared, empty or blank value", () => {
    const { source, diagnostics } = generate([
      stored("cleared", "string", { defaultValue: null }),
      stored("empty", "string", { defaultValue: "" }),
      stored("blank", "int32", { defaultValue: "   " }),
      stored("unset", "int32", {}),
    ]);
    expect(source).toContain("  cleared: string;");
    expect(source).toContain("  empty: string;");
    expect(source).toContain("  blank: int32;");
    expect(source).toContain("  unset: int32;");
    expect(diagnostics).toEqual([]);
  });

  it("withholds a default on a type that has no literal form in TypeSpec text", async () => {
    const { source, diagnostics } = generate([stored("when", "utcDateTime", { defaultValue: "2024-05-06T12:20:00Z" })]);
    expect(source).toContain("  when: utcDateTime;");
    expect(withheld(diagnostics)).toEqual([{ code: "DEFAULT_NOT_EMITTED", fieldName: "when", severity: "warning" }]);
    await compileClean(source);
  }, 60_000);

  it("writes an enum default as a reference to a member of the field's enum, bare or in backticks", async () => {
    const { source, diagnostics } = generate([
      stored("status", "enum", { defaultValue: "ACTIVE" }, { aliases: ["ACTIVE", "in-progress", "model"] }),
      stored("kind", "enum", { defaultValue: "in-progress" }, { aliases: ["ACTIVE", "in-progress", "model"] }),
      stored("tier", "enum", { defaultValue: "model" }, { aliases: ["ACTIVE", "in-progress", "model"] }),
    ]);
    expect(diagnostics).toEqual([]);
    expect(source).toContain("  status: Ticket_status = Ticket_status.ACTIVE;");
    expect(source).toContain("  kind: Ticket_kind = Ticket_kind.`in-progress`;");
    expect(source).toContain("  tier: Ticket_tier = Ticket_tier.`model`;");
    await compileClean(source);
  }, 60_000);

  it("withholds an enum default that the enum does not declare, with a warning", async () => {
    const { source, diagnostics } = generate([stored("phase", "enum", { defaultValue: "GONE" }, { aliases: ["ACTIVE"] })]);
    expect(source).toContain("  phase: Ticket_phase;");
    expect(withheld(diagnostics)).toEqual([{ code: "DEFAULT_NOT_EMITTED", fieldName: "phase", severity: "warning" }]);
    await compileClean(source);
  }, 60_000);

  it("references a shared enum's member, and withholds a value only the field's own list has", async () => {
    const sharedEnums = [{ name: "Ticket_status", values: ["OPEN", "CLOSED"] }];
    const { source, diagnostics } = generate(
      [stored("status", "enum", { defaultValue: "CLOSED" }, { aliases: ["OPEN", "CLOSED", "HOLD"] })],
      { sharedEnums }
    );
    expect(source).toContain("  status: Ticket_status = Ticket_status.CLOSED;");
    expect(diagnostics).toEqual([]);
    await compileClean(source);

    const withHold = generate([stored("status", "enum", { defaultValue: "HOLD" }, { aliases: ["OPEN", "CLOSED", "HOLD"] })], { sharedEnums });
    expect(withHold.source).toContain("  status: Ticket_status;");
    expect(withheld(withHold.diagnostics)).toEqual([{ code: "DEFAULT_NOT_EMITTED", fieldName: "status", severity: "warning" }]);
    await compileClean(withHold.source);
  }, 60_000);
});

describe("a stored documentation example is written as a value of the field's type", () => {
  it("writes text, numbers, lists, objects and enum members as the literal the type takes", async () => {
    const { source, diagnostics } = generate([
      stored("name", "string", { example: "Alice" }),
      stored("code", "string", { example: 42 }),
      stored("count", "int32", { example: 42 }),
      stored("tags", "array", { example: ["a", "b"] }, { decorators: { arrayElementType: "string" } }),
      stored("attrs", "map", { example: { a: "x", "b-c": 1 } }, { decorators: { mapKeyType: "string", mapValueType: "string" } }),
      stored("status", "enum", { example: "ACTIVE" }, { aliases: ["ACTIVE", "INACTIVE"] }),
    ]);
    expect(diagnostics).toEqual([]);
    expect(source).toContain('  @example("Alice")');
    expect(source).toContain('  @example("42")');
    expect(source).toContain("  @example(42)");
    expect(source).toContain('  @example(#["a", "b"])');
    expect(source).toContain('  @example(#{a: "x", `b-c`: "1"})');
    expect(source).toContain("  @example(Ticket_status.ACTIVE)");
    await compileClean(source);
  }, 60_000);

  it("withholds an example the type cannot take, with a warning, and writes the text of a legacy raw literal as text", async () => {
    const { source, diagnostics } = generate([
      stored("count", "int32", { example: "many" }),
      stored("title", "string", { example: { a: 1 } }),
      stored("when", "utcDateTime", { example: "2024-05-06T12:20:00Z" }),
      stored("kept", "string", { example: '#{ name: "John" }' }),
    ]);
    expect(source).toContain("  count: int32;");
    expect(source).toContain("  title: string;");
    expect(source).toContain("  when: utcDateTime;");
    expect(source).toContain('  @example("#{ name: \\"John\\" }")');
    expect(withheld(diagnostics)).toEqual([
      { code: "EXAMPLE_NOT_EMITTED", fieldName: "count", severity: "warning" },
      { code: "EXAMPLE_NOT_EMITTED", fieldName: "title", severity: "warning" },
      { code: "EXAMPLE_NOT_EMITTED", fieldName: "when", severity: "warning" },
    ]);
    await compileClean(source);
  }, 60_000);

  it("writes a date, time or duration field's own constructor as its default and example, and withholds another type's constructor", async () => {
    const { source, diagnostics } = generate([
      stored("when", "utcDateTime", { defaultValue: "utcDateTime.now()", example: 'utcDateTime.fromISO("2024-05-06T12:20:00Z")' }),
      stored("span", "duration", { defaultValue: 'duration.fromISO("P1D")', example: "utcDateTime.now()" }),
      stored("day", "plainDate", { defaultValue: "utcDateTime.now()", example: "plainDate.now()" }),
    ]);
    expect(source).toContain('  @example(utcDateTime.fromISO("2024-05-06T12:20:00Z"))');
    expect(source).toContain("  when: utcDateTime = utcDateTime.now();");
    expect(source).toContain('  span: duration = duration.fromISO("P1D");');
    expect(source).not.toContain("@example(utcDateTime.now())");
    expect(source).toContain("  @example(plainDate.now())");
    expect(source).toContain("  day: plainDate;");
    expect(withheld(diagnostics)).toEqual([
      { code: "EXAMPLE_NOT_EMITTED", fieldName: "span", severity: "warning" },
      { code: "DEFAULT_NOT_EMITTED", fieldName: "day", severity: "warning" },
    ]);
    await compileClean(source);
  }, 60_000);

  it("writes no example for a cleared or empty value", () => {
    const { source, diagnostics } = generate([
      stored("cleared", "string", { example: null }),
      stored("empty", "int32", { example: "" }),
    ]);
    expect(source).not.toContain("@example");
    expect(diagnostics).toEqual([]);
  });

  it("writes a whole number past 2^53 in an example as the text the compiler reads back, and withholds one the type cannot take", async () => {
    // A decorator argument is read as a double: the compiler throws on the exact digits of 2^60, and accepts the text the double prints as.
    const { source, diagnostics } = generate([
      stored("big", "int64", { example: 2 ** 60 }),
      stored("near", "int64", { example: 1234567890123456789 }),
      stored("digits", "int64", { example: "9007199254740993" }),
      stored("items", "array", { example: [2 ** 60] }, { decorators: { arrayElementType: "int64" } }),
      stored("max", "int64", { example: "9223372036854775807" }),
      stored("exact", "int64", { defaultValue: 2 ** 60 }),
    ]);
    expect(source).toContain("  @example(1152921504606847000)");
    expect(source).toContain("  @example(1234567890123456800)");
    expect(source).toContain("  @example(9007199254740992)");
    expect(source).toContain("  @example(#[1152921504606847000])");
    expect(source).toContain("  max: int64;");
    expect(source).toContain("  exact: int64 = 1152921504606846976;");
    expect(withheld(diagnostics)).toEqual([{ code: "EXAMPLE_NOT_EMITTED", fieldName: "max", severity: "warning" }]);
    await compileClean(source);
  }, 60_000);
});

describe("the stale-source backfill never flags what the generator writes", () => {
  it("finds no literal to flag in a source the generator wrote from defaults and examples of every shape", () => {
    const { source } = generate([
      stored("name", "string", { defaultValue: "Alice", example: "Dr. Smith" }),
      stored("count", "int32", { defaultValue: 5, example: 42 }),
      stored("ratio", "float64", { defaultValue: 0.5, example: "1e3" }),
      stored("flag", "boolean", { defaultValue: true, example: false }),
      stored("status", "enum", { defaultValue: "ACTIVE", example: "in-progress" }, { aliases: ["ACTIVE", "in-progress"] }),
      stored("labels", "array", { defaultValue: ["ACTIVE"], example: ["ACTIVE", "in-progress"] }, { decorators: { arrayElementType: "enum", enumValues: ["ACTIVE", "in-progress"] } }),
      stored("attrs", "map", { example: { a: "x", "b-c": 1 } }, { decorators: { mapKeyType: "string", mapValueType: "string" } }),
      stored("when", "utcDateTime", { defaultValue: "utcDateTime.now()", example: 'utcDateTime.fromISO("2024-05-06T12:20:00Z")' }),
      stored("pinned", "union", { example: 5 }, { decorators: { unionMembers: ["string", "int32"] } }),
    ]);
    const written = projectSourceFields(source, "Ticket");
    expect(written.length).toBeGreaterThan(0);
    expect(compareSourceLiterals(written, written)).toEqual([]);
  });
});

/** A one-entity closure (the publish gate's input) holding the given fields, the shape closure-source.test.ts builds. */
function closureOf(fields: PrismaFieldInput[]): { entities: ClosureEntity[] } {
  const ref = { entityId: "e1", domain: "Sales", product: "Orders", entity: "Ticket" };
  const key = field({ name: "id", type: "uuid", isKey: true });
  return {
    entities: [
      {
        entityId: "e1",
        ref,
        source: "published",
        version: "1.0",
        fields: [key, ...fields],
        entity: { id: "e1", name: "Ticket", description: "", status: "PUBLISHED", version: 1, domainId: null, metadata: {}, domain: null },
      } as unknown as ClosureEntity,
    ],
  };
}

describe("unions, lists of enum members, names outside NFC, and cleared values, compiled", () => {
  it("writes a declared union's literal default and its example, and withholds a value no member takes", async () => {
    const { source, diagnostics } = generate(
      [
        stored("status", "union", { defaultValue: "a" }, { decorators: { unionName: "Status" } }),
        stored("choice", "union", { defaultValue: "c" }, { decorators: { unionName: "Status" } }),
        stored("pinned", "union", { example: "b" }, { decorators: { unionName: "Status" } }),
      ],
      { unionTypes: [{ name: "Status", memberTypes: ['"a"', '"b"'] }] }
    );
    expect(source).toContain('  status: Status = "a";');
    expect(source).toContain("  choice: Status;");
    expect(source).toContain('  @example("b")');
    expect(withheld(diagnostics)).toEqual([{ code: "DEFAULT_NOT_EMITTED", fieldName: "choice", severity: "warning" }]);
    await compileClean(source);
  }, 60_000);

  it("writes an inline union's default as the text or number its members take, and its example as a number", async () => {
    const { source, diagnostics } = generate([
      stored("text", "union", { defaultValue: "x" }, { decorators: { unionMembers: ["string", "int32"] } }),
      stored("code", "union", { defaultValue: "7" }, { decorators: { unionMembers: ["string", "int32"] } }),
      stored("pinned", "union", { example: 5 }, { decorators: { unionMembers: ["string", "int32"] } }),
    ]);
    expect(diagnostics).toEqual([]);
    expect(source).toContain('  text: string | int32 = "x";');
    expect(source).toContain('  code: string | int32 = "7";');
    expect(source).toContain("  @example(5)");
    await compileClean(source);
  }, 60_000);

  it("writes a list of enum members as references to the field's enum", async () => {
    const { source, diagnostics } = generate([
      stored("labels", "array", { defaultValue: ["ACTIVE", "in-progress"] }, { decorators: { arrayElementType: "enum", enumValues: ["ACTIVE", "in-progress"] } }),
    ]);
    expect(diagnostics).toEqual([]);
    expect(source).toContain("  labels: Ticket_labels[] = #[Ticket_labels.ACTIVE, Ticket_labels.`in-progress`];");
    await compileClean(source);
  }, 60_000);

  it("withholds an enum default whose name is not in Unicode NFC form, and writes the composed name's reference", async () => {
    const composed = "Café";
    const decomposed = "Café";
    const { source, diagnostics } = generate([
      stored("drink", "enum", { defaultValue: decomposed }, { aliases: [composed, decomposed] }),
      stored("cup", "enum", { defaultValue: composed }, { aliases: [composed, decomposed] }),
    ]);
    expect(source).toContain("  drink: Ticket_drink;");
    expect(source).toContain("  cup: Ticket_cup = Ticket_cup.`Café`;");
    expect(withheld(diagnostics)).toEqual([{ code: "DEFAULT_NOT_EMITTED", fieldName: "drink", severity: "warning" }]);
    await compileClean(source);
  }, 60_000);

  it("compiles the cleared values: a null, empty or blank default and example are no clause at all", async () => {
    const { source, diagnostics } = generate([
      stored("cleared", "string", { defaultValue: null, example: null }),
      stored("blank", "int32", { defaultValue: "   ", example: "" }),
      stored("unset", "boolean", {}),
    ]);
    expect(diagnostics).toEqual([]);
    expect(source).not.toContain("= null");
    expect(source).not.toContain("@example");
    await compileClean(source);
  }, 60_000);

  it("compiles the default and the example in the closure document the publish gate checks", async () => {
    const out = generateClosureTypeSpec(
      closureOf([stored("count", "int32", { defaultValue: "5", example: "7" }), stored("note", "string", { defaultValue: 'say "hi"' })]),
      { target: "publish-gate", governance: false }
    );
    expect(out.source).toContain("count: int32 = 5");
    expect(out.source).toContain("@example(7)");
    expect(out.source).toContain('note: string = "say \\"hi\\""');
    await compileClean(out.source);
  }, 60_000);
});
