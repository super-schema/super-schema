/**
 * A DB emitter that has to skip a column (`unsupported-type`) still writes the table and still exits 0: the warning is
 * all that says a column is missing. It must reach the target result as a warning with status WARNING — never a plain VALID.
 */
import { describe, it, expect, vi } from "vitest";

vi.mock("@/lib/db", () => ({ prisma: {} }));
vi.mock("@/lib/typespec-official/db-source", async (importOriginal) => {
  const actual = await importOriginal<typeof import("@/lib/typespec-official/db-source")>();
  return { ...actual, buildDbTypeSpecTarget: vi.fn(actual.buildDbTypeSpecTarget) };
});

import { emitOfficialTypeSpecTargetFromData, runTypeSpecEmitterWithWarnings, runTypeSpecEmitterFiles } from "@/lib/typespec-official/emitter.service";
import { buildDbTypeSpecTarget } from "@/lib/typespec-official/db-source";

// `plainTime` has no column type in the Spanner emitter (the builder maps it to a string, so a hand-written source is needed).
const SKIPPING_SOURCE = `import "@typespec/spanner";

using TypeSpec.Spanner;

@schema("payments")
namespace Payments;

model Transaction {
  @primaryKey id: string;
  at?: plainTime;
}
`;

describe("the compile's warning diagnostics", () => {
  it("runTypeSpecEmitterWithWarnings returns the files AND the warnings of a successful compile", async () => {
    const run = await runTypeSpecEmitterWithWarnings("@typespec/spanner", SKIPPING_SOURCE, { "naming-convention": "snake_case" });

    expect(run.success).toBe(true);
    if (!run.success) return;
    expect(run.data.files[0].content).toContain("CREATE TABLE transaction");
    expect(run.data.files[0].content).not.toContain("at ");
    expect(run.data.warnings).toHaveLength(1);
    expect(run.data.warnings[0]).toMatch(/^@typespec\/spanner\/unsupported-type: Type 'plainTime' is not supported by the Spanner emitter/);
    expect(run.data.warnings[0]).not.toMatch(/superschema-tsp|\/var\/|main\.tsp/);
  }, 60_000);

  it("runTypeSpecEmitterFiles (the events renderer's entry) still returns just the files", async () => {
    const run = await runTypeSpecEmitterFiles("@typespec/spanner", SKIPPING_SOURCE, { "naming-convention": "snake_case" });

    expect(run.success && Array.isArray(run.data)).toBe(true);
  }, 60_000);

  it("a DB target whose emitter skipped a column is WARNING with the emitter's warning, and still has its output", async () => {
    vi.mocked(buildDbTypeSpecTarget).mockReturnValueOnce({ source: SKIPPING_SOURCE, warnings: [], errors: [] });
    const entity = { id: "e1", name: "Transaction", description: "", status: "active", version: 1, domainId: "d1", metadata: {}, domain: { id: "d1", name: "payments", slug: "payments" } };
    const fields = [{ id: "f1", name: "id", type: "string", precision: null, scale: null, nullable: false, isKey: true, fieldNumber: null, description: "", classification: null, aliases: [], decorators: {}, sortOrder: 0 }];

    const result = await emitOfficialTypeSpecTargetFromData(entity, fields, "spanner");

    expect(result.validationStatus).toBe("WARNING");
    expect(result.errors).toEqual([]);
    expect(result.output).toContain("CREATE TABLE transaction");
    expect(result.warnings).toEqual([expect.stringMatching(/^@typespec\/spanner\/unsupported-type: Type 'plainTime' is not supported/)]);
  }, 60_000);

  it("keeps builder warnings and emitter warnings together", async () => {
    vi.mocked(buildDbTypeSpecTarget).mockReturnValueOnce({ source: SKIPPING_SOURCE, warnings: ["builder says hello"], errors: [] });
    const entity = { id: "e1", name: "Transaction", description: "", status: "active", version: 1, domainId: "d1", metadata: {}, domain: { id: "d1", name: "payments", slug: "payments" } };
    const fields = [{ id: "f1", name: "id", type: "string", precision: null, scale: null, nullable: false, isKey: true, fieldNumber: null, description: "", classification: null, aliases: [], decorators: {}, sortOrder: 0 }];

    const result = await emitOfficialTypeSpecTargetFromData(entity, fields, "spanner");

    expect(result.validationStatus).toBe("WARNING");
    expect(result.warnings).toHaveLength(2);
    expect(result.warnings[0]).toBe("builder says hello");
  }, 60_000);
});
