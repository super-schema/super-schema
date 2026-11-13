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
}));

import DictionariesPage from "@/app/(dashboard)/admin/settings/dictionaries/page";

const PACK_ID = "paypal-security-classification";
const pack = (installed: boolean) => ({
  id: PACK_ID,
  name: "PayPal security classification",
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

  it("shows both tabs to an admin, installs the pack and marks it Installed with the entry read-only", async () => {
    signInAs(tenantMember("ADMIN", "tenant-1"));
    h.install.mockResolvedValue({ data: { id: PACK_ID, keys: ["x-securityClassification"] } });
    render(await DictionariesPage());

    expect(screen.getByRole("tab", { name: "Fields" })).toBeInTheDocument();
    const attrsTab = screen.getByRole("tab", { name: "Metadata attributes" });
    fireEvent.click(attrsTab);

    const packs = screen.getByRole("region", { name: "Packs" });
    expect(within(packs).queryByText("Installed")).toBeNull();

    h.overview.mockResolvedValue({ data: { fields: [], attributes: [packRow], packs: [pack(true)] } });
    fireEvent.click(within(packs).getByRole("button", { name: /^Install/ }));

    await waitFor(() => expect(h.install).toHaveBeenCalledWith(PACK_ID));
    expect(await within(screen.getByRole("region", { name: "Packs" })).findByText("Installed")).toBeInTheDocument();
    expect(screen.getByText("x-securityClassification")).toBeInTheDocument();
    expect(screen.getByText(/Read-only/)).toBeInTheDocument();
    expect(screen.queryByRole("button", { name: /Edit x-securityClassification/ })).toBeNull();
    expect(screen.queryByRole("button", { name: /Delete x-securityClassification/ })).toBeNull();
  });

  it("shows value-schema errors inline and blocks saving", async () => {
    signInAs(tenantMember("ADMIN", "tenant-1"));
    render(await DictionariesPage());
    fireEvent.click(screen.getByRole("tab", { name: "Metadata attributes" }));
    fireEvent.change(screen.getByLabelText("Value schema (JSON)"), { target: { value: '{"type":"string","oneOf":[]}' } });
    expect(screen.getByRole("alert", { name: "Value schema problems" })).toBeInTheDocument();
    expect(screen.getByRole("button", { name: "Add attribute" })).toBeDisabled();
  });
});
