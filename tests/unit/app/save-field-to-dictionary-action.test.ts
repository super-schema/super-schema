// @vitest-environment node
import { beforeEach, describe, expect, it, vi } from "vitest";
import { err, ok } from "@/types/result";

const h = vi.hoisted(() => ({
  prisma: { field: { findUnique: vi.fn(), update: vi.fn() }, entity: { findUnique: vi.fn() } },
  activeTenant: vi.fn(),
  create: vi.fn(),
  update: vi.fn(),
  list: vi.fn(),
  listAttrs: vi.fn(),
}));

vi.mock("@/lib/db", () => ({ prisma: h.prisma }));
vi.mock("@/lib/access/principal", async () => (await import("../../helpers/access-mocks")).sessionPrincipalModule);
vi.mock("@/lib/auth", () => ({ auth: vi.fn().mockResolvedValue({ user: { id: "user-1" } }) }));
vi.mock("next/cache", () => ({ revalidatePath: vi.fn() }));
vi.mock("@/lib/active-tenant", () => ({ getActiveTenantId: h.activeTenant }));
vi.mock("@/lib/compiler/typespec-compiler", () => ({ compileTypeSpecWithGovernance: vi.fn() }));
vi.mock("@/services/metadata-rederive.service", async () => (await import("../../helpers/no-derivation")).noDerivationModule);
vi.mock("@/services/field-dictionary.service", () => ({
  createFieldDictionaryEntry: h.create,
  updateFieldDictionaryEntry: h.update,
  listFieldDictionary: h.list,
}));
vi.mock("@/services/metadata-attribute.service", () => ({ listMetadataAttributes: h.listAttrs }));

import { saveFieldToDictionaryAction } from "@/app/(dashboard)/schemas/[domainSlug]/[productSlug]/[entityId]/actions";

const GUARD_ROW = { entity: { tenantId: "tenant-1", domainId: null, productId: null, product: null } };
const FIELD = {
  id: "fld-1", name: "email", type: "string", description: "Customer email", classification: "PII",
  decorators: { typespec: { extensions: { openapi: { "x-securityClassification": { data_class: "class2", data_category: "ConsumerPersonal" } } } } },
};
const DEFS = [{
  key: "x-securityClassification", scope: "schema", derive: { data_class: "{class}" },
  valueSchema: { type: "object", properties: { data_class: { type: "string" }, data_category: { type: "string" } } },
}];
const EXPECTED = {
  name: "email", type: "string", description: "Customer email", classification: "PII",
  attributes: { "x-securityClassification": { data_category: "ConsumerPersonal" } },
};

beforeEach(() => {
  vi.clearAllMocks();
  h.activeTenant.mockResolvedValue("tenant-1");
  h.prisma.field.findUnique.mockImplementation(async (args: { select?: { entity?: unknown } }) => (args.select?.entity ? GUARD_ROW : FIELD));
  h.prisma.field.update.mockResolvedValue({ id: "fld-1" });
  h.listAttrs.mockResolvedValue(ok(DEFS));
});

describe("saveFieldToDictionaryAction", () => {
  it("creates the entry in the guarded tenant and links the field", async () => {
    h.create.mockResolvedValue(ok({ id: "dict-1" }));
    const res = await saveFieldToDictionaryAction("fld-1");
    expect(h.create).toHaveBeenCalledWith("tenant-1", EXPECTED);
    expect(h.prisma.field.update).toHaveBeenCalledWith({ where: { id: "fld-1" }, data: { dictionaryEntryId: "dict-1" } });
    expect(res).toEqual({ success: true, entryId: "dict-1", updated: false });
  });

  it("surfaces an existing name as the update prompt, naming the entry, without writing", async () => {
    h.create.mockResolvedValue(err({ code: "DUPLICATE_NAME", message: "exists" }));
    h.list.mockResolvedValue(ok([{ id: "dict-9", name: "email", aliases: [] }]));
    const res = await saveFieldToDictionaryAction("fld-1");
    expect(res).toEqual({
      needsConfirmation: true, code: "DUPLICATE_NAME", targetName: "email", matchedBy: "name",
      error: 'This updates the dictionary entry "email".',
    });
    expect(h.update).not.toHaveBeenCalled();
    expect(h.prisma.field.update).not.toHaveBeenCalled();
  });

  it("prompts on an ALIAS_CONFLICT, naming the entry that holds the alias", async () => {
    h.create.mockResolvedValue(err({ code: "ALIAS_CONFLICT", message: "alias" }));
    h.list.mockResolvedValue(ok([{ id: "dict-3", name: "contact", aliases: ["Email"] }]));
    const res = await saveFieldToDictionaryAction("fld-1");
    expect(res).toEqual({
      needsConfirmation: true, code: "ALIAS_CONFLICT", targetName: "contact", matchedBy: "alias",
      error: 'This updates the dictionary entry "contact" (matched by alias "email").',
    });
    expect(h.update).not.toHaveBeenCalled();
  });

  it("overwrites the existing entry once confirmed, and links the field", async () => {
    h.list.mockResolvedValue(ok([{ id: "dict-9", name: "email", aliases: [] }]));
    h.update.mockResolvedValue(ok({ id: "dict-9" }));
    const res = await saveFieldToDictionaryAction("fld-1", { overwrite: true });
    expect(h.create).not.toHaveBeenCalled();
    expect(h.update).toHaveBeenCalledWith("tenant-1", "dict-9", EXPECTED);
    expect(h.prisma.field.update).toHaveBeenCalledWith({ where: { id: "fld-1" }, data: { dictionaryEntryId: "dict-9" } });
    expect(res).toEqual({ success: true, entryId: "dict-9", updated: true });
  });

  it("an alias match keeps the target's own name: no name in the patch", async () => {
    h.list.mockResolvedValue(ok([{ id: "dict-3", name: "contact", aliases: ["EMAIL"] }]));
    h.update.mockResolvedValue(ok({ id: "dict-3" }));
    await saveFieldToDictionaryAction("fld-1", { overwrite: true });
    const [, , patch] = h.update.mock.calls[0];
    expect(patch).not.toHaveProperty("name");
    expect(patch).toEqual({ type: "string", description: "Customer email", classification: "PII", attributes: EXPECTED.attributes });
  });

  it("refuses a field outside the active tenant before reading anything", async () => {
    h.activeTenant.mockResolvedValue("tenant-2");
    const res = await saveFieldToDictionaryAction("fld-1");
    expect(res).toMatchObject({ code: "NOT_FOUND" });
    expect(h.create).not.toHaveBeenCalled();
  });
});
