/**
 * A DB target whose entity holds a field typed with a name the app does not have (a row written before the writers refused
 * it, such as a model name `Price`) is INVALID with the builder's error, and writes no DDL. It must not reach the emitter as a
 * string column, which a DDL with no diagnostic would be.
 */
import { describe, it, expect, vi } from "vitest";

vi.mock("@/lib/db", () => ({ prisma: {} }));

import { emitOfficialTypeSpecTargetFromData } from "@/lib/typespec-official/emitter.service";

const ENTITY = { id: "e1", name: "Transaction", description: "", status: "active", version: 1, domainId: "d1", metadata: {}, domain: { id: "d1", name: "payments", slug: "payments" } };
const FIELD = (overrides: Record<string, unknown>) => ({
  id: "f", name: "id", type: "string", precision: null, scale: null, nullable: false, isKey: false, fieldNumber: null, description: "",
  classification: null, aliases: [], decorators: {}, sortOrder: 0, ...overrides,
});

describe("a DB target with a field typed with a name the app does not have", () => {
  it.each(["spanner", "postgresql", "bigquery"])("is INVALID on %s, with no DDL", async (target) => {
    const fields = [FIELD({ id: "f1", name: "id", isKey: true }), FIELD({ id: "f2", name: "price", type: "Price", sortOrder: 1 })];

    const result = await emitOfficialTypeSpecTargetFromData(ENTITY, fields, target);

    expect(result.validationStatus).toBe("INVALID");
    expect(result.output).toBe("");
    expect(result.errors).toEqual([{ message: expect.stringContaining('"price" is typed "Price"') }]);
  }, 60_000);
});
