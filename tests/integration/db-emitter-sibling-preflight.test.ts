/**
 * Preflight: the sibling emitter packages carry the `write.ts` patch. One tiny model per dialect with one described column.
 * If the sibling is unpatched or not rebuilt, THESE are the failures to read first: the message is the pointer.
 *   Spanner, PostgreSQL: `  col TYPE, -- text` (the comma BEFORE the comment; unpatched: `col TYPE -- text,`)
 *   BigQuery:            `OPTIONS(description='it\'s C:\\dir\\')` (the emitter escapes `\` and `'`; unpatched: raw text)
 */
import { describe, it, expect } from "vitest";
import type { PrismaEntityInput, PrismaFieldInput } from "@/lib/compiler/compiler.service";
import { emitOfficialTypeSpecTargetFromData } from "@/lib/typespec-official/emitter.service";
import { withHint } from "../helpers/sibling-patch";

const entity: PrismaEntityInput = { id: "e1", name: "Transaction", description: "", status: "active", version: 1, domainId: "d1", metadata: {}, domain: { id: "d1", name: "payments", slug: "payments" } };

function field(name: string, overrides: Partial<PrismaFieldInput> = {}): PrismaFieldInput {
  return { id: `f-${name}`, name, type: "string", precision: null, scale: null, nullable: true, isKey: false, fieldNumber: null, description: "", classification: null, aliases: [], decorators: {}, sortOrder: 1, ...overrides };
}

const KEY = field("transactionId", { isKey: true, nullable: false, sortOrder: 0 });

describe("sibling emitter preflight", () => {
  it.each([
    ["spanner", "  note STRING(MAX), -- the note"],
    ["postgresql", "  note TEXT, -- the note"],
  ])("%s writes a column comment after the comma", async (target, expectedLine) => {
    const result = await emitOfficialTypeSpecTargetFromData(entity, [KEY, field("note", { description: "the note" })], target);

    expect(result.errors).toEqual([]);
    expect(result.output.split("\n"), withHint(`${target} must write ${JSON.stringify(expectedLine)}`)).toContain(expectedLine);
  }, 60_000);

  it("bigquery escapes a quote and a backslash in a column description itself", async () => {
    const result = await emitOfficialTypeSpecTargetFromData(entity, [KEY, field("note", { description: "it's C:\\dir\\" })], "bigquery");

    expect(result.errors).toEqual([]);
    expect(result.output, withHint("bigquery must write description='it\\'s C:\\\\dir\\\\' once")).toContain("  note STRING OPTIONS(description='it\\'s C:\\\\dir\\\\'),");
  }, 60_000);
});
