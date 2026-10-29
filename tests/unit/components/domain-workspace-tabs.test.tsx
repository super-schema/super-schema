/**
 * @vitest-environment jsdom
 */
import { QueryClient, QueryClientProvider } from "@tanstack/react-query";
import { afterEach, beforeEach, describe, expect, it, vi, type MockInstance } from "vitest";
import { cleanup, fireEvent, render, screen, waitFor, within } from "@testing-library/react";
import {
  DomainWorkspace,
  normalizeWorkspaceTab,
} from "@/app/(dashboard)/schemas/[domainSlug]/domain-workspace";
import {
  buildProductInheritedDataTypes,
  buildProductInheritedServices,
} from "@/app/(dashboard)/schemas/[domainSlug]/map-asset-rows";
import type { ServiceData } from "@/app/(dashboard)/schemas/[domainSlug]/components/DomainApisTab";
import type { EventListItem } from "@/features/events/event-page/load-events-list";
import { assetHref } from "@/lib/navigation/asset-href";

const nav = vi.hoisted(() => ({
  search: "tab=data-types",
  push: vi.fn(),
  replace: vi.fn(),
}));

const actions = vi.hoisted(() => ({
  createEntityWithFieldsAction: vi.fn(),
  deleteEntityAction: vi.fn(),
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

const eventActions = vi.hoisted(() => ({
  createEventAction: vi.fn(),
}));

vi.mock("next/navigation", () => ({
  useRouter: () => ({ push: nav.push, replace: nav.replace, refresh: vi.fn() }),
  useSearchParams: () => new URLSearchParams(nav.search),
}));

vi.mock("@/app/(dashboard)/schemas/[domainSlug]/actions", () => actions);
vi.mock("@/app/(dashboard)/schemas/actions", () => ({ deleteDomainAction: vi.fn() }));
// The New Event dialog imports a server-action module that pulls in NextAuth; so does the Edit contacts dialog.
vi.mock("@/app/(dashboard)/schemas/[domainSlug]/[productSlug]/event-actions", () => ({ createEventAction: eventActions.createEventAction }));
vi.mock("@/app/(dashboard)/schemas/[domainSlug]/product-actions", () => ({ updateProductAction: vi.fn() }));
vi.mock("sonner", () => ({ toast: { error: vi.fn(), success: vi.fn() } }));
vi.mock("@/components/custom/TypePicker", () => ({ TypePicker: () => <select /> }));
vi.mock("@/components/custom/ClassificationPicker", () => ({ ClassificationPicker: () => null }));

const ENTITY = {
  id: "ent-1",
  name: "Order",
  slug: "order",
  description: "",
  status: "DRAFT",
  version: 1,
  fieldCount: 0,
  updatedAt: new Date("2026-10-01T00:00:00Z"),
  classifications: { NEVER_STORED: 0, PII: 0, SENSITIVE: 0, INTERNAL: 0, PUBLIC: 0 },
};

const BASE_PROPS = {
  domainId: "dom-1",
  domainName: "Payments",
  domainSlug: "payments",
  productId: "prod-1",
  productSlug: "checkout",
  productName: "Checkout",
  domainDescription: "",
  domainPolicy: null,
  entities: [ENTITY],
  sharedEnums: [],
  customScalars: [],
  unionTypes: [],
  services: [],
};

const NO_TYPES = { sharedEnums: [], customScalars: [], unionTypes: [] };
const PRODUCT_TARGET = { level: "PRODUCT", productId: "prod-1" };

function domainService(over: Partial<ServiceData> = {}): ServiceData {
  return {
    id: "svc-d",
    name: "PaymentsCore",
    description: "",
    basePath: "/core",
    scope: "DOMAIN",
    entity: null,
    operations: [
      {
        id: "op-1",
        name: "listPayments",
        httpMethod: "GET",
        httpPath: "/payments",
        description: "",
        parameters: [],
        responses: [],
      },
    ],
    ...over,
  };
}

const queryClient = new QueryClient({ defaultOptions: { queries: { retry: false } } });

function workspaceTree(overrides: Partial<React.ComponentProps<typeof DomainWorkspace>> = {}) {
  return (
    <QueryClientProvider client={queryClient}>
      <DomainWorkspace {...BASE_PROPS} {...overrides} />
    </QueryClientProvider>
  );
}

function renderWorkspace(overrides: Partial<React.ComponentProps<typeof DomainWorkspace>> = {}) {
  return render(workspaceTree(overrides));
}

function installLocalStorage(initial: Record<string, string> = {}) {
  const store = new Map<string, string>(Object.entries(initial));
  Object.defineProperty(globalThis, "localStorage", {
    value: {
      getItem: (key: string) => store.get(key) ?? null,
      setItem: (key: string, value: string) => void store.set(key, value),
      removeItem: (key: string) => void store.delete(key),
      clear: () => store.clear(),
      key: (index: number) => Array.from(store.keys())[index] ?? null,
      get length() {
        return store.size;
      },
    } satisfies Storage,
    configurable: true,
  });
}

function openNewMenu() {
  fireEvent.click(screen.getByTitle("More options"));
  return screen.getByRole("menu");
}

let replaceState: MockInstance<History["replaceState"]>;

beforeEach(() => {
  nav.search = "tab=data-types";
  installLocalStorage();
  vi.clearAllMocks();
  replaceState = vi.spyOn(window.history, "replaceState").mockImplementation(() => {});
  actions.createSharedEnumAction.mockResolvedValue({ success: true });
  actions.createCustomScalarAction.mockResolvedValue({ success: true });
  actions.createUnionTypeAction.mockResolvedValue({ success: true });
  actions.createServiceAction.mockResolvedValue({ success: true });
});

afterEach(() => {
  cleanup();
  replaceState.mockRestore();
});

describe("normalizeWorkspaceTab", () => {
  it("maps legacy ?tab=types to data-types", () => {
    expect(normalizeWorkspaceTab("types")).toBe("data-types");
  });
  it("keeps known tabs", () => {
    expect(normalizeWorkspaceTab("apis")).toBe("apis");
    expect(normalizeWorkspaceTab("data-types")).toBe("data-types");
    expect(normalizeWorkspaceTab("entities")).toBe("entities");
    expect(normalizeWorkspaceTab("events")).toBe("events");
  });
  it("maps the retired product ?tab=traits to events, where traits now live inside each event", () => {
    expect(normalizeWorkspaceTab("traits")).toBe("events");
  });
  it("falls back to entities", () => {
    expect(normalizeWorkspaceTab(null)).toBe("entities");
    expect(normalizeWorkspaceTab("bogus")).toBe("entities");
  });
});

describe("product inherited groups", () => {
  const lists = {
    sharedEnums: [{ id: "e1", name: "Country", values: ["US"], description: "" }],
    customScalars: [],
    unionTypes: [],
  };

  it("links From Domain and From Enterprise through assetHref", () => {
    const groups = buildProductInheritedDataTypes({
      domainSlug: "payments",
      domain: lists,
      enterprise: lists,
    });
    expect(groups.map((g) => [g.label, g.href])).toEqual([
      ["From Domain", "/schemas/payments?tab=data-types"],
      ["From Enterprise", "/schemas/enterprise?tab=data-types"],
    ]);
  });

  it("omits a group whose lists are empty", () => {
    const groups = buildProductInheritedDataTypes({
      domainSlug: "payments",
      domain: NO_TYPES,
      enterprise: lists,
    });
    expect(groups.map((g) => g.label)).toEqual(["From Enterprise"]);
  });

  it("links domain-level services to the domain APIs tab and omits the group when empty", () => {
    const groups = buildProductInheritedServices({
      domainSlug: "payments",
      domain: [domainService()],
    });
    expect(groups.map((g) => [g.label, g.href])).toEqual([
      ["From Domain", "/schemas/payments?tab=apis"],
    ]);
    expect(buildProductInheritedServices({ domainSlug: "payments", domain: [] })).toEqual([]);
  });
});

describe("DomainWorkspace — inherited data types", () => {
  const inherited = buildProductInheritedDataTypes({
    domainSlug: "payments",
    domain: { ...NO_TYPES, sharedEnums: [{ id: "e1", name: "Currency", values: ["USD"], description: "" }] },
    enterprise: {
      ...NO_TYPES,
      customScalars: [
        { id: "s1", name: "Email", baseType: "string", format: "email", pattern: "^.+@.+$", description: "" },
      ],
    },
  });

  it("shows From Domain and From Enterprise sections with links to their source", () => {
    renderWorkspace({ inheritedDataTypes: inherited });
    expect(screen.getByRole("link", { name: "From Domain" }).getAttribute("href")).toBe(
      "/schemas/payments?tab=data-types"
    );
    expect(screen.getByRole("link", { name: "From Enterprise" }).getAttribute("href")).toBe(
      "/schemas/enterprise?tab=data-types"
    );
    expect(screen.getByText("Currency")).toBeDefined();
    expect(screen.getByText("Email")).toBeDefined();
  });

  it("hides sections whose lists are empty", () => {
    renderWorkspace({
      inheritedDataTypes: buildProductInheritedDataTypes({
        domainSlug: "payments",
        domain: NO_TYPES,
        enterprise: NO_TYPES,
      }),
    });
    expect(screen.queryByText("From Domain")).toBeNull();
    expect(screen.queryByText("From Enterprise")).toBeNull();
  });

  it("shows format and pattern on inherited scalars", () => {
    renderWorkspace({ inheritedDataTypes: inherited });
    expect(screen.getByText("format: email")).toBeDefined();
    expect(screen.getByText("pattern: ^.+@.+$")).toBeDefined();
  });
});

describe("DomainWorkspace — New menu", () => {
  it("lists exactly New Entity, New Custom Data Type, New API and New Event", () => {
    nav.search = "";
    renderWorkspace();
    const menu = openNewMenu();
    const items = within(menu).getAllByRole("menuitem");
    expect(items.map((i) => i.querySelector(".text-body-small")?.textContent)).toEqual([
      "New Entity",
      "New Custom Data Type",
      "New API",
      "New Event",
    ]);
    expect(within(menu).getByText("AsyncAPI event specification")).toBeDefined();
    // The product workspace has no event spec / message / channel / trait entries any more.
    for (const retired of ["New Event Spec", "New Message", "New Channel", "New Trait"]) expect(within(menu).queryByText(retired)).toBeNull();
    expect(within(menu).getByText("Enum, scalar or union")).toBeDefined();
    // Kinds are chosen after the click, never listed individually.
    expect(within(menu).queryByText("Enum")).toBeNull();
    expect(within(menu).queryByText("Scalar")).toBeNull();
    expect(within(menu).queryByText("Union")).toBeNull();
    expect(within(menu).queryByText("New Data Type")).toBeNull();
  });

  it("New Custom Data Type switches to Data Types and opens the kind selector", () => {
    nav.search = "";
    renderWorkspace();
    expect(screen.queryByTestId("domain-types-tab")).toBeNull();
    fireEvent.click(within(openNewMenu()).getByRole("menuitem", { name: /New Custom Data Type/ }));
    expect(screen.getByTestId("domain-types-tab")).toBeDefined();
    const chooser = screen.getByTestId("type-kind-chooser");
    expect(within(chooser).getByRole("button", { name: "Enum" })).toBeDefined();
    expect(within(chooser).getByRole("button", { name: "Scalar" })).toBeDefined();
    expect(within(chooser).getByRole("button", { name: "Union" })).toBeDefined();
    // The menu closes after a choice.
    expect(screen.queryByRole("menu")).toBeNull();
  });

  it("New Custom Data Type works again after the selector was dismissed", () => {
    nav.search = "";
    renderWorkspace();
    fireEvent.click(within(openNewMenu()).getByRole("menuitem", { name: /New Custom Data Type/ }));
    fireEvent.click(within(screen.getByTestId("type-kind-chooser")).getByRole("button", { name: "Cancel" }));
    expect(screen.queryByTestId("type-kind-chooser")).toBeNull();
    fireEvent.click(within(openNewMenu()).getByRole("menuitem", { name: /New Custom Data Type/ }));
    expect(screen.getByTestId("type-kind-chooser")).toBeDefined();
  });

  it("creates an enum chosen in the selector at the PRODUCT target", async () => {
    nav.search = "";
    renderWorkspace();
    fireEvent.click(within(openNewMenu()).getByRole("menuitem", { name: /New Custom Data Type/ }));
    fireEvent.click(within(screen.getByTestId("type-kind-chooser")).getByRole("button", { name: "Enum" }));
    expect(screen.queryByTestId("type-kind-chooser")).toBeNull();
    fireEvent.change(screen.getByPlaceholderText("EnumName"), { target: { value: "Currency" } });
    fireEvent.change(screen.getByPlaceholderText("Value1, Value2, Value3"), { target: { value: "USD, EUR" } });
    fireEvent.click(screen.getByRole("button", { name: "Create" }));
    await waitFor(() => expect(actions.createSharedEnumAction).toHaveBeenCalledTimes(1));
    expect(actions.createSharedEnumAction).toHaveBeenCalledWith(
      "dom-1",
      { name: "Currency", values: ["USD", "EUR"] },
      PRODUCT_TARGET
    );
  });

  it("creates a scalar chosen in the selector at the PRODUCT target", async () => {
    nav.search = "";
    renderWorkspace();
    fireEvent.click(within(openNewMenu()).getByRole("menuitem", { name: /New Custom Data Type/ }));
    fireEvent.click(within(screen.getByTestId("type-kind-chooser")).getByRole("button", { name: "Scalar" }));
    fireEvent.change(screen.getByPlaceholderText("ScalarName"), { target: { value: "Email" } });
    fireEvent.click(screen.getByRole("button", { name: "Create" }));
    await waitFor(() => expect(actions.createCustomScalarAction).toHaveBeenCalledTimes(1));
    expect(actions.createCustomScalarAction).toHaveBeenCalledWith(
      "dom-1",
      { name: "Email", baseType: "string" },
      PRODUCT_TARGET
    );
  });

  it("creates a union chosen in the selector at the PRODUCT target", async () => {
    nav.search = "";
    renderWorkspace();
    fireEvent.click(within(openNewMenu()).getByRole("menuitem", { name: /New Custom Data Type/ }));
    fireEvent.click(within(screen.getByTestId("type-kind-chooser")).getByRole("button", { name: "Union" }));
    fireEvent.change(screen.getByPlaceholderText("UnionName"), { target: { value: "Payment" } });
    fireEvent.change(screen.getByPlaceholderText("TypeA | TypeB | TypeC"), { target: { value: "Card | Bank" } });
    fireEvent.click(screen.getByRole("button", { name: "Create" }));
    await waitFor(() => expect(actions.createUnionTypeAction).toHaveBeenCalledTimes(1));
    expect(actions.createUnionTypeAction).toHaveBeenCalledWith(
      "dom-1",
      { name: "Payment", memberTypes: ["Card", "Bank"] },
      PRODUCT_TARGET
    );
  });

  it("keeps the per-kind New Enum button working at the PRODUCT target", async () => {
    renderWorkspace();
    fireEvent.click(screen.getByRole("button", { name: /New Enum/ }));
    fireEvent.change(screen.getByPlaceholderText("EnumName"), { target: { value: "Status" } });
    fireEvent.click(screen.getByRole("button", { name: "Create" }));
    await waitFor(() => expect(actions.createSharedEnumAction).toHaveBeenCalledTimes(1));
    expect(actions.createSharedEnumAction).toHaveBeenCalledWith(
      "dom-1",
      { name: "Status", values: [] },
      PRODUCT_TARGET
    );
  });

  it("New API opens the APIs tab", () => {
    nav.search = "";
    renderWorkspace();
    fireEvent.click(within(openNewMenu()).getByRole("menuitem", { name: /New API/ }));
    expect(screen.getByTestId("domain-apis-tab")).toBeDefined();
  });
});

describe("DomainWorkspace — APIs tab", () => {
  beforeEach(() => {
    nav.search = "tab=apis";
  });

  it("creates API services at the PRODUCT target", async () => {
    renderWorkspace();
    fireEvent.click(screen.getByRole("button", { name: /New Service/ }));
    fireEvent.change(screen.getByPlaceholderText("Service name"), { target: { value: "Checkout API" } });
    fireEvent.click(screen.getByRole("button", { name: "Create Service" }));
    await waitFor(() => expect(actions.createServiceAction).toHaveBeenCalledTimes(1));
    expect(actions.createServiceAction).toHaveBeenCalledWith(
      "dom-1",
      { name: "Checkout API", basePath: "/", scope: "DOMAIN", entityId: undefined },
      PRODUCT_TARGET
    );
  });

  it("offers entity-scoped APIs for the product's entities", () => {
    renderWorkspace();
    fireEvent.click(screen.getByRole("button", { name: /New Service/ }));
    expect(screen.getByRole("option", { name: "Entity-scoped" })).toBeDefined();
    expect(screen.getByText("Entity APIs")).toBeDefined();
  });

  it("labels product-level services as Product APIs", () => {
    renderWorkspace({ services: [domainService({ id: "svc-p", name: "CheckoutApi" })] });
    expect(screen.getByText("Product APIs")).toBeDefined();
    expect(screen.queryByText("Domain APIs")).toBeNull();
    fireEvent.click(screen.getByRole("button", { name: /New Service/ }));
    expect(screen.getByRole("option", { name: "Product-scoped" })).toBeDefined();
  });

  it("lists domain-level services read-only under From Domain", () => {
    renderWorkspace({
      inheritedServices: buildProductInheritedServices({
        domainSlug: "payments",
        domain: [domainService()],
      }),
    });
    const section = screen.getByTestId("inherited-services");
    expect(within(section).getByRole("link", { name: "From Domain" }).getAttribute("href")).toBe(
      "/schemas/payments?tab=apis"
    );
    expect(within(section).getByText("PaymentsCore")).toBeDefined();
    expect(within(section).getByText("/payments")).toBeDefined();
    expect(within(section).queryByTitle("Delete service")).toBeNull();
  });

  it("hides the From Domain section when there are no domain-level services", () => {
    renderWorkspace({
      inheritedServices: buildProductInheritedServices({ domainSlug: "payments", domain: [] }),
    });
    expect(screen.queryByTestId("inherited-services")).toBeNull();
  });
});

describe("DomainWorkspace — ?tab= and the URL stay in sync", () => {
  it("follows ?tab= changes after mount (sidebar leaf links)", () => {
    nav.search = "";
    const { rerender } = renderWorkspace();
    expect(screen.queryByTestId("domain-types-tab")).toBeNull();

    nav.search = "tab=data-types";
    rerender(workspaceTree());
    expect(screen.getByTestId("domain-types-tab")).toBeDefined();

    nav.search = "tab=apis";
    rerender(workspaceTree());
    expect(screen.queryByTestId("domain-types-tab")).toBeNull();
    expect(screen.getByTestId("domain-apis-tab")).toBeDefined();

    nav.search = "";
    rerender(workspaceTree());
    expect(screen.queryByTestId("domain-apis-tab")).toBeNull();
  });

  it("clicking a tab writes the matching URL with history.replaceState, not router.replace", () => {
    nav.search = "";
    renderWorkspace();
    fireEvent.click(screen.getByRole("tab", { name: "APIs" }));
    expect(replaceState).toHaveBeenLastCalledWith(null, "", "/schemas/payments/checkout?tab=apis");
    expect(screen.getByTestId("domain-apis-tab")).toBeDefined();

    fireEvent.click(screen.getByRole("tab", { name: "Data Types" }));
    expect(replaceState).toHaveBeenLastCalledWith(null, "", "/schemas/payments/checkout?tab=data-types");
    expect(screen.getByTestId("domain-types-tab")).toBeDefined();

    fireEvent.click(screen.getByRole("tab", { name: "Entities" }));
    expect(replaceState).toHaveBeenLastCalledWith(null, "", "/schemas/payments/checkout");
    expect(nav.replace).not.toHaveBeenCalled();
  });

  it("New Custom Data Type and New API write their tab to the URL", () => {
    nav.search = "";
    renderWorkspace();
    fireEvent.click(within(openNewMenu()).getByRole("menuitem", { name: /New Custom Data Type/ }));
    expect(replaceState).toHaveBeenLastCalledWith(null, "", "/schemas/payments/checkout?tab=data-types");
    fireEvent.click(within(openNewMenu()).getByRole("menuitem", { name: /New API/ }));
    expect(replaceState).toHaveBeenLastCalledWith(null, "", "/schemas/payments/checkout?tab=apis");
  });

  it("New Entity does not rewrite the tab", () => {
    nav.search = "";
    renderWorkspace();
    fireEvent.click(within(openNewMenu()).getByRole("menuitem", { name: /New Entity/ }));
    expect(replaceState).not.toHaveBeenCalled();
    expect(nav.replace).not.toHaveBeenCalled();
  });
});

describe("DomainWorkspace — Events tab and New Event", () => {
  const EVENTS: EventListItem[] = [
    {
      id: "ev1", name: "orders", specType: "asyncapi@3.0", versionLabel: "1.2", hasUnpublishedChanges: true,
      channels: 2, messages: 3, operations: 1, href: assetHref({ kind: "event", id: "ev1", domainSlug: "payments", productSlug: "checkout" }),
      description: "", topics: [], payloads: [],
    },
    {
      id: "ev2", name: "refunds", specType: "asyncapi@3.0", versionLabel: null, hasUnpublishedChanges: true,
      channels: 0, messages: 0, operations: 0, href: assetHref({ kind: "event", id: "ev2", domainSlug: "payments", productSlug: "checkout" }),
      description: "", topics: [], payloads: [],
    },
  ];
  const EVENTS_LIST_HREF = assetHref({ kind: "events", domainSlug: "payments", productSlug: "checkout" });
  const dialogs = () => screen.queryAllByRole("dialog");
  const createEventFromMenu = () => fireEvent.click(within(openNewMenu()).getByRole("menuitem", { name: /New Event/ }));

  it("renders the flat events list with a link per event", () => {
    nav.search = "tab=events";
    renderWorkspace({ events: EVENTS });
    expect(screen.getByTestId("events-tab")).toBeDefined();
    expect(screen.getByRole("link", { name: "orders" }).getAttribute("href")).toBe("/schemas/payments/checkout/events/ev1");
    expect(screen.getByRole("link", { name: "refunds" }).getAttribute("href")).toBe("/schemas/payments/checkout/events/ev2");
    expect(screen.getByTestId("event-row-ev1-version").textContent).toBe("v1.2");
    expect(screen.getByTestId("event-row-ev2-version").textContent).toBe("Unpublished");
  });

  it("has no Specs / Messages / Channels sections any more", () => {
    nav.search = "tab=events";
    renderWorkspace({ events: EVENTS });
    expect(screen.queryByTestId("events-section-specs")).toBeNull();
    expect(screen.queryByTestId("events-section-messages")).toBeNull();
    expect(screen.queryByTestId("events-section-channels")).toBeNull();
    expect(screen.queryByRole("tablist", { name: "Events sections" })).toBeNull();
  });

  it("shows the Events tab for any old ?section= value, ignoring it", () => {
    nav.search = "tab=events&section=channels";
    renderWorkspace({ events: EVENTS });
    expect(screen.getByRole("link", { name: "orders" })).toBeDefined();
    expect(screen.getByRole("tab", { name: "Events" }).getAttribute("aria-selected")).toBe("true");
  });

  it("renders the Events tab without loaded data as the empty state", () => {
    nav.search = "tab=events";
    renderWorkspace();
    expect(screen.getByTestId("events-empty")).toBeDefined();
    expect(screen.getByRole("heading", { name: "No events yet" })).toBeDefined();
  });

  it("clicking the Events tab writes the Events list URL, without a section", () => {
    nav.search = "";
    renderWorkspace();
    fireEvent.click(screen.getByRole("tab", { name: "Events" }));
    expect(replaceState).toHaveBeenLastCalledWith(null, "", EVENTS_LIST_HREF);
    expect(EVENTS_LIST_HREF).toContain("/schemas/payments/checkout?tab=events");
    expect(screen.getByTestId("events-tab")).toBeDefined();
    expect(nav.replace).not.toHaveBeenCalled();
  });

  it("has no product Traits tab: the tab is gone and ?tab=traits lands on Events", () => {
    nav.search = "tab=traits";
    renderWorkspace({ events: EVENTS });
    expect(screen.queryByRole("tab", { name: "Traits" })).toBeNull();
    expect(screen.queryByTestId("traits-tab")).toBeNull();
    expect(screen.queryByTestId("traits-empty")).toBeNull();
    expect(screen.getByTestId("events-tab")).toBeDefined();
  });

  it("New Event opens the New Event dialog for this product and closes the menu, without leaving the current tab", () => {
    nav.search = "";
    renderWorkspace();
    expect(dialogs()).toHaveLength(0);
    createEventFromMenu();
    expect(screen.getByRole("dialog")).toBeDefined();
    expect(screen.getByTestId("new-event-form")).toBeDefined();
    expect(screen.queryByRole("menu")).toBeNull();
    // The dialog is the whole flow: no tab switch, no URL rewrite, no navigation yet.
    expect(replaceState).not.toHaveBeenCalled();
    expect(nav.push).not.toHaveBeenCalled();
    // The modal dialog hides the page behind it from the accessibility tree, hence `hidden: true`.
    expect(screen.getByRole("tab", { name: "Entities", hidden: true }).getAttribute("aria-selected")).toBe("true");
  });

  it("creates the event at this product and opens its page through assetHref", async () => {
    nav.search = "";
    eventActions.createEventAction.mockResolvedValue({ success: true, data: { id: "ev9" } });
    renderWorkspace();
    createEventFromMenu();
    fireEvent.change(screen.getByTestId("new-event-name"), { target: { value: "  order-events " } });
    fireEvent.change(screen.getByTestId("new-event-description"), { target: { value: "What checkout emits" } });
    fireEvent.click(screen.getByTestId("new-event-submit"));
    await waitFor(() => expect(nav.push).toHaveBeenCalledWith("/schemas/payments/checkout/events/ev9"));
    expect(nav.push).toHaveBeenCalledTimes(1);
    expect(eventActions.createEventAction).toHaveBeenCalledWith("prod-1", { name: "order-events", description: "What checkout emits" });
  });

  it("shows a failed create inline in the dialog and never navigates", async () => {
    nav.search = "";
    eventActions.createEventAction.mockResolvedValue({ success: false, code: "NAME_CONFLICT", error: '"orders" is already used.', suggestedFix: "Pick another name." });
    renderWorkspace();
    createEventFromMenu();
    fireEvent.change(screen.getByTestId("new-event-name"), { target: { value: "orders" } });
    fireEvent.click(screen.getByTestId("new-event-submit"));
    expect((await screen.findByTestId("new-event-error")).textContent).toBe('"orders" is already used. Pick another name.');
    expect(nav.push).not.toHaveBeenCalled();
    expect(screen.getByRole("dialog")).toBeDefined();
  });

  it("New Event works again after the dialog was cancelled, with an empty form", async () => {
    nav.search = "";
    renderWorkspace();
    createEventFromMenu();
    fireEvent.change(screen.getByTestId("new-event-name"), { target: { value: "orders" } });
    fireEvent.click(screen.getByTestId("new-event-cancel"));
    await waitFor(() => expect(dialogs()).toHaveLength(0));
    expect(eventActions.createEventAction).not.toHaveBeenCalled();
    createEventFromMenu();
    expect(screen.getByRole("dialog")).toBeDefined();
    expect((screen.getByTestId("new-event-name") as HTMLInputElement).value).toBe("");
  });

  it("the empty state's New Event button and the list's New Event button open the same single dialog", () => {
    nav.search = "tab=events";
    renderWorkspace();
    fireEvent.click(screen.getByTestId("events-empty-create"));
    expect(dialogs()).toHaveLength(1);
    cleanup();

    renderWorkspace({ events: EVENTS });
    fireEvent.click(screen.getByTestId("events-new"));
    expect(dialogs()).toHaveLength(1);
  });

  it("creating from the Events tab button opens the new event's page too", async () => {
    nav.search = "tab=events";
    eventActions.createEventAction.mockResolvedValue({ success: true, data: { id: "ev7" } });
    renderWorkspace();
    fireEvent.click(screen.getByTestId("events-empty-create"));
    fireEvent.change(screen.getByTestId("new-event-name"), { target: { value: "first-event" } });
    fireEvent.click(screen.getByTestId("new-event-submit"));
    await waitFor(() => expect(nav.push).toHaveBeenCalledWith("/schemas/payments/checkout/events/ev7"));
    expect(eventActions.createEventAction).toHaveBeenCalledWith("prod-1", { name: "first-event", description: undefined });
    expect(eventActions.createEventAction).toHaveBeenCalledTimes(1);
  });
});

describe("DomainWorkspace — canonical links", () => {
  it("New Entity routes through assetHref", () => {
    nav.search = "";
    renderWorkspace();
    fireEvent.click(within(openNewMenu()).getByRole("menuitem", { name: /New Entity/ }));
    expect(nav.push).toHaveBeenCalledWith("/schemas/payments/checkout/new");
  });

  it("the Cmd+N shortcut routes to the product's new-entity page", () => {
    nav.search = "";
    renderWorkspace();
    document.dispatchEvent(new Event("super-schema:new-entity"));
    expect(nav.push).toHaveBeenCalledWith("/schemas/payments/checkout/new");
  });

  it("the breadcrumb links back to the domain", () => {
    nav.search = "";
    renderWorkspace();
    expect(screen.getByRole("link", { name: "Payments" }).getAttribute("href")).toBe("/schemas/payments");
  });

  it("opening an entity row routes to its canonical URL", () => {
    nav.search = "";
    installLocalStorage({ "super-schema:view-mode": "list" });
    renderWorkspace();
    fireEvent.click(screen.getByText("Order"));
    expect(nav.push).toHaveBeenCalledWith("/schemas/payments/checkout/order");
  });

  it("empty-state start options route through assetHref", () => {
    nav.search = "";
    renderWorkspace({ entities: [] });
    fireEvent.click(screen.getByText(/Standards/i));
    expect(nav.push).toHaveBeenCalledWith("/schemas/payments/checkout/new?template=standards");
  });

  it("labels the breadcrumb landmark", () => {
    nav.search = "";
    renderWorkspace();
    expect(screen.getByRole("navigation", { name: "Breadcrumb" })).toBeDefined();
  });
});

describe("product tab bar accessibility", () => {
  it("is a tablist of tabs with selection, a roving tabindex and a labelled panel", () => {
    nav.search = "tab=apis";
    renderWorkspace();
    const list = screen.getByRole("tablist", { name: "Checkout sections" });
    const tabs = within(list).getAllByRole("tab");
    expect(tabs.map((t) => t.textContent)).toEqual(["Entities", "Events", "APIs", "Data Types"]);
    const selected = tabs.filter((t) => t.getAttribute("aria-selected") === "true");
    expect(selected.map((t) => t.textContent)).toEqual(["APIs"]);
    expect(tabs.map((t) => t.getAttribute("tabindex"))).toEqual(["-1", "-1", "0", "-1"]);

    const panel = screen.getByRole("tabpanel");
    expect(panel.id).toBe("product-tabpanel");
    expect(panel.getAttribute("aria-labelledby")).toBe(selected[0].id);
    for (const tab of tabs) expect(tab.getAttribute("aria-controls")).toBe(panel.id);
    expect(within(panel).getByTestId("domain-apis-tab")).toBeDefined();
  });

  it("moves between tabs with the arrow keys, Home and End (wrapping), writing the URL like a click", () => {
    nav.search = "";
    renderWorkspace();
    const selectedLabel = () =>
      screen.getAllByRole("tab").find((t) => t.getAttribute("aria-selected") === "true")!.textContent;

    fireEvent.keyDown(screen.getByRole("tab", { name: "Entities" }), { key: "ArrowRight" });
    expect(selectedLabel()).toBe("Events");
    expect(replaceState).toHaveBeenLastCalledWith(null, "", assetHref({ kind: "events", domainSlug: "payments", productSlug: "checkout" }));
    expect(document.activeElement).toBe(screen.getByRole("tab", { name: "Events" }));

    fireEvent.keyDown(screen.getByRole("tab", { name: "Events" }), { key: "ArrowLeft" });
    fireEvent.keyDown(screen.getByRole("tab", { name: "Entities" }), { key: "ArrowLeft" });
    expect(selectedLabel()).toBe("Data Types");
    expect(replaceState).toHaveBeenLastCalledWith(null, "", "/schemas/payments/checkout?tab=data-types");

    fireEvent.keyDown(screen.getByRole("tab", { name: "Data Types" }), { key: "Home" });
    expect(selectedLabel()).toBe("Entities");
    fireEvent.keyDown(screen.getByRole("tab", { name: "Entities" }), { key: "End" });
    expect(selectedLabel()).toBe("Data Types");
    fireEvent.keyDown(screen.getByRole("tab", { name: "Data Types" }), { key: "ArrowRight" });
    expect(selectedLabel()).toBe("Entities");

    // Other keys leave the selection alone.
    fireEvent.keyDown(screen.getByRole("tab", { name: "Entities" }), { key: "a" });
    expect(selectedLabel()).toBe("Entities");
  });

  it("keeps clicking working and the stable ids the e2e suite can target", () => {
    nav.search = "";
    renderWorkspace();
    fireEvent.click(screen.getByRole("tab", { name: "Events" }));
    expect(document.getElementById("product-tab-events")?.getAttribute("aria-selected")).toBe("true");
    expect(document.getElementById("product-tab-entities")?.getAttribute("aria-selected")).toBe("false");
  });
});
