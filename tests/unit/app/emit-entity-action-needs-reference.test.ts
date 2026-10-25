/**
 * FINAL WAVE 2b, G12: `emitEntityAction` (the all-targets run) answers the pick an ambiguous reference needs beside its result, in the
 * shape `generateSchemaAction` answers (`needsReference`), so the page can open the pick dialog. Prisma, auth and the emission are mocked.
 */
import { beforeEach, describe, expect, it, vi } from "vitest";

const h = vi.hoisted(() => ({
  emitEntity: vi.fn(),
  prisma: { entity: { findUnique: vi.fn() } },
}));

vi.mock("server-only", () => ({}));
vi.mock("@/lib/db", () => ({ prisma: h.prisma }));
vi.mock("@/lib/auth", () => ({ auth: vi.fn().mockResolvedValue({ user: { id: "user-1" } }) }));
vi.mock("next/cache", () => ({ revalidatePath: vi.fn() }));
vi.mock("@/lib/active-tenant", () => ({ getActiveTenantId: vi.fn().mockResolvedValue("tenant-1") }));
vi.mock("@/lib/emission/emission.service", async (importOriginal) => ({ ...(await importOriginal<typeof import("@/lib/emission/emission.service")>()), emitEntity: h.emitEntity }));

import { emitEntityAction } from "@/app/(dashboard)/schemas/[domainSlug]/[productSlug]/[entityId]/actions";

const DETAILS = {
  field: "addr",
  name: "Address",
  candidates: [
    { entityId: "x1", domain: "D1", product: "P1", entity: "Address" },
    { entityId: "x2", domain: "D2", product: "P2", entity: "Address" },
  ],
  entityId: "member-1",
  fieldId: "fld-9",
};
const RESULT = (refusal?: unknown) => ({ typespec: "", targets: {}, success: false, summary: { totalTargets: 8, validCount: 3, warningCount: 0, invalidCount: 5 }, ...(refusal ? { refusal } : {}) });

beforeEach(() => {
  vi.clearAllMocks();
  h.prisma.entity.findUnique.mockResolvedValue({ tenantId: "tenant-1" });
});

describe("emitEntityAction", () => {
  it("answers needsReference beside the result when the closure refused with an ambiguous name", async () => {
    h.emitEntity.mockResolvedValue(RESULT({ code: "AMBIGUOUS_REFERENCE", message: "Choose.", details: DETAILS }));
    const answer = await emitEntityAction("ent-1");
    expect(answer).toMatchObject({ success: true, needsReference: DETAILS, result: { refusal: { code: "AMBIGUOUS_REFERENCE" } } });
  });

  it("answers no question for a name frozen in a published member, for another refusal, or for none", async () => {
    h.emitEntity.mockResolvedValueOnce(RESULT({ code: "AMBIGUOUS_REFERENCE", message: "Publish it again.", details: { ...DETAILS, frozen: true } }));
    expect(await emitEntityAction("ent-1")).not.toHaveProperty("needsReference");
    h.emitEntity.mockResolvedValueOnce(RESULT({ code: "NEVER_PUBLISHED", message: "Never published." }));
    expect(await emitEntityAction("ent-1")).not.toHaveProperty("needsReference");
    h.emitEntity.mockResolvedValueOnce({ ...RESULT(), success: true });
    expect(await emitEntityAction("ent-1")).toEqual({ success: true, result: expect.objectContaining({ success: true }) });
  });
});
