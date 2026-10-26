/**
 * FINAL WAVE 2b, G12: the all-targets run (`emitEntity`, behind the entity page's Emit button and Cmd+E) used to drop the closure's
 * structured refusal, so a name that two entities answer to showed only "N targets invalid" and could never open the pick dialog. The
 * refusal now travels with the result (`refusal`), and `pickRequestOfRefusal` says which pick it asks for.
 */
import { describe, it, expect, vi } from "vitest";

const entityRow = { id: "a", tenantId: "t1", name: "Order", description: "", status: "DRAFT", version: 1, domainId: null, metadata: {}, domain: null };
const tenantRows = [
  { ...entityRow, latestVersionId: null, domain: null, product: null },
  { id: "x1", name: "Address", description: "", status: "DRAFT", version: 1, domainId: null, metadata: null, latestVersionId: null, domain: { id: "d1", name: "D1", slug: "d1" }, product: { name: "P1" } },
  { id: "x2", name: "Address", description: "", status: "DRAFT", version: 1, domainId: null, metadata: null, latestVersionId: null, domain: { id: "d2", name: "D2", slug: "d2" }, product: { name: "P2" } },
];

vi.mock("@/lib/db", () => ({
  prisma: {
    entity: {
      findUnique: vi.fn(async () => entityRow),
      findMany: vi.fn(async () => tenantRows),
    },
    field: {
      findMany: vi.fn(async ({ where }: { where: { entityId: string } }) =>
        where.entityId === "a"
          ? [{ id: "a-addr", name: "addr", type: "reference", precision: null, scale: null, nullable: true, isKey: false, fieldNumber: null, description: "", classification: null, aliases: [], decorators: { referencedEntityName: "Address" }, sortOrder: 0 }]
          : []
      ),
    },
    entityVersion: { findUnique: vi.fn(async () => null) },
  },
}));
vi.mock("@/lib/typespec-official/emitter.service", async (importOriginal) => ({
  ...(await importOriginal<typeof import("@/lib/typespec-official/emitter.service")>()),
  emitOfficialTypeSpecTargetFromData: vi.fn(async () => ({ output: "ddl", validationStatus: "VALID", warnings: [], errors: [] })),
}));

import { emitEntity } from "@/lib/emission/emission.service";
import { pickRequestOfRefusal } from "@/lib/emission/closure-generation";

describe("emitEntity carries the closure's refusal", () => {
  it("an ambiguous name: the result has the structured refusal, the closure targets are invalid with its message, the DB targets still emit", async () => {
    const result = await emitEntity("a", () => true);
    expect(result.refusal).toMatchObject({ code: "AMBIGUOUS_REFERENCE", details: { field: "addr", name: "Address", entityId: "a", fieldId: "a-addr" } });
    expect(result.targets["json-schema"]).toMatchObject({ validationStatus: "INVALID", errors: [{ message: result.refusal?.message }] });
    expect(result.targets.postgresql).toMatchObject({ validationStatus: "VALID" });
    expect(result.success).toBe(false);
  });

  it("the pick it asks for is the one a generate answers: the field, the name, the candidates and where the pick is written", async () => {
    const result = await emitEntity("a", () => true);
    expect(pickRequestOfRefusal(result.refusal)).toEqual({
      field: "addr",
      name: "Address",
      candidates: [
        { entityId: "x1", domain: "D1", product: "P1", entity: "Address" },
        { entityId: "x2", domain: "D2", product: "P2", entity: "Address" },
      ],
      entityId: "a",
      fieldId: "a-addr",
    });
  });
});

describe("pickRequestOfRefusal", () => {
  const details = { field: "f", name: "N", candidates: [{ domain: "d", product: "p", entity: "N" }], entityId: "e", fieldId: "i" };
  it("asks for a pick only for an ambiguous reference in content that can be edited", () => {
    expect(pickRequestOfRefusal({ code: "AMBIGUOUS_REFERENCE", message: "m", details })).toEqual(details);
    expect(pickRequestOfRefusal({ code: "AMBIGUOUS_REFERENCE", message: "m", details: { ...details, frozen: true } })).toBeUndefined();
    expect(pickRequestOfRefusal({ code: "NEVER_PUBLISHED", message: "m", details })).toBeUndefined();
    expect(pickRequestOfRefusal({ code: "AMBIGUOUS_REFERENCE", message: "m", details: { field: "f" } })).toBeUndefined();
    expect(pickRequestOfRefusal({ code: "AMBIGUOUS_REFERENCE", message: "m" })).toBeUndefined();
    expect(pickRequestOfRefusal(undefined)).toBeUndefined();
  });
});
