// @vitest-environment node
import { beforeEach, describe, expect, it, vi } from "vitest";
import { signInAs, signedOut, tenantMember } from "../../helpers/access-mocks";

const h = vi.hoisted(() => {
  const fn = () => vi.fn();
  return {
    activeTenant: fn(), revalidatePath: fn(), withAudit: fn(),
    listFields: fn(), usage: fn(), usageCounts: fn(), createField: fn(), updateField: fn(), deleteField: fn(),
    listAttrs: fn(), createAttr: fn(), updateAttr: fn(), deleteAttr: fn(),
    install: fn(), uninstall: fn(), installed: fn(), rederive: fn(),
  };
});

vi.mock("next/cache", () => ({ revalidatePath: h.revalidatePath }));
vi.mock("@/lib/auth", () => ({ auth: vi.fn() }));
vi.mock("@/lib/db", () => ({ prisma: { tag: "prisma" } }));
vi.mock("@/lib/access/principal", async () => (await import("../../helpers/access-mocks")).principalModule);
vi.mock("@/lib/active-tenant", () => ({ getActiveTenantId: h.activeTenant }));
vi.mock("@/lib/audit", () => ({ withAudit: h.withAudit, AuditUserMissingError: class extends Error {} }));
vi.mock("@/services/field-dictionary.service", () => ({
  listFieldDictionary: h.listFields, dictionaryUsage: h.usage, dictionaryUsageCounts: h.usageCounts, createFieldDictionaryEntry: h.createField, updateFieldDictionaryEntry: h.updateField, deleteFieldDictionaryEntry: h.deleteField,
}));
vi.mock("@/services/metadata-attribute.service", () => ({
  listMetadataAttributes: h.listAttrs, createMetadataAttribute: h.createAttr, updateMetadataAttribute: h.updateAttr, deleteMetadataAttribute: h.deleteAttr,
}));
vi.mock("@/services/metadata-pack.service", () => ({ installMetadataPack: h.install, uninstallMetadataPack: h.uninstall, installedPacks: h.installed }));
vi.mock("@/services/metadata-rederive.service", () => ({ rederiveTenant: h.rederive }));

import * as actions from "@/app/(dashboard)/admin/settings/dictionaries/actions";

const T = "tenant-1";
const GENERIC_FORBIDDEN = "You do not have permission to do this";
const effects = [h.listFields, h.usage, h.usageCounts, h.createField, h.updateField, h.deleteField, h.listAttrs, h.createAttr, h.updateAttr, h.deleteAttr, h.install, h.uninstall, h.installed, h.rederive, h.withAudit];

const CALLS: [string, () => Promise<unknown>][] = [
  ["overview", () => actions.dictionariesOverviewAction()],
  ["fieldUsage", () => actions.fieldEntryUsageAction("f1")],
  ["createField", () => actions.createFieldEntryAction({ name: "a" })],
  ["updateField", () => actions.updateFieldEntryAction("f1", {})],
  ["deleteField", () => actions.deleteFieldEntryAction("f1")],
  ["createAttr", () => actions.createAttributeAction({ key: "x-a" })],
  ["updateAttr", () => actions.updateAttributeAction("a1", {})],
  ["deleteAttr", () => actions.deleteAttributeAction("a1")],
  ["install", () => actions.installPackAction("paypal-security-classification")],
  ["uninstall", () => actions.uninstallPackAction("paypal-security-classification")],
];

beforeEach(() => {
  vi.clearAllMocks();
  h.activeTenant.mockResolvedValue(T);
  h.withAudit.mockImplementation(async (p: { fn: () => Promise<unknown> }) => p.fn());
  h.rederive.mockResolvedValue(0);
});

