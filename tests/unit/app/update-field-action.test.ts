import { beforeEach, describe, expect, it, vi } from "vitest";

// updateFieldAction (mass-assignment whitelist, active-tenant ownership) and the atomicity of the entity field actions.

const { mockPrisma, mockGetActiveTenantId } = vi.hoisted(() => ({
  mockGetActiveTenantId: vi.fn(),
  mockPrisma: {
    entity: { findUnique: vi.fn(), update: vi.fn() },
    field: { findFirst: vi.fn(), findUnique: vi.fn(), findMany: vi.fn(), create: vi.fn(), update: vi.fn(), delete: vi.fn() },
    auditLog: { create: vi.fn() },
    $executeRawUnsafe: vi.fn(),
    $transaction: vi.fn(),
  },
}));

vi.mock("@/lib/db", () => ({ prisma: mockPrisma }));
vi.mock("@/lib/auth", () => ({ auth: vi.fn().mockResolvedValue({ user: { id: "user-1" } }) }));
vi.mock("next/cache", () => ({ revalidatePath: vi.fn() }));
vi.mock("@/lib/active-tenant", () => ({ getActiveTenantId: mockGetActiveTenantId }));
vi.mock("@/lib/compiler/typespec-compiler", () => ({ compileTypeSpecWithGovernance: vi.fn() }));

import { MARK_DRAFT_CHANGED_SQL } from "@/lib/entity-versioning/draft-state";
import { GENERIC_ACTION_ERROR } from "@/types/action-result";
import {
  addFieldAction,
  deleteFieldAction,
  updateFieldAction,
} from "@/app/(dashboard)/schemas/[domainSlug]/[productSlug]/[entityId]/actions";

const asAny = (v: unknown) => v as never;
const update = (id: unknown, data: unknown) => updateFieldAction(asAny(id), asAny(data));

const OWN_FIELD = { id: "fld-1", entityId: "ent-1", name: "email", slug: "email", type: "string", entity: { tenantId: "tenant-1" } };

beforeEach(() => {
  vi.clearAllMocks();
  mockGetActiveTenantId.mockResolvedValue("tenant-1");
  mockPrisma.auditLog.create.mockResolvedValue({ id: "audit-1" });
  mockPrisma.field.findUnique.mockResolvedValue(OWN_FIELD);
  mockPrisma.field.findFirst.mockResolvedValue(null);
  mockPrisma.field.update.mockResolvedValue({ id: "fld-1" });
  mockPrisma.$transaction.mockImplementation(async (ops: unknown[]) => Promise.all(ops));
});

