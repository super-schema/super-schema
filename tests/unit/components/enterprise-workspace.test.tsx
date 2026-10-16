/**
 * @vitest-environment jsdom
 */
import { afterEach, beforeEach, describe, expect, it, vi, type MockInstance } from "vitest";
import { cleanup, fireEvent, render, screen, waitFor, within } from "@testing-library/react";
import {
  EnterpriseWorkspace,
  normalizeEnterpriseTab,
} from "@/app/(dashboard)/schemas/enterprise/enterprise-workspace";

const nav = vi.hoisted(() => ({
  search: "",
  push: vi.fn(),
  replace: vi.fn(),
}));

const actions = vi.hoisted(() => ({
  createSharedEnumAction: vi.fn(),
  updateSharedEnumAction: vi.fn(),
  deleteSharedEnumAction: vi.fn(),
  createCustomScalarAction: vi.fn(),
  deleteCustomScalarAction: vi.fn(),
  createUnionTypeAction: vi.fn(),
  updateUnionTypeAction: vi.fn(),
  deleteUnionTypeAction: vi.fn(),
}));

// The app renders these tabs under a QueryClientProvider; here the tree refresh is a no-op.
vi.mock("@/hooks/useDomainsTree", async (importOriginal) => ({
  ...(await importOriginal<typeof import("@/hooks/useDomainsTree")>()),
  useInvalidateDomainsTree: () => vi.fn(),
}));

vi.mock("next/navigation", () => ({
  useRouter: () => ({ push: nav.push, replace: nav.replace, refresh: vi.fn() }),
  useSearchParams: () => new URLSearchParams(nav.search),
}));
const traitActions = vi.hoisted(() => ({ createTraitAction: vi.fn() }));

vi.mock("@/app/(dashboard)/schemas/[domainSlug]/actions", () => actions);
// The Traits tab imports a server-action module that pulls in NextAuth.
vi.mock("@/app/(dashboard)/schemas/trait-actions", () => traitActions);
vi.mock("sonner", () => ({ toast: { error: vi.fn(), success: vi.fn() } }));

const ENTITY = {
  id: "ent-1",
  name: "Customer",
  slug: "customer",
  description: "Shared customer",
  status: "ACTIVE",
  version: 1,
  fieldCount: 3,
  updatedAt: new Date("2026-10-01T00:00:00Z"),
  classifications: { NEVER_STORED: 0, PII: 1, SENSITIVE: 0, INTERNAL: 0, PUBLIC: 2 },
};

const COUNTRY_ENUM = { id: "enum-1", name: "Country", values: ["US", "CA"], description: "" };

function renderWorkspace(overrides: Partial<React.ComponentProps<typeof EnterpriseWorkspace>> = {}) {
  return render(
    <EnterpriseWorkspace
      tenantId="tenant-1"
      entities={[ENTITY]}
      dataTypes={{ sharedEnums: [COUNTRY_ENUM], customScalars: [], unionTypes: [] }}
      {...overrides}
    />
  );
}

let replaceState: MockInstance<History["replaceState"]>;

beforeEach(() => {
  nav.search = "";
  vi.clearAllMocks();
  replaceState = vi.spyOn(window.history, "replaceState").mockImplementation(() => {});
  actions.createSharedEnumAction.mockResolvedValue({ success: true });
});

afterEach(() => {
  cleanup();
  replaceState.mockRestore();
});

describe("normalizeEnterpriseTab", () => {
  it("maps the legacy ?tab=types to data-types", () => {
    expect(normalizeEnterpriseTab("types", "entities")).toBe("data-types");
  });
  it("keeps known tabs", () => {
    expect(normalizeEnterpriseTab("data-types", "entities")).toBe("data-types");
    expect(normalizeEnterpriseTab("entities", "data-types")).toBe("entities");
    expect(normalizeEnterpriseTab("traits", "entities")).toBe("traits");
  });
  it("falls back to the supplied default for a missing or unknown value", () => {
    expect(normalizeEnterpriseTab(null, "entities")).toBe("entities");
    expect(normalizeEnterpriseTab(null, "data-types")).toBe("data-types");
    expect(normalizeEnterpriseTab("apis", "data-types")).toBe("data-types");
  });
});