describe("dictionary admin actions: authorization", () => {
  it.each(CALLS)("%s refuses a non-admin before reaching any service", async (_label, call) => {
    for (const role of ["VIEWER", "AUTHOR", "STEWARD"] as const) {
      signInAs(tenantMember(role, T));
      expect(await call()).toEqual({ error: GENERIC_FORBIDDEN });
    }
    signInAs(tenantMember("ADMIN", "tenant-2"));
    expect(await call()).toMatchObject({ error: expect.any(String) });
    signedOut();
    expect(await call()).toMatchObject({ error: expect.any(String) });
    expect(effects.filter((e) => e.mock.calls.length > 0)).toEqual([]);
  });
});

describe("dictionary admin actions: behavior", () => {
  beforeEach(() => signInAs(tenantMember("ADMIN", T)));

  it("audits a field entry creation under the acting tenant", async () => {
    h.createField.mockResolvedValue({ success: true, data: { id: "f1", name: "a" } });
    expect(await actions.createFieldEntryAction({ name: "a" })).toEqual({ data: { id: "f1", name: "a" } });
    expect(h.createField).toHaveBeenCalledWith(T, { name: "a" });
    expect(h.withAudit).toHaveBeenCalledWith(expect.objectContaining({ action: "CREATE", entityType: "FieldDictionaryEntry", tenantId: T, userId: "member-1" }));
  });

  it("returns a field entry's usage rows under the acting tenant, and the service message when it refuses", async () => {
    const rows = [{ fieldId: "x", fieldName: "email", entityId: "e", entityName: "Customer", entitySlug: "customer", domainSlug: null, productSlug: null, drift: ["type"] }];
    h.usage.mockResolvedValueOnce({ success: true, data: rows });
    expect(await actions.fieldEntryUsageAction("f1")).toEqual({ data: rows });
    expect(h.usage).toHaveBeenCalledWith(T, "f1");
    h.usage.mockResolvedValueOnce({ success: false, error: { code: "NOT_FOUND", message: "gone" } });
    expect(await actions.fieldEntryUsageAction("f2")).toEqual({ error: "gone" });
  });

  it("returns the service message and writes no audit entry when the service refuses", async () => {
    h.withAudit.mockImplementation(async (p: { fn: () => Promise<unknown> }) => p.fn());
    h.createField.mockResolvedValue({ success: false, error: { code: "DUPLICATE_NAME", message: "exists" } });
    expect(await actions.createFieldEntryAction({ name: "a" })).toEqual({ error: "exists" });
  });

  it("never passes a user-supplied pack on creation, and re-derives the tenant", async () => {
    h.createAttr.mockResolvedValue({ success: true, data: { id: "a1" } });
    await actions.createAttributeAction({ key: "x-a", label: "A", pack: "paypal-security-classification" });
    expect(h.createAttr).toHaveBeenCalledWith(T, expect.objectContaining({ key: "x-a", pack: null }));
    expect(h.rederive).toHaveBeenCalledWith(T);
  });

  it("never passes a pack in an update patch", async () => {
    h.updateAttr.mockResolvedValue({ success: true, data: { id: "a1" } });
    await actions.updateAttributeAction("a1", { label: "B", pack: "paypal-security-classification" });
    expect(h.updateAttr.mock.calls[0][2]).toEqual({ label: "B" });
  });

  it("audits pack install and uninstall", async () => {
    h.install.mockResolvedValue({ success: true, data: { id: "paypal-security-classification", keys: [] } });
    h.uninstall.mockResolvedValue({ success: true, data: { id: "paypal-security-classification", removed: 1 } });
    await actions.installPackAction("paypal-security-classification");
    await actions.uninstallPackAction("paypal-security-classification");
    expect(h.withAudit.mock.calls.map((c) => c[0].action)).toEqual(["INSTALL_PACK", "UNINSTALL_PACK"]);
  });

  it("rejects an unknown pack id without touching a service", async () => {
    expect(await actions.installPackAction("nope")).toEqual({ error: "Unknown pack" });
    expect(h.install).not.toHaveBeenCalled();
  });
});
