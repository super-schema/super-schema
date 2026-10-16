/**
 * @vitest-environment jsdom
 */
import { afterEach, beforeEach, describe, expect, it, vi, type MockInstance } from "vitest";
import { cleanup, fireEvent, render, screen, waitFor } from "@testing-library/react";
import {
  DomainTabs,
  normalizeDomainTab,
} from "@/app/(dashboard)/schemas/[domainSlug]/domain-tabs";

const nav = vi.hoisted(() => ({
  search: "tab=data-types",
  replace: vi.fn(),
  push: vi.fn(),
}));

const traitActions = vi.hoisted(() => ({ createTraitAction: vi.fn() }));

const actions = vi.hoisted(() => ({
  createSharedEnumAction: vi.fn(),
  updateSharedEnumAction: vi.fn(),
  deleteSharedEnumAction: vi.fn(),
  createCustomScalarAction: vi.fn(),
  deleteCustomScalarAction: vi.fn(),
  createUnionTypeAction: vi.fn(),
  updateUnionTypeAction: vi.fn(),
  deleteUnionTypeAction: vi.fn(),
  createServiceAction: vi.fn(),
  deleteServiceAction: vi.fn(),
  createOperationAction: vi.fn(),
  deleteOperationAction: vi.fn(),
}));

// The app renders these tabs under a QueryClientProvider; here the tree refresh is a no-op.
vi.mock("@/hooks/useDomainsTree", async (importOriginal) => ({
  ...(await importOriginal<typeof import("@/hooks/useDomainsTree")>()),
  useInvalidateDomainsTree: () => vi.fn(),
}));

vi.mock("next/navigation", () => ({
  useRouter: () => ({ push: nav.push, replace: nav.replace, refresh: vi.fn() }),
  useSearchParams: () => new URLSearchParams(nav.search),
  usePathname: () => "/schemas/payments",
}));
vi.mock("@/app/(dashboard)/schemas/[domainSlug]/product-grid", () => ({
  ProductGrid: () => <div>grid</div>,
}));
vi.mock("@/app/(dashboard)/schemas/[domainSlug]/actions", () => actions);
// The Traits tab imports a server-action module that pulls in NextAuth.
vi.mock("@/app/(dashboard)/schemas/trait-actions", () => traitActions);
vi.mock("sonner", () => ({ toast: { error: vi.fn(), success: vi.fn() } }));

const DOMAIN = { id: "d1", name: "Payments", slug: "payments", description: "" };

const INHERITED = [
  {
    label: "From Enterprise",
    href: "/schemas/enterprise?tab=data-types",
    sharedEnums: [{ id: "x", name: "Country", values: ["US"], description: "" }],
    customScalars: [],
    unionTypes: [],
  },
];

function renderTabs(overrides: Partial<React.ComponentProps<typeof DomainTabs>> = {}) {
  return render(
    <DomainTabs
      domain={DOMAIN}
      productGridProps={{} as never}
      dataTypes={{ sharedEnums: [], customScalars: [], unionTypes: [] }}
      inheritedDataTypes={INHERITED}
      services={[]}
      {...overrides}
    />
  );
}

let replaceState: MockInstance<History["replaceState"]>;

beforeEach(() => {
  nav.search = "tab=data-types";
  vi.clearAllMocks();
  replaceState = vi.spyOn(window.history, "replaceState").mockImplementation(() => {});
  actions.createSharedEnumAction.mockResolvedValue({ success: true });
  actions.createServiceAction.mockResolvedValue({ success: true });
});

afterEach(() => {
  cleanup();
  replaceState.mockRestore();
});