describe("updateFieldAction whitelist", () => {
  const LEGIT = {
    name: "email_address", type: "string", nullable: false, isKey: true, description: "Primary", classification: "PII",
    precision: null, scale: null, fieldNumber: 7, aliases: ["mail"], decorators: { typespec: {} }, sortOrder: 3,
  };

  it("writes exactly the editable columns (every key the UI sends, incl. sortOrder for reorder) plus the server-derived slug", async () => {
    expect(await update("fld-1", LEGIT)).toEqual({ success: true });
    expect(mockPrisma.field.update).toHaveBeenCalledTimes(1);
    expect(mockPrisma.field.update).toHaveBeenCalledWith({ where: { id: "fld-1" }, data: { ...LEGIT, slug: "email-address" } });
  });

  it("the drag-reorder payload ({ sortOrder }) alone is accepted", async () => {
    expect(await update("fld-1", { sortOrder: 2 })).toEqual({ success: true });
    expect(mockPrisma.field.update).toHaveBeenCalledWith({ where: { id: "fld-1" }, data: { sortOrder: 2 } });
  });

  it.each([
    { entityId: "ent2" },
    { tenantId: "other", domainId: null, productId: null, name: "Taken" },
    { id: "someone-elses" },
    { slug: "hijacked" },
    { createdAt: "2020-01-01T00:00:00.000Z" },
    { updatedAt: "2020-01-01T00:00:00.000Z" },
    { description: "ok", entityId: "ent2" },
    JSON.parse('{"__proto__": {"entityId": "ent2"}}'),
  ])("rejects %j with VALIDATION_ERROR before any read or write", async (attack) => {
    const result = await update("fld-1", attack);
    expect(result).toMatchObject({ code: "VALIDATION_ERROR", error: expect.stringMatching(/not editable/) });
    expect(mockPrisma.field.findUnique).not.toHaveBeenCalled();
    expect(mockPrisma.field.update).not.toHaveBeenCalled();
    expect(mockPrisma.$transaction).not.toHaveBeenCalled();
    expect(mockPrisma.$executeRawUnsafe).not.toHaveBeenCalled();
  });

  it("names the rejected keys (so a mixed payload is not silently half-applied)", async () => {
    const result = (await update("fld-1", { description: "ok", entityId: "ent2" })) as { error: string };
    expect(result.error).toContain("entityId");
    expect(mockPrisma.field.update).not.toHaveBeenCalled();
  });

  it.each([{ name: 5 }, { nullable: "yes" }, { fieldNumber: 1.5 }, { fieldNumber: "7" }, { aliases: "a" }, { aliases: [1] }, { decorators: [] }, { decorators: "x" }, { sortOrder: "0" }, { precision: "2" }])(
    "rejects the wrong value type in %j",
    async (data) => {
      expect(await update("fld-1", data)).toMatchObject({ code: "VALIDATION_ERROR" });
      expect(mockPrisma.field.update).not.toHaveBeenCalled();
    }
  );

  it("rejects a non-object payload and a malformed id", async () => {
    for (const data of [null, undefined, "x", 5, []]) expect(await update("fld-1", data)).toMatchObject({ code: "VALIDATION_ERROR" });
    for (const id of [undefined, null, "", 5, {}]) expect(await update(id, { description: "x" })).toMatchObject({ code: "VALIDATION_ERROR" });
    expect(mockPrisma.field.update).not.toHaveBeenCalled();
  });

  it("answers 'Field not found' (NOT_FOUND) for a field of another tenant, exactly like a missing one", async () => {
    mockPrisma.field.findUnique.mockResolvedValue({ ...OWN_FIELD, entity: { tenantId: "tenant-2" } });
    expect(await update("fld-1", { description: "x" })).toEqual({ error: "Field not found", code: "NOT_FOUND" });
    mockPrisma.field.findUnique.mockResolvedValue(null);
    expect(await update("fld-1", { description: "x" })).toEqual({ error: "Field not found", code: "NOT_FOUND" });
    expect(mockPrisma.field.update).not.toHaveBeenCalled();
    expect(mockPrisma.$transaction).not.toHaveBeenCalled();
  });

  it("keeps the audit before-state a plain field row (the ownership join is not audited)", async () => {
    await update("fld-1", { description: "x" });
    const audit = mockPrisma.auditLog.create.mock.calls[0][0] as { data: { beforeState: Record<string, unknown> } };
    expect(audit.data.beforeState).not.toHaveProperty("entity");
    expect(audit.data.beforeState).toMatchObject({ id: "fld-1", entityId: "ent-1" });
  });

  it("returns the generic message (and no driver text) for an unexpected failure; a duplicate name keeps its own message", async () => {
    const spy = vi.spyOn(console, "error").mockImplementation(() => undefined);
    mockPrisma.$transaction.mockRejectedValue(new Error("connect ECONNREFUSED 10.0.0.5:5432"));
    expect(await update("fld-1", { description: "x" })).toEqual({ error: GENERIC_ACTION_ERROR, code: "INTERNAL_ERROR" });
    mockPrisma.$transaction.mockRejectedValue(new Error("Unique constraint failed on the fields: (`entityId`,`name`)"));
    expect(await update("fld-1", { name: "dup" })).toEqual({ error: "A field with that name already exists" });
    spy.mockRestore();
  });
});

/**
 * Lazy-operation fake (like Prisma's): a write only takes effect when AWAITED, and `$transaction([...])` rolls every effect
 * back when a later operation rejects. A caller that awaited the field write on its own and marked the draft separately would
 * leave the write committed after the mark failed (a changed field with `hasUnpublishedChanges` still false: publish would
 * answer NO_CHANGES).
 */
