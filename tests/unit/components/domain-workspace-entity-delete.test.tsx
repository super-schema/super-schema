/**
 * @vitest-environment jsdom
 */
import { QueryClient, QueryClientProvider } from "@tanstack/react-query";
import { cleanup, render, screen } from "@testing-library/react";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { DomainWorkspace } from "@/app/(dashboard)/schemas/[domainSlug]/domain-workspace";

const { pushMock, refreshMock, deleteEntityMock } = vi.hoisted(() => ({
  pushMock: vi.fn(),
  refreshMock: vi.fn(),
  deleteEntityMock: vi.fn().mockResolvedValue({ success: true }),
}));

vi.mock("next/navigation", () => ({
  useRouter: () => ({ push: pushMock, refresh: refreshMock }),
  useSearchParams: () => ({ get: () => null }),
}));

vi.mock("@/app/(dashboard)/schemas/[domainSlug]/actions", () => ({
  createEntityWithFieldsAction: vi.fn(),
  deleteEntityAction: deleteEntityMock,
}));

// The New Event dialog imports a server-action module that pulls in NextAuth; so does the Edit contacts dialog.
vi.mock("@/app/(dashboard)/schemas/[domainSlug]/[productSlug]/event-actions", () => ({ createEventAction: vi.fn() }));
vi.mock("@/app/(dashboard)/schemas/[domainSlug]/product-actions", () => ({ updateProductAction: vi.fn() }));

vi.mock("@/components/custom/EntityCard", () => ({
  EntityCard: ({ name, onDelete }: { name: string; onDelete?: (id: string, name: string) => void }) => (
    <div data-testid={`entity-card-${name}`}>
      <span>{name}</span>
      {onDelete && <button onClick={() => onDelete("ent-1", name)}>Delete entity {name}</button>}
    </div>
  ),
}));

vi.mock("@/app/(dashboard)/schemas/[domainSlug]/components/DomainTypesTab", () => ({
  DomainTypesTab: () => null,
}));

vi.mock("@/app/(dashboard)/schemas/[domainSlug]/components/DomainApisTab", () => ({
  DomainApisTab: () => null,
}));

vi.mock("@/components/custom/TypePicker", () => ({
  TypePicker: () => <select />,
}));

vi.mock("@/components/custom/ClassificationPicker", () => ({
  ClassificationPicker: () => null,
}));

vi.mock("sonner", () => ({
  toast: { success: vi.fn(), error: vi.fn() },
}));

function installLocalStorage() {
  const store = new Map<string, string>();
  const storage = {
    getItem: vi.fn((key: string) => store.get(key) ?? null),
    setItem: vi.fn((key: string, value: string) => {
      store.set(key, value);
    }),
    removeItem: vi.fn((key: string) => {
      store.delete(key);
    }),
    clear: vi.fn(() => {
      store.clear();
    }),
    key: vi.fn((index: number) => Array.from(store.keys())[index] ?? null),
    get length() {
      return store.size;
    },
  } satisfies Storage;

  Object.defineProperty(globalThis, "localStorage", {
    value: storage,
    configurable: true,
  });
}

function renderWithQueryClient(ui: React.ReactElement) {
  const queryClient = new QueryClient({
    defaultOptions: {
      queries: {
        retry: false,
      },
    },
  });

  return render(
    <QueryClientProvider client={queryClient}>{ui}</QueryClientProvider>
  );
}

beforeEach(() => {
  installLocalStorage();
});

afterEach(() => {
  cleanup();
  localStorage.clear();
  vi.clearAllMocks();
});

const BASE_PROPS = {
  domainId: "dom-1",
  domainName: "Orders",
  domainSlug: "orders",
  productId: "prod-1",
  productSlug: "default",
  productName: "Default",
  domainDescription: "Order domain",
  domainPolicy: null,
  entities: [],
  sharedEnums: [],
  customScalars: [],
  unionTypes: [],
  services: [],
};

describe("DomainWorkspace — entity list-view delete", () => {
  it("list-view rows have a delete button per entity", () => {
    localStorage.setItem("super-schema:view-mode", "list");
    renderWithQueryClient(
      <DomainWorkspace
        {...BASE_PROPS}
        entities={[
          {
            id: "ent-1",
            name: "Order",
            slug: "order",
            description: "",
            status: "DRAFT",
            version: 1,
            fieldCount: 2,
            updatedAt: new Date("2026-01-01"),
            classifications: { NEVER_STORED: 0, PII: 0, SENSITIVE: 0, INTERNAL: 0, PUBLIC: 0 },
          },
        ]}
      />
    );
    expect(screen.getByRole("table")).toBeDefined();
    expect(screen.getByRole("button", { name: /Delete entity Order/i })).toBeDefined();
  });
});
