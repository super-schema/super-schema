/**
 * @vitest-environment jsdom
 */
import { QueryClient, QueryClientProvider } from "@tanstack/react-query";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { cleanup, render, screen } from "@testing-library/react";
import { DomainWorkspace } from "@/app/(dashboard)/schemas/[domainSlug]/domain-workspace";

const nav = vi.hoisted(() => ({ push: vi.fn(), replace: vi.fn() }));

vi.mock("next/navigation", () => ({
  useRouter: () => ({ push: nav.push, replace: nav.replace, refresh: vi.fn() }),
  useSearchParams: () => new URLSearchParams(""),
}));
vi.mock("@/app/(dashboard)/schemas/[domainSlug]/actions", () => ({
  createEntityWithFieldsAction: vi.fn(),
  deleteEntityAction: vi.fn(),
}));
vi.mock("@/app/(dashboard)/schemas/actions", () => ({ deleteDomainAction: vi.fn() }));
// The New Event dialog imports a server-action module that pulls in NextAuth.
vi.mock("@/app/(dashboard)/schemas/[domainSlug]/[productSlug]/event-actions", () => ({ createEventAction: vi.fn() }));
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
});
