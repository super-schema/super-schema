/**
 * The builder decides at build time which fields would end up as the same column (`emittedColumnName`, a copy of the
 * emitters' snake_case). This pins that copy to the REAL emitters: for each name of 12 tricky pairs the real emitter prints
 * the column for that field ALONE, and the builder's verdict (`collides` iff the two names print the same column) must
 * equal what the emitters printed. If a sibling emitter ever changes its naming, this fails instead of the builder
 * silently letting a collision through (or inventing one).
 */
import { describe, it, expect } from "vitest";
import { buildDbTypeSpecTarget, emittedColumnName } from "@/lib/typespec-official/db-source";
import { runTypeSpecEmitterWithWarnings } from "@/lib/typespec-official/emitter.service";
import type { SuperSchemaField, SuperSchemaModel } from "@/types/super-schema-model";

const TARGETS = [["spanner"], ["postgresql"], ["bigquery"]] as const;
const PACKAGE: Record<string, string> = { spanner: "@typespec/spanner", postgresql: "@typespec/postgres", bigquery: "@typespec/bigquery" };

// [a, b, do they end up as the same column?] — the third value is what the emitters are expected to do today; the test
// compares the builder with the emitters, not with this column (which only documents the intent of each pair).
const PAIRS: Array<[string, string, boolean]> = [
  ["aB", "a_b", true],
  ["HTTPServer", "httpserver", true],
  ["HTTPServer", "http_server", false],
  ["getHTTPResponse", "get_httpresponse", true],
  ["café", "caf", true],
  ["café", "cafe", false],
  ["item2name", "item2Name", true],
  ["item2Name", "item2_name", false],
  ["userID", "user_id", true],
  ["_id", "id", true],
  ["1a", "_1a", true],
  ["ABc", "a_bc", false],
];

function field(name: string, overrides: Partial<SuperSchemaField> = {}): SuperSchemaField {
  return { id: `f-${name}`, name, type: "string", nullable: true, isKey: false, sortOrder: 1, description: "", aliases: [], decorators: {}, ...overrides } as SuperSchemaField;
}

function model(fields: SuperSchemaField[]): SuperSchemaModel {
  return { namespace: "", entity: { name: "Probe", description: "", domain: "probe", metadata: {} }, fields } as unknown as SuperSchemaModel;
}

const KEY = field("pk", { isKey: true, nullable: false, sortOrder: 0 });

/** The column the REAL emitter prints for a table with just a key and this one field. */
async function printedColumn(target: string, name: string): Promise<string> {
  const built = buildDbTypeSpecTarget(model([KEY, field(name)]), target);
  expect(built.errors, `${name} alone builds`).toEqual([]);
  const run = await runTypeSpecEmitterWithWarnings(PACKAGE[target], built.source, { "naming-convention": "snake_case" });
  expect(run.success, `${name} compiles on ${target}`).toBe(true);
  if (!run.success) throw new Error("unreachable");
  const columns = run.data.files
    .flatMap((file) => file.content.split("\n"))
    .map((line) => /^ {2}(\S+) /.exec(line)?.[1])
    .filter((column): column is string => column !== undefined && column !== "PRIMARY");
  expect(columns, `${name} on ${target}: key column then the field`).toHaveLength(2);
  expect(columns[0]).toBe("pk");
  return columns[1];
}

describe.each(TARGETS)("%s: the builder's collision verdict agrees with the real emitter", (target) => {
  const names = [...new Set(PAIRS.flatMap(([a, b]) => [a, b]))];

  it("prints, for every name alone, exactly the column the builder predicts", async () => {
    const printed = new Map<string, string>();
    // seven emitter runs at a time: each is a `tsp` process
    for (let i = 0; i < names.length; i += 7) {
      await Promise.all(names.slice(i, i + 7).map(async (name) => printed.set(name, await printedColumn(target, name))));
    }

    for (const name of names) expect(printed.get(name), `column for "${name}"`).toBe(emittedColumnName(name));

    for (const [a, b, expected] of PAIRS) {
      const realCollision = printed.get(a) === printed.get(b);
      const verdict = emittedColumnName(a) === emittedColumnName(b);
      expect(verdict, `"${a}" and "${b}": builder says ${verdict}, the emitter printed "${printed.get(a)}" and "${printed.get(b)}"`).toBe(realCollision);
      expect(realCollision, `"${a}" and "${b}" documented as collision=${expected}`).toBe(expected);

      const built = buildDbTypeSpecTarget(model([KEY, field(a), field(b, { sortOrder: 2 })]), target);
      expect(built.errors.length > 0, `"${a}" and "${b}": builder error iff collision`).toBe(realCollision);
    }
  }, 180_000);
});