describe("normalizeDomainTab", () => {
  it("maps legacy ?tab=types to data-types", () => {
    expect(normalizeDomainTab("types")).toBe("data-types");
  });
  it("keeps known tabs", () => {
    expect(normalizeDomainTab("products")).toBe("products");
    expect(normalizeDomainTab("data-types")).toBe("data-types");
    expect(normalizeDomainTab("apis")).toBe("apis");
    expect(normalizeDomainTab("traits")).toBe("traits");
  });
  it("falls back to products", () => {
    expect(normalizeDomainTab(null)).toBe("products");
    expect(normalizeDomainTab("bogus")).toBe("products");
    expect(normalizeDomainTab("entities")).toBe("products");
  });
});

describe("DomainTabs", () => {
  it("shows Data Types tab with inherited enterprise section", () => {
    renderTabs();
    expect(screen.getByRole("navigation", { name: "Breadcrumb" })).toBeDefined();
    expect(screen.getByRole("tab", { name: "Products" })).toBeDefined();
    expect(screen.getByRole("tab", { name: "Data Types", selected: true })).toBeDefined();
    expect(screen.getByRole("tab", { name: "APIs" })).toBeDefined();
    expect(screen.getByRole("tab", { name: "Message properties" })).toBeDefined();
    // Events live on the product, not the domain.
    expect(screen.queryByRole("tab", { name: "Events" })).toBeNull();
    expect(screen.getByText("From Enterprise")).toBeDefined();
    expect(
      screen.getByRole("link", { name: /From Enterprise/ }).getAttribute("href")
    ).toBe("/schemas/enterprise?tab=data-types");
    // Inherited items are listed read-only: no delete affordance for them.
    expect(screen.getByText("Country")).toBeDefined();
  });

  it("defaults to the Products tab and renders the product grid", () => {
    nav.search = "";
    renderTabs();
    expect(screen.getByRole("tab", { name: "Products", selected: true })).toBeDefined();
    expect(screen.getByText("grid")).toBeDefined();
    expect(screen.queryByTestId("domain-types-tab")).toBeNull();
  });

  it("treats legacy ?tab=types as Data Types", () => {
    nav.search = "tab=types";
    renderTabs();
    expect(screen.getByRole("tab", { name: "Data Types", selected: true })).toBeDefined();
  });

  it("selects the APIs tab from ?tab=apis", () => {
    nav.search = "tab=apis";
    renderTabs();
    expect(screen.getByRole("tab", { name: "APIs", selected: true })).toBeDefined();
    expect(screen.getByTestId("domain-apis-tab")).toBeDefined();
  });

  it("renders the domain header once, above the tabs", () => {
    renderTabs();
    expect(screen.getAllByRole("heading", { level: 1, name: "Payments" })).toHaveLength(1);
  });

  it("syncs the selected tab to ?tab= via history.replaceState, without a server round trip", () => {
    renderTabs();
    fireEvent.click(screen.getByRole("tab", { name: "APIs" }));
    expect(replaceState).toHaveBeenCalledWith(null, "", "/schemas/payments?tab=apis");
    expect(screen.getByRole("tab", { name: "APIs", selected: true })).toBeDefined();

    fireEvent.click(screen.getByRole("tab", { name: "Products" }));
    expect(replaceState).toHaveBeenLastCalledWith(null, "", "/schemas/payments");
    expect(nav.replace).not.toHaveBeenCalled();
    expect(nav.push).not.toHaveBeenCalled();
  });

  it("hides an inherited group that has no items", () => {
    renderTabs({
      inheritedDataTypes: [
        { label: "From Enterprise", href: "/schemas/enterprise?tab=data-types", sharedEnums: [], customScalars: [], unionTypes: [] },
      ],
    });
    expect(screen.queryByText("From Enterprise")).toBeNull();
  });

  it("selects the Message properties tab from ?tab=traits and lists own and inherited sets read-only", () => {
    nav.search = "tab=traits";
    renderTabs({
      traits: {
        own: [{ id: "t1", name: "Retry", kind: "OPERATION", summary: "", updatedAt: "", href: "/schemas/payments/traits/t1" }],
        inherited: [
          {
            label: "From Enterprise",
            href: "/schemas/enterprise?tab=traits",
            traits: [{ id: "t2", name: "CloudEvents", kind: "MESSAGE", summary: "", updatedAt: "", href: "/schemas/enterprise/traits/t2" }],
          },
        ],
      },
    });
    expect(screen.getByRole("tab", { name: "Message properties", selected: true })).toBeDefined();
    expect(screen.getByRole("link", { name: /Retry/ }).getAttribute("href")).toBe("/schemas/payments/traits/t1");
    expect(screen.getByRole("link", { name: "From Enterprise" }).getAttribute("href")).toBe("/schemas/enterprise?tab=traits");
    expect(screen.getByRole("link", { name: /CloudEvents/ }).getAttribute("href")).toBe("/schemas/enterprise/traits/t2");
  });

  it("writes ?tab=traits to the URL when the Message properties tab is picked", () => {
    nav.search = "";
    renderTabs();
    fireEvent.click(screen.getByRole("tab", { name: "Message properties" }));
    expect(replaceState).toHaveBeenLastCalledWith(null, "", "/schemas/payments?tab=traits");
    expect(screen.getByTestId("traits-tab")).toBeDefined();
  });

  it("has no New menu: the domain's tabs carry their own create buttons", () => {
    nav.search = "tab=traits";
    renderTabs();
    expect(screen.queryByTitle("More options")).toBeNull();
    expect(screen.getByTestId("traits-new")).toBeDefined();
  });

  it("creates message properties at the DOMAIN level target from the tab's own button", async () => {
    nav.search = "tab=traits";
    traitActions.createTraitAction.mockResolvedValue({ success: true, data: { id: "t9" } });
    renderTabs();
    fireEvent.click(screen.getByTestId("traits-new"));
    fireEvent.change(screen.getByLabelText("Name"), { target: { value: "Retry" } });
    fireEvent.click(screen.getByRole("button", { name: "Create" }));
    await waitFor(() => expect(nav.push).toHaveBeenCalledWith("/schemas/payments/traits/t9"));
    expect(traitActions.createTraitAction).toHaveBeenCalledWith(
      { level: "DOMAIN", domainId: "d1" },
      { name: "Retry", kind: "MESSAGE" }
    );
  });

  it("creates data types at the DOMAIN level target", async () => {
    renderTabs();
    fireEvent.click(screen.getByRole("button", { name: /New Enum/ }));
    fireEvent.change(screen.getByPlaceholderText("EnumName"), { target: { value: "Currency" } });
    fireEvent.change(screen.getByPlaceholderText("Value1, Value2, Value3"), { target: { value: "USD, EUR" } });
    fireEvent.click(screen.getByRole("button", { name: "Create" }));
    await waitFor(() => expect(actions.createSharedEnumAction).toHaveBeenCalledTimes(1));
    expect(actions.createSharedEnumAction).toHaveBeenCalledWith(
      "d1",
      { name: "Currency", values: ["USD", "EUR"] },
      { level: "DOMAIN", domainId: "d1" }
    );
  });

  it("creates API services at the DOMAIN level target", async () => {
    nav.search = "tab=apis";
    renderTabs();
    fireEvent.click(screen.getByRole("button", { name: /New Service/ }));
    // No entities are offered at domain level, so entity-scoped APIs are not selectable.
    expect(screen.queryByText("Entity-scoped")).toBeNull();
    expect(screen.queryByText("Entity APIs")).toBeNull();
    fireEvent.change(screen.getByPlaceholderText("Service name"), { target: { value: "Payments API" } });
    fireEvent.click(screen.getByRole("button", { name: "Create Service" }));
    await waitFor(() => expect(actions.createServiceAction).toHaveBeenCalledTimes(1));
    expect(actions.createServiceAction).toHaveBeenCalledWith(
      "d1",
      { name: "Payments API", basePath: "/", scope: "DOMAIN", entityId: undefined },
      { level: "DOMAIN", domainId: "d1" }
    );
  });
});