describe("EnterpriseWorkspace tabs", () => {
  it("offers Entities, Data Types and Message properties only (no APIs or Events tab)", () => {
    renderWorkspace();
    expect(screen.getAllByRole("tab").map((t) => t.textContent)).toEqual(["Entities", "Data Types", "Message properties"]);
    expect(screen.queryByRole("tab", { name: "APIs" })).toBeNull();
    expect(screen.queryByRole("tab", { name: "Events" })).toBeNull();
    expect(screen.getByText("Entities, data types and message properties shared across every domain.")).toBeDefined();
  });

  it("defaults to Entities when Enterprise entities exist", () => {
    renderWorkspace();
    expect(screen.getByRole("tab", { name: "Entities", selected: true })).toBeDefined();
    expect(screen.getByText("Customer")).toBeDefined();
  });

  it("defaults to Data Types when there are no Enterprise entities", () => {
    renderWorkspace({ entities: [] });
    expect(screen.getByRole("tab", { name: "Data Types", selected: true })).toBeDefined();
    expect(screen.getByText("Country")).toBeDefined();
  });

  it("treats legacy ?tab=types as Data Types even when entities exist", () => {
    nav.search = "tab=types";
    renderWorkspace();
    expect(screen.getByRole("tab", { name: "Data Types", selected: true })).toBeDefined();
  });

  it("follows ?tab= changes after mount", () => {
    nav.search = "tab=entities";
    const { rerender } = renderWorkspace();
    expect(screen.getByRole("tab", { name: "Entities", selected: true })).toBeDefined();

    nav.search = "tab=data-types";
    rerender(
      <EnterpriseWorkspace
        tenantId="tenant-1"
        entities={[ENTITY]}
        dataTypes={{ sharedEnums: [COUNTRY_ENUM], customScalars: [], unionTypes: [] }}
      />
    );
    expect(screen.getByRole("tab", { name: "Data Types", selected: true })).toBeDefined();
  });

  it("writes the URL on every tab change, for every tab", () => {
    renderWorkspace({ entities: [] });
    fireEvent.click(screen.getByRole("tab", { name: "Entities" }));
    expect(replaceState).toHaveBeenCalledWith(null, "", "/schemas/enterprise?tab=entities");
    expect(screen.getByRole("tab", { name: "Entities", selected: true })).toBeDefined();

    fireEvent.click(screen.getByRole("tab", { name: "Data Types" }));
    expect(replaceState).toHaveBeenLastCalledWith(null, "", "/schemas/enterprise?tab=data-types");

    fireEvent.click(screen.getByRole("tab", { name: "Message properties" }));
    expect(replaceState).toHaveBeenLastCalledWith(null, "", "/schemas/enterprise?tab=traits");
    expect(screen.getByRole("tab", { name: "Message properties", selected: true })).toBeDefined();
    expect(nav.replace).not.toHaveBeenCalled();
  });

  it("opens the Message properties tab from ?tab=traits and lists the Enterprise sets", () => {
    nav.search = "tab=traits";
    renderWorkspace({
      traits: {
        own: [{ id: "t1", name: "CloudEvents", kind: "MESSAGE", summary: "", updatedAt: "", href: "/schemas/enterprise/traits/t1" }],
        inherited: [],
      },
    });
    expect(screen.getByRole("tab", { name: "Message properties", selected: true })).toBeDefined();
    expect(screen.getByRole("link", { name: /CloudEvents/ }).getAttribute("href")).toBe("/schemas/enterprise/traits/t1");
  });

  it("shows an empty Message properties tab when no data was loaded", () => {
    nav.search = "tab=traits";
    renderWorkspace();
    expect(screen.getByTestId("traits-empty")).toBeDefined();
  });
});

describe("EnterpriseWorkspace entities", () => {
  it("links each entity card to its tenant entity route", () => {
    renderWorkspace();
    const link = screen.getByRole("link", { name: /Customer/ });
    expect(link.getAttribute("href")).toBe("/schemas/enterprise/entities/customer");
  });

  it("shows an empty state with a New Entity call to action", () => {
    renderWorkspace({ entities: [] });
    fireEvent.click(screen.getByRole("tab", { name: "Entities" }));
    expect(screen.getByText(/No Enterprise entities yet/)).toBeDefined();
  });
});