describe("entity field actions: the field write and the draft mark are one atomic batch", () => {
  let committed: string[];
  const lazy = (label: string, fail = false) =>
    ({
      then: (resolve: (v: unknown) => unknown, reject: (e: unknown) => unknown) =>
        Promise.resolve()
          .then(() => {
            if (fail) throw new Error("connection lost");
            committed.push(label);
            return { id: "fld-1", entityId: "ent-1" };
          })
          .then(resolve, reject),
    }) as unknown as Promise<unknown>;

  beforeEach(() => {
    committed = [];
    mockPrisma.$transaction.mockImplementation(async (ops: Promise<unknown>[]) => {
      const snapshot = [...committed];
      try {
        const out: unknown[] = [];
        for (const op of ops) out.push(await op);
        return out;
      } catch (e) {
        committed.length = 0;
        committed.push(...snapshot);
        throw e;
      }
    });
    mockPrisma.$executeRawUnsafe.mockImplementation(() => lazy("mark", true));
    mockPrisma.field.create.mockImplementation(() => lazy("create-field"));
    mockPrisma.field.update.mockImplementation(() => lazy("update-field"));
    mockPrisma.field.delete.mockImplementation(() => lazy("delete-field"));
  });

  it("addFieldAction: a failing mark rolls the new field back and reports an error", async () => {
    expect(await addFieldAction("ent-1", "phone", "string")).toHaveProperty("error");
    expect(committed).toEqual([]);
  });

  it("updateFieldAction: a failing mark rolls the field change back and reports an error", async () => {
    vi.spyOn(console, "error").mockImplementation(() => undefined);
    expect(await update("fld-1", { description: "x" })).toHaveProperty("error");
    expect(committed).toEqual([]);
  });

  it("deleteFieldAction: a failing mark rolls the delete back and reports an error", async () => {
    expect(await deleteFieldAction("fld-1")).toHaveProperty("error");
    expect(committed).toEqual([]);
  });

  it("on success the write and the mark commit together, in ONE batch, with the mark's SQL for the field's entity", async () => {
    mockPrisma.$executeRawUnsafe.mockImplementation(() => lazy("mark"));
    expect(await update("fld-1", { description: "x" })).toEqual({ success: true });
    expect(committed).toEqual(["update-field", "mark"]);
    expect(mockPrisma.$transaction).toHaveBeenCalledTimes(1);
    expect(mockPrisma.$transaction.mock.calls[0][0]).toHaveLength(2);
    expect(mockPrisma.$executeRawUnsafe).toHaveBeenCalledWith(MARK_DRAFT_CHANGED_SQL, "ent-1");
  });
});

describe("updateFieldAction clears the dangling-reference marker when the field is resolved", () => {
  const DANGLING = { ...OWN_FIELD, type: "reference", decorators: { referencedEntityName: "date_time", danglingRef: { ref: "common/date_time.json" }, semantics: { description: "when" } } };
  const written = () => mockPrisma.field.update.mock.calls[0][0].data as { decorators?: Record<string, unknown> };

  it("a type change away from reference removes the marker and keeps every other decorator", async () => {
    mockPrisma.field.findUnique.mockResolvedValue(DANGLING);
    expect(await update("fld-1", { type: "string" })).toEqual({ success: true });
    expect(written().decorators).toEqual({ referencedEntityName: "date_time", semantics: { description: "when" } });
  });

  it("a changed reference target removes the marker", async () => {
    mockPrisma.field.findUnique.mockResolvedValue(DANGLING);
    await update("fld-1", { decorators: { ...DANGLING.decorators, referencedEntityName: "Customer" } });
    expect(written().decorators).not.toHaveProperty("danglingRef");
  });

  it("an edit that keeps the field the same reference (description only) writes no decorators", async () => {
    mockPrisma.field.findUnique.mockResolvedValue(DANGLING);
    await update("fld-1", { description: "new" });
    expect(written()).not.toHaveProperty("decorators");
  });
});
