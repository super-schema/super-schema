/**
 * The backfill's rule for a stored default or example (compareSourceLiterals) agrees with the REAL TypeSpec compiler, on a field of each type a
 * source declares. A default or example the rule keeps as written compiles on that field. The rule keeps a stored text only when the generator
 * writes the same text for the field's row value, so the regenerated side is the generator's own output for the value each candidate text stands
 * for: a quoted text for its text, a raw text for itself, a member reference for its member, a constructor for its constructor, as the
 * Documentation panel and the Default Value input store them.
 */
import { describe, it, expect, vi, beforeAll } from "vitest";
import { compileEntity, type PrismaEntityInput, type PrismaFieldInput } from "@/lib/compiler/compiler.service";
import { generateTypeSpecWithDiagnostics } from "@/lib/compiler/typespec-generator";
import {
  compareSourceLiterals,
  compareSourceProjection,
  projectRowFields,
  projectSourceFields,
  type ProjectedField,
} from "@/lib/entity-versioning/source-projection";

vi.mock("server-only", () => ({}));

let compileTypeSpecWithGovernance: typeof import("@/lib/compiler/typespec-compiler").compileTypeSpecWithGovernance;

beforeAll(async () => {
  ({ compileTypeSpecWithGovernance } = await import("@/lib/compiler/typespec-compiler"));
});

const DECLARED = "enum Ticket_status {\n  ACTIVE,\n  `in-progress`,\n}\n";

/** A field a stored source declares: its TypeSpec type, and the logical type (and enum members) the generator writes it as. */
interface FieldSpec {
  name: string;
  tsType: string;
  logical: string;
  aliases?: string[];
}

const FIELDS: FieldSpec[] = [
  { name: "name", tsType: "string", logical: "string" },
  { name: "count", tsType: "int32", logical: "int32" },
  { name: "when", tsType: "utcDateTime", logical: "utcDateTime" },
  { name: "flag", tsType: "boolean", logical: "boolean" },
  { name: "status", tsType: "Ticket_status", logical: "enum", aliases: ["ACTIVE", "in-progress"] },
];

/** A stored text, and the row value the Documentation panel or the Default Value input stores for it. */
const CANDIDATES: Array<[string, unknown]> = [
  ['"Alice"', "Alice"],
  ["Alice", "Alice"],
  ['"42"', "42"],
  ["42", 42],
  ["true", true],
  ['"true"', "true"],
  ["#{a: 1}", { a: 1 }],
  ['#["a", "b"]', ["a", "b"]],
  ["[object Object]", "[object Object]"],
  ["Dr.Smith", "Dr.Smith"],
  ["Ticket_status.ACTIVE", "ACTIVE"],
  ["Ticket_status.`in-progress`", "in-progress"],
  ["Ticket_status.NOPE", "NOPE"],
  ["utcDateTime.now()", "utcDateTime.now()"],
  ['utcDateTime.fromISO("2024-05-06T12:20:00Z")', 'utcDateTime.fromISO("2024-05-06T12:20:00Z")'],
  ['utcDateTime.fromISO("A")', 'utcDateTime.fromISO("A")'],
  ['utcDateTime.fromISO("a\\"b")', 'utcDateTime.fromISO("a\\"b")'],
  ['utcDateTime.fromISO("\\q")', 'utcDateTime.fromISO("\\q")'],
  ['utcDateTime.fromISO("\\x41")', 'utcDateTime.fromISO("\\x41")'],
  ['utcDateTime.fromISO("2024\n")', 'utcDateTime.fromISO("2024\n")'],
  ["2024-05-06T12:20:00Z", "2024-05-06T12:20:00Z"],
  ["1e3", 1000],
  ["9007199254740993", 9007199254740993],
];

const entity = (): PrismaEntityInput => ({
  id: "e1",
  name: "Ticket",
  description: "",
  status: "DRAFT",
  version: 1,
  domainId: "d1",
  metadata: {},
  domain: { id: "d1", name: "Sales", slug: "sales" },
});

const field = (overrides: Partial<PrismaFieldInput>): PrismaFieldInput => ({
  id: `f-${overrides.name}`,
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
  sortOrder: 1,
  ...overrides,
});

/** The projected field the generator writes for `spec` when its stored `what` (the default or the documentation example) is `value`. */
function regenerated(spec: FieldSpec, what: "default" | "example", value: unknown): ProjectedField | undefined {
  const decorators =
    what === "default" ? { typespec: { identity: { defaultValue: value } } } : { typespec: { documentation: { example: value } } };
  const row = field({ name: spec.name, type: spec.logical, aliases: spec.aliases ?? [], decorators });
  const { source } = generateTypeSpecWithDiagnostics(compileEntity(entity(), [row]), { governance: false });
  return projectSourceFields(source, "Ticket").find((p) => p.name === spec.name);
}

/** The Ticket model a stored source declares, with `text` as the field's default or example. */
function storedSource(spec: FieldSpec, what: "default" | "example", text: string): string {
  const line = what === "default" ? `  ${spec.name}: ${spec.tsType} = ${text};\n` : `  @example(${text})\n  ${spec.name}: ${spec.tsType};\n`;
  return `${DECLARED}model Ticket {\n${line}}\n`;
}

describe("the backfill's rule for a stored default or example agrees with the compiler", () => {
  it("keeps a stored default or example exactly when the installed compiler accepts it on the field, for every type a source declares", async () => {
    const broken: string[] = [];
    const kept: string[] = [];
    for (const what of ["example", "default"] as const) {
      for (const spec of FIELDS) {
        for (const [text, value] of CANDIDATES) {
          const source = storedSource(spec, what, text);
          const reading = regenerated(spec, what, value);
          // The backfill's reasons (stale-source-flag.service.ts): the field projection and the literal rule, over the same stored source.
          const stored = projectSourceFields(source, "Ticket");
          const regeneratedFields = reading ? [reading] : [];
          const rows = projectRowFields([{ name: spec.name, type: spec.logical, decorators: {} }]);
          const reasons = [
            ...compareSourceProjection(stored, rows, regeneratedFields).reasons,
            ...compareSourceLiterals(stored, regeneratedFields),
          ];
          if (reasons.length > 0) continue;
          kept.push(`${what} ${spec.tsType} ${text}`);
          const compiled = (await compileTypeSpecWithGovernance(source)).success;
          if (!compiled) broken.push(`${what} ${spec.tsType} ${text}`);
        }
      }
    }
    expect(broken).toEqual([]);
    // The rule is not vacuous: a literal of the field's type and a constructor of its own type are kept, a raw text, a wrong type and a
    // constructor TypeSpec cannot read are not.
    expect(kept).toEqual(
      expect.arrayContaining([
        'example string "Alice"',
        "example int32 42",
        "example Ticket_status Ticket_status.ACTIVE",
        "example utcDateTime utcDateTime.now()",
        'default string "Alice"',
        "default int32 42",
        "default utcDateTime utcDateTime.now()",
        'default utcDateTime utcDateTime.fromISO("A")',
      ]),
    );
    expect(kept).not.toContain("example string Alice");
    expect(kept).not.toContain("example string 42");
    expect(kept).not.toContain("default string 42");
    expect(kept).not.toContain('example utcDateTime utcDateTime.fromISO("\\q")');
    expect(kept).not.toContain('default utcDateTime utcDateTime.fromISO("\\q")');
  }, 300_000);
});
