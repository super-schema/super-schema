/**
 * `emitEntity` maps each target's validation status to the `isValid` flag the PR summary prints ("Valid" / "Invalid").
 * A WARNING target (e.g. Avro enum symbols that had to be renamed) produced a usable schema — it is valid, with warnings,
 * the same meaning `emitFromData` gives `isValid`; only INVALID is invalid.
 */
import { describe, it, expect, vi } from "vitest";

const entityRow = { id: "e1", name: "Ticket", description: "", status: "DRAFT", version: 1, domainId: "d1", metadata: {}, domain: { id: "d1", name: "Sales" } };

vi.mock("@/lib/db", () => ({
  prisma: {
    entity: { findUnique: vi.fn(async () => entityRow) },
    field: { findMany: vi.fn(async () => []) },
  },
}));

vi.mock("@/lib/typespec-official/emitter.service", () => ({
  emitOfficialTypeSpecTargetFromData: vi.fn(async (_entity: unknown, _fields: unknown, targetKey: string) => {
    if (targetKey === "avro") {
      return { output: "{}", validationStatus: "WARNING", warnings: ['Avro enum symbol "in-progress" of Ticket_status is published as "in_progress"'], errors: [] };
    }
    if (targetKey === "spanner") return { output: "", validationStatus: "INVALID", warnings: [], errors: [{ message: "boom" }] };
    return { output: "ok", validationStatus: "VALID", warnings: [], errors: [] };
  }),
}));

import { emitEntity } from "@/lib/emission/emission.service";

describe("emitEntity isValid", () => {
  it("is true for VALID and WARNING targets, false only for INVALID", async () => {
    const result = await emitEntity("e1");
    expect(result.targets.avro).toMatchObject({ validationStatus: "WARNING", isValid: true });
    expect(result.targets.avro.warnings).toEqual([{ message: 'Avro enum symbol "in-progress" of Ticket_status is published as "in_progress"' }]);
    expect(result.targets.spanner).toMatchObject({ validationStatus: "INVALID", isValid: false });
    expect(result.targets["json-schema"]).toMatchObject({ validationStatus: "VALID", isValid: true });
    expect(result.success).toBe(false); // an INVALID target still fails the emission
    expect(result.summary.warningCount).toBe(1);
    expect(result.summary.invalidCount).toBe(1);
  });
});
