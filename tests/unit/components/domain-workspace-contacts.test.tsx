/**
 * @vitest-environment jsdom
 */
import { QueryClient, QueryClientProvider } from "@tanstack/react-query";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { cleanup, fireEvent, render, screen } from "@testing-library/react";
import { DomainWorkspace } from "@/app/(dashboard)/schemas/[domainSlug]/domain-workspace";

const nav = vi.hoisted(() => ({ push: vi.fn(), replace: vi.fn() }));
const productActions = vi.hoisted(() => ({ updateProductAction: vi.fn() }));

vi.mock("next/navigation", () => ({
  useRouter: () => ({ push: nav.push, replace: nav.replace, refresh: vi.fn() }),
  useSearchParams: () => new URLSearchParams(""),
}));
vi.mock("@/app/(dashboard)/schemas/[domainSlug]/actions", () => ({
  createEntityWithFieldsAction: vi.fn(),
  deleteEntityAction: vi.fn(),
}));
vi.mock("@/app/(dashboard)/schemas/actions", () => ({ deleteDomainAction: vi.fn() }));
// The New Event dialog imports a server-action module that pulls in NextAuth; so does the Edit contacts dialog.
vi.mock("@/app/(dashboard)/schemas/[domainSlug]/[productSlug]/event-actions", () => ({ createEventAction: vi.fn() }));
vi.mock("@/app/(dashboard)/schemas/[domainSlug]/product-actions", () => ({ updateProductAction: productActions.updateProductAction }));
vi.mock("sonner", () => ({ toast: { error: vi.fn(), success: vi.fn() } }));
vi.mock("@/components/custom/TypePicker", () => ({ TypePicker: () => <select /> }));
vi.mock("@/components/custom/ClassificationPicker", () => ({ ClassificationPicker: () => null }));

const BASE_PROPS = {
  domainId: "dom-1",
  domainName: "Payments",
  domainSlug: "payments",
  productId: "prod-1",
  productSlug: "checkout",
  productName: "Checkout",
  domainDescription: "",
  domainPolicy: null,
  entities: [],
  sharedEnums: [],
  customScalars: [],
  unionTypes: [],
  services: [],
};

function renderWorkspace(overrides: Partial<React.ComponentProps<typeof DomainWorkspace>> = {}) {
  return render(
    <QueryClientProvider client={new QueryClient({ defaultOptions: { queries: { retry: false } } })}>
      <DomainWorkspace {...BASE_PROPS} {...overrides} />
    </QueryClientProvider>
  );
}

beforeEach(() => {
  vi.clearAllMocks();
  const store = new Map<string, string>();
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
});
afterEach(() => cleanup());

describe("product page header contacts", () => {
  it("shows the lead, manager and team addresses as mailto links when the product has them", () => {
    renderWorkspace({
      productContacts: {
        engineeringLead: '"Doe, Jane" <j@x.com>',
        manager: "Mo Manager <mo@acme.com>",
        teamEmails: ["Platform <platform@acme.com>", "oncall@acme.com"],
      },
    });

    expect(screen.getByRole("link", { name: "Doe, Jane" }).getAttribute("href")).toBe("mailto:j@x.com");
    expect(screen.getByRole("link", { name: "Mo Manager" }).getAttribute("href")).toBe("mailto:mo@acme.com");
    expect(screen.getByRole("link", { name: "Platform" }).getAttribute("href")).toBe("mailto:platform@acme.com");
    expect(screen.getByRole("link", { name: "oncall@acme.com" }).getAttribute("href")).toBe("mailto:oncall@acme.com");
  });

  it("shows nothing for a product without contacts", () => {
    renderWorkspace({ productContacts: { engineeringLead: null, manager: null, teamEmails: [] } });

    expect(screen.queryByTestId("product-contacts")).toBeNull();
  });

  it("shows nothing when no contacts are passed at all", () => {
    renderWorkspace();

    expect(screen.queryByTestId("product-contacts")).toBeNull();
  });

  it("keeps the product tabs next to the contacts", () => {
    renderWorkspace({ productContacts: { engineeringLead: "jane@acme.com", manager: null, teamEmails: [] } });

    expect(screen.getByRole("tablist", { name: "Checkout sections" })).toBeTruthy();
  });

  it("offers Edit contacts beside the contacts; the dialog opens prefilled with them", () => {
    renderWorkspace({
      productContacts: {
        engineeringLead: "Jane Doe <jane@acme.com>",
        manager: null,
        teamEmails: ["oncall@acme.com"],
      },
    });
    expect(screen.queryByRole("dialog")).toBeNull();

    fireEvent.click(screen.getByRole("button", { name: "Edit contacts" }));

    const dialog = screen.getByRole("dialog");
    expect(dialog.textContent).toContain("Checkout");
    expect((screen.getByTestId("product-engineering-lead-input") as HTMLInputElement).value).toBe("Jane Doe <jane@acme.com>");
    expect((screen.getByTestId("product-manager-input") as HTMLInputElement).value).toBe("");
    expect(screen.getAllByTestId("product-team-emails-chip")).toHaveLength(1);
  });

  it("offers Edit contacts for a product without contacts, and the dialog opens empty", () => {
    renderWorkspace({ productContacts: { engineeringLead: null, manager: null, teamEmails: [] } });
    expect(screen.queryByTestId("product-contacts")).toBeNull();

    fireEvent.click(screen.getByRole("button", { name: "Edit contacts" }));

    expect((screen.getByTestId("product-engineering-lead-input") as HTMLInputElement).value).toBe("");
    expect(screen.queryAllByTestId("product-team-emails-chip")).toHaveLength(0);
  });

  it("saves through updateProductAction for THIS product, with only the contact fields", async () => {
    productActions.updateProductAction.mockResolvedValue({ success: true, slug: "checkout" });
    renderWorkspace({ productContacts: { engineeringLead: null, manager: null, teamEmails: [] } });
    fireEvent.click(screen.getByRole("button", { name: "Edit contacts" }));
    fireEvent.change(screen.getByTestId("product-manager-input"), { target: { value: "mo@acme.com" } });

    fireEvent.click(screen.getByTestId("edit-product-contacts-save"));

    await vi.waitFor(() => expect(productActions.updateProductAction).toHaveBeenCalledTimes(1));
    expect(productActions.updateProductAction).toHaveBeenCalledWith("prod-1", { engineeringLead: null, manager: "mo@acme.com", teamEmails: [] });
  });
});