describe("EnterpriseWorkspace New menu", () => {
  function openMenu() {
    fireEvent.click(screen.getByTitle("More options"));
    return screen.getByRole("menu");
  }

  it("offers exactly New Entity, New Custom Data Type and New Message Properties", () => {
    renderWorkspace();
    const items = within(openMenu()).getAllByRole("menuitem");
    expect(items.map((i) => i.querySelector(".text-body-small")?.textContent)).toEqual([
      "New Entity",
      "New Custom Data Type",
      "New Message Properties",
    ]);
    // Events kinds and APIs are not Enterprise-level assets.
    for (const label of ["New API", "New Event Spec", "New Message", "New Channel"]) {
      expect(screen.queryByText(label)).toBeNull();
    }
  });

  it("New Entity navigates to the enterprise new-entity page", () => {
    renderWorkspace();
    fireEvent.click(within(openMenu()).getByRole("menuitem", { name: /New Entity/ }));
    expect(nav.push).toHaveBeenCalledWith("/schemas/enterprise/new");
  });

  it("New Custom Data Type switches to Data Types and opens the kind chooser", () => {
    renderWorkspace();
    fireEvent.click(within(openMenu()).getByRole("menuitem", { name: /New Custom Data Type/ }));
    expect(replaceState).toHaveBeenCalledWith(null, "", "/schemas/enterprise?tab=data-types");
    expect(screen.getByRole("tab", { name: "Data Types", selected: true })).toBeDefined();
    expect(screen.getByTestId("type-kind-chooser")).toBeDefined();
  });

  it("New Message Properties switches to the Message properties tab, opens the form and creates at the TENANT level target", async () => {
    traitActions.createTraitAction.mockResolvedValue({ success: true, data: { id: "t9" } });
    renderWorkspace();
    fireEvent.click(within(openMenu()).getByRole("menuitem", { name: /New Message Properties/ }));
    expect(replaceState).toHaveBeenCalledWith(null, "", "/schemas/enterprise?tab=traits");
    expect(screen.getByRole("tab", { name: "Message properties", selected: true })).toBeDefined();
    expect(screen.getByTestId("new-trait-form")).toBeDefined();
    expect(screen.queryByRole("menu")).toBeNull();

    fireEvent.change(screen.getByLabelText("Name"), { target: { value: "CloudEvents" } });
    fireEvent.click(screen.getByRole("button", { name: "Create" }));
    await waitFor(() => expect(nav.push).toHaveBeenCalledWith("/schemas/enterprise/traits/t9"));
    expect(traitActions.createTraitAction).toHaveBeenCalledWith(
      { level: "TENANT", tenantId: "tenant-1" },
      { name: "CloudEvents", kind: "MESSAGE" }
    );
  });

  it("New Message Properties works again after the form was cancelled", () => {
    renderWorkspace();
    fireEvent.click(within(openMenu()).getByRole("menuitem", { name: /New Message Properties/ }));
    fireEvent.click(within(screen.getByTestId("new-trait-form")).getByRole("button", { name: "Cancel" }));
    expect(screen.queryByTestId("new-trait-form")).toBeNull();
    fireEvent.click(within(openMenu()).getByRole("menuitem", { name: /New Message Properties/ }));
    expect(screen.getByTestId("new-trait-form")).toBeDefined();
  });
});

describe("EnterpriseWorkspace data types", () => {
  it("creates data types at the TENANT level target (no domain)", async () => {
    nav.search = "tab=data-types";
    renderWorkspace();
    fireEvent.click(screen.getByRole("button", { name: /New Enum/ }));
    fireEvent.change(screen.getByPlaceholderText("EnumName"), { target: { value: "Currency" } });
    fireEvent.change(screen.getByPlaceholderText("Value1, Value2, Value3"), { target: { value: "USD, EUR" } });
    fireEvent.click(screen.getByRole("button", { name: "Create" }));
    await waitFor(() => expect(actions.createSharedEnumAction).toHaveBeenCalledTimes(1));
    expect(actions.createSharedEnumAction).toHaveBeenCalledWith(
      null,
      { name: "Currency", values: ["USD", "EUR"] },
      { level: "TENANT", tenantId: "tenant-1" }
    );
  });
});
