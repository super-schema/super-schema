import { describe, it, expect, vi } from "vitest";
import type { PrismaEntityInput, PrismaFieldInput } from "@/lib/compiler/compiler.service";

vi.mock("@/lib/db", () => ({ prisma: {} }));
vi.setConfig({ testTimeout: 60_000 });
import { emitOfficialTypeSpecTargetFromData } from "@/lib/typespec-official/emitter.service";

// Bounds on a fixed-width integer, through the REAL compiler: exclusive bounds at / beyond the limit and fractional bounds must not
// break the compile (the same family as the inclusive bound beyond int64: commit 0485b17f).
const entity: PrismaEntityInput = { id: "e", name: "Evt", description: "", status: "DRAFT", version: 1, domainId: "d", metadata: {}, domain: { id: "d", name: "Sales", slug: "sales" } };
const field = (type: string, validation: Record<string, unknown>): PrismaFieldInput => ({
  id: "f", name: "v", type, precision: null, scale: null, nullable: false, isKey: false, fieldNumber: null, description: "", classification: null,
  aliases: [], decorators: { typespec: { validation } }, sortOrder: 0,
});
const emit = (f: PrismaFieldInput) => emitOfficialTypeSpecTargetFromData(entity, [f], "json-schema");

describe("integer bounds through the real compiler", () => {
  it.each([
    ["int32 exclusive maximum beyond the limit", "int32", { maxValueExclusive: 2147483648 }],
    ["int32 exclusive minimum beyond the limit", "int32", { minValueExclusive: -2147483649 }],
    ["int64 exclusive maximum (JSON 2^63)", "int64", { maxValueExclusive: 9223372036854775807 }],
    ["int64 exclusive minimum (JSON -2^63)", "int64", { minValueExclusive: -9223372036854775808 }],
    ["uint8 exclusive maximum at the limit", "uint8", { maxValueExclusive: 255 }],
    ["int32 fractional maximum just inside the range", "int32", { maxValue: 2147483647.5 }],
    ["int32 fractional minimum just inside the range", "int32", { minValue: -2147483647.5 }],
    ["int32 fractional bounds in the middle", "int32", { minValue: 0.5, maxValue: 10.5 }],
  ])("%s compiles", async (_name, type, validation) => {
    const result = await emit(field(type, validation));
    expect(result.errors).toEqual([]);
    expect(result.validationStatus).not.toBe("INVALID");
  });
});
