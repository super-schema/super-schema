// @vitest-environment jsdom
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { cleanup, fireEvent, render, screen, waitFor, within } from "@testing-library/react";
import "@testing-library/jest-dom/vitest";
import { signInAs, tenantMember } from "../../helpers/access-mocks";

const h = vi.hoisted(() => ({
  activeTenant: vi.fn(),
  overview: vi.fn(),
  install: vi.fn(),
  uninstall: vi.fn(),
  createAttr: vi.fn(),
  usage: vi.fn(),
}));

vi.mock("@/lib/auth", () => ({ auth: vi.fn() }));
vi.mock("@/lib/db", () => ({ prisma: {} }));
vi.mock("@/lib/access/principal", async () => (await import("../../helpers/access-mocks")).principalModule);
vi.mock("next/navigation", () => ({ redirect: vi.fn(), usePathname: () => "/admin/settings/dictionaries", useRouter: () => ({ refresh: vi.fn() }) }));
vi.mock("@/lib/active-tenant", async () => {
  const { NO_ACCESS_PATH, isNoTenantAccess } = await import("@/lib/access/no-tenant-access");
  return { requireActiveTenantId: h.activeTenant, NO_ACCESS_PATH, isNoTenantAccess };
});
vi.mock("@/app/(dashboard)/admin/settings/dictionaries/actions", () => ({
  dictionariesOverviewAction: h.overview,
  installPackAction: h.install,
  uninstallPackAction: h.uninstall,
  createAttributeAction: h.createAttr,
  updateAttributeAction: vi.fn(),
  deleteAttributeAction: vi.fn(),
  createFieldEntryAction: vi.fn(),
  updateFieldEntryAction: vi.fn(),
  deleteFieldEntryAction: vi.fn(),
  fieldEntryUsageAction: h.usage,
}));

import DictionariesPage from "@/app/(dashboard)/admin/tenant/dictionaries/page";
import AttributesPage from "@/app/(dashboard)/admin/tenant/attributes/page";
import { PAYPAL_SECURITY_CLASSIFICATION_PACK as SECURITY_PACK } from "@/lib/metadata-attributes/packs/paypal-security-classification";

const PACK_ID = SECURITY_PACK.id;
const pack = (installed: boolean) => ({
  id: PACK_ID,
  name: SECURITY_PACK.name,
  description: "Adds x-securityClassification.",
  keys: ["x-securityClassification"],
  installed,
});
const packRow = {
  id: "a1", tenantId: "tenant-1", key: "x-securityClassification", label: "Security classification", description: "",
  valueSchema: { type: "object" }, targets: ["field"], scope: "schema", placement: "abc-primitive", derive: { data_class: "class{class}" },
  requiredWhen: "primitive", pack: PACK_ID, protobufOptionNumber: null, createdAt: new Date(), updatedAt: new Date(),
};

beforeEach(() => {
  vi.clearAllMocks();
  h.activeTenant.mockResolvedValue("tenant-1");
  h.overview.mockResolvedValue({ data: { fields: [], attributes: [], packs: [pack(false)] } });
});
afterEach(cleanup);

describe("the dictionaries admin page", () => {
  it("shows the no-permission screen to a non-admin and loads nothing", async () => {
    signInAs(tenantMember("AUTHOR", "tenant-1"));
    render(await DictionariesPage());
    expect(screen.getByTestId("admin-no-permission")).toBeInTheDocument();
    expect(h.overview).not.toHaveBeenCalled();
    expect(screen.queryByRole("tab", { name: "Fields" })).toBeNull();
  });

  it("shows tenant attributes to an admin, installs the pack and marks it Installed with the entry read-only", async () => {
    signInAs(tenantMember("ADMIN", "tenant-1"));
    h.install.mockResolvedValue({ data: { id: PACK_ID, keys: ["x-securityClassification"] } });
    render(await AttributesPage());
    expect(screen.getByRole("heading", { name: "Custom attributes" })).toBeInTheDocument();

    const packs = screen.getByRole("region", { name: "Packs" });
    expect(within(packs).queryByText("Installed")).toBeNull();
    expect(within(packs).getByRole("button", { name: "Install Security classification" })).toBeInTheDocument();

    h.overview.mockResolvedValue({ data: { fields: [], attributes: [packRow], packs: [pack(true)] } });
    fireEvent.click(within(packs).getByRole("button", { name: /^Install/ }));

    await waitFor(() => expect(h.install).toHaveBeenCalledWith(PACK_ID));
    expect(await within(screen.getByRole("region", { name: "Packs" })).findByText("Installed")).toBeInTheDocument();
    expect(screen.getByText("x-securityClassification")).toBeInTheDocument();
    expect(screen.getByText("Read-only (pack: Security classification)")).toBeInTheDocument();
    expect(screen.queryByRole("button", { name: /Edit x-securityClassification/ })).toBeNull();
    expect(screen.queryByRole("button", { name: /Delete x-securityClassification/ })).toBeNull();
  });

  it("shows a usage count per field entry and a drawer listing the fields with their drift, linked to the field page", async () => {
    signInAs(tenantMember("ADMIN", "tenant-1"));
    const entry = { id: "d1", tenantId: "tenant-1", name: "email", aliases: [], type: "string", description: "", classification: null, attributes: {}, conceptId: null, createdAt: new Date(), updatedAt: new Date() };
    h.overview.mockResolvedValue({ data: { fields: [entry], usage: { d1: 2 }, attributes: [], packs: [] } });
    h.usage.mockResolvedValue({
      data: [
        { fieldId: "f1", fieldName: "email", entityId: "e1", entityName: "Customer", entitySlug: "customer", domainSlug: "pay", productSlug: "core", drift: ["description", "attributes"] },
        { fieldId: "f2", fieldName: "email", entityId: "e2", entityName: "Order", entitySlug: "order", domainSlug: null, productSlug: null, drift: [] },
      ],
    });
    render(await DictionariesPage());
    expect(screen.getByText("2 fields")).toBeInTheDocument();
    fireEvent.click(screen.getByRole("button", { name: "Usage of email" }));
    await waitFor(() => expect(h.usage).toHaveBeenCalledWith("d1"));
    const link = await screen.findByRole("link", { name: /Customer/ });
    expect(link).toHaveAttribute("href", "/schemas/pay/core/customer/fields/f1");
    expect(screen.getByText(/description, attributes/)).toBeInTheDocument();
    expect(screen.getByText("In sync")).toBeInTheDocument();
    expect(screen.getByRole("link", { name: /Order/ })).toHaveAttribute("href", "/schemas/enterprise/entities/order/fields/f2");
  });

  it("shows value-schema errors inline and blocks saving", async () => {
    signInAs(tenantMember("ADMIN", "tenant-1"));
    render(await AttributesPage());
    fireEvent.change(screen.getByLabelText("Value schema (JSON)"), { target: { value: '{"type":"string","oneOf":[]}' } });
    expect(screen.getByRole("alert", { name: "Value schema problems" })).toBeInTheDocument();
    expect(screen.getByRole("button", { name: "Add attribute" })).toBeDisabled();
  });
});
