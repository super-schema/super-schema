/**
 * @vitest-environment jsdom
 */
import { QueryClient, QueryClientProvider } from "@tanstack/react-query";
import { cleanup, fireEvent, render, screen, waitFor } from "@testing-library/react";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { DomainGrid } from "@/app/(dashboard)/schemas/domain-grid";
import { GENERIC_ACTION_ERROR } from "@/types/action-result";

const { createDomainActionMock, deleteDomainActionMock, refreshMock } = vi.hoisted(() => ({
  createDomainActionMock: vi.fn(),
  deleteDomainActionMock: vi.fn(),
  refreshMock: vi.fn(),
}));

vi.mock("@/app/(dashboard)/schemas/actions", () => ({
  createDomainAction: createDomainActionMock,
  deleteDomainAction: deleteDomainActionMock,
}));

vi.mock("next/navigation", () => ({
  useRouter: () => ({
    refresh: refreshMock,
  }),
}));

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

const EMPTY_DELETION_IMPACT = {
  entities: 0,
  products: 0,
  productLevelAssets: 0,
  modelDefinitions: 0,
  decoratorDefinitions: 0,
  sharedEnums: 0,
  customScalars: 0,
  unionTypes: 0,
  services: 0,
  interfaces: 0,
  userRoles: 0,
  traits: 0,
  eventSpecs: 0,
};

describe("DomainGrid", () => {
  beforeEach(() => {
    vi.clearAllMocks();
    deleteDomainActionMock.mockResolvedValue({ success: true });
  });

  afterEach(() => {
    cleanup();
  });

  it("links to the global type mapping reference", () => {
    renderWithQueryClient(
      <DomainGrid
        domains={[
          {
            id: "domain-1",
            name: "Customer",
            slug: "customer",
            description: "Customer data",
            isSystem: false,
            entityCount: 1,
            deletionImpact: { ...EMPTY_DELETION_IMPACT, entities: 1 },
            createdAt: new Date("2026-01-01T00:00:00.000Z"),
          },
        ]}
      />
    );

    const link = screen.getByRole("link", { name: /Type Mapping Reference/i });
    expect(link.getAttribute("href")).toBe("/schemas/type-mappings");
  });

  it("deletes an empty custom domain after confirmation", async () => {
    renderWithQueryClient(
      <DomainGrid
        canDeleteDomains
        domains={[
          {
            id: "domain-1",
            name: "cascade-test-1782425820372",
            slug: "cascade-test-1782425820372",
            description: "Test domain",
            isSystem: false,
            entityCount: 0,
            deletionImpact: {
              ...EMPTY_DELETION_IMPACT,
              modelDefinitions: 2,
              sharedEnums: 1,
            },
            createdAt: new Date("2026-01-01T00:00:00.000Z"),
          },
        ]}
      />
    );

    fireEvent.click(
      screen.getByRole("button", {
        name: /Delete domain cascade-test-1782425820372/i,
      })
    );

    expect(screen.getByRole("dialog", { name: /Delete domain/i })).toBeDefined();
    expect(screen.getByText("2 models")).toBeDefined();
    expect(screen.getByText("1 shared enum")).toBeDefined();

    fireEvent.click(screen.getByRole("button", { name: "Delete Domain" }));

    await waitFor(() => {
      expect(deleteDomainActionMock).toHaveBeenCalledWith("domain-1");
    });
    expect(refreshMock).toHaveBeenCalledTimes(1);
  });

  it("warns that product-level Data Types and APIs are deleted with the domain", () => {
    renderWithQueryClient(
      <DomainGrid
        canDeleteDomains
        domains={[
          {
            id: "domain-1",
            name: "Orders",
            slug: "orders",
            description: "",
            isSystem: false,
            entityCount: 0,
            deletionImpact: {
              ...EMPTY_DELETION_IMPACT,
              products: 2,
              productLevelAssets: 3,
              sharedEnums: 2,
              services: 1,
            },
            createdAt: new Date("2026-01-01T00:00:00.000Z"),
          },
        ]}
      />
    );

    fireEvent.click(screen.getByRole("button", { name: /Delete domain Orders/i }));

    expect(screen.getByText("2 products")).toBeDefined();
    expect(
      screen.getByText(
        "Includes 3 product-level Data Types and APIs, deleted together with their products."
      )
    ).toBeDefined();
    expect(
      screen.getByText(/its products, and every asset listed below/i)
    ).toBeDefined();
  });

  it("blocks deleting a domain that owns Events assets and lists them", () => {
    renderWithQueryClient(
      <DomainGrid
        canDeleteDomains
        domains={[
          {
            id: "domain-1",
            name: "Orders",
            slug: "orders",
            description: "",
            isSystem: false,
            entityCount: 0,
            deletionImpact: { ...EMPTY_DELETION_IMPACT, products: 1, traits: 1, eventSpecs: 2 },
            createdAt: new Date("2026-01-01T00:00:00.000Z"),
          },
        ]}
      />
    );

    fireEvent.click(screen.getByRole("button", { name: /Delete domain Orders/i }));

    expect(screen.getByText("Delete or move all Events assets first.")).toBeDefined();
    expect(screen.getByText("This domain currently contains 1 trait and 2 events.")).toBeDefined();
    const confirm = screen.getByRole("button", { name: "Delete Domain" }) as HTMLButtonElement;
    expect(confirm.disabled).toBe(true);
    fireEvent.click(confirm);
    expect(deleteDomainActionMock).not.toHaveBeenCalled();
  });

  it("does not show delete controls for system domains", () => {
    renderWithQueryClient(
      <DomainGrid
        canDeleteDomains
        domains={[
          {
            id: "domain-system",
            name: "Public",
            slug: "public",
            description: "System domain",
            isSystem: true,
            entityCount: 0,
            deletionImpact: EMPTY_DELETION_IMPACT,
            createdAt: new Date("2026-01-01T00:00:00.000Z"),
          },
        ]}
      />
    );

    expect(
      screen.queryByRole("button", { name: /Delete domain Public/i })
    ).toBeNull();
  });

  it("hides delete controls from non-admin users", () => {
    renderWithQueryClient(
      <DomainGrid
        canDeleteDomains={false}
        domains={[
          {
            id: "domain-1",
            name: "Orders",
            slug: "orders",
            description: "Order data",
            isSystem: false,
            entityCount: 0,
            deletionImpact: EMPTY_DELETION_IMPACT,
            createdAt: new Date("2026-01-01T00:00:00.000Z"),
          },
        ]}
      />
    );

    expect(
      screen.queryByRole("button", { name: /Delete domain Orders/i })
    ).toBeNull();
  });

  it("recovers when the delete action rejects", async () => {
    deleteDomainActionMock.mockRejectedValueOnce(new Error("network failure"));
    renderWithQueryClient(
      <DomainGrid
        canDeleteDomains
        domains={[
          {
            id: "domain-1",
            name: "Orders",
            slug: "orders",
            description: "Order data",
            isSystem: false,
            entityCount: 0,
            deletionImpact: EMPTY_DELETION_IMPACT,
            createdAt: new Date("2026-01-01T00:00:00.000Z"),
          },
        ]}
      />
    );

    fireEvent.click(screen.getByRole("button", { name: /Delete domain Orders/i }));
    fireEvent.click(screen.getByRole("button", { name: "Delete Domain" }));

    expect(
      await screen.findByText("Unable to delete the domain. Please try again.")
    ).toBeDefined();
    expect(
      (screen.getByRole("button", { name: "Cancel" }) as HTMLButtonElement).disabled
    ).toBe(false);
  });

  it("moves focus into the dialog and closes it with Escape", async () => {
    renderWithQueryClient(
      <DomainGrid
        canDeleteDomains
        domains={[
          {
            id: "domain-1",
            name: "Orders",
            slug: "orders",
            description: "Order data",
            isSystem: false,
            entityCount: 0,
            deletionImpact: EMPTY_DELETION_IMPACT,
            createdAt: new Date("2026-01-01T00:00:00.000Z"),
          },
        ]}
      />
    );

    fireEvent.click(screen.getByRole("button", { name: /Delete domain Orders/i }));
    const cancelButton = screen.getByRole("button", { name: "Cancel" });
    await waitFor(() => expect(document.activeElement).toBe(cancelButton));

    fireEvent.keyDown(document, { key: "Escape" });
    await waitFor(() => expect(screen.queryByRole("dialog")).toBeNull());
  });

  it("re-enables the create form with the generic message when the create action rejects", async () => {
    createDomainActionMock.mockRejectedValueOnce(new Error("Failed to fetch"));
    const consoleError = vi.spyOn(console, "error").mockImplementation(() => undefined);
    renderWithQueryClient(<DomainGrid domains={[]} />);

    fireEvent.click(screen.getByTestId("create-domain-button"));
    fireEvent.change(screen.getByTestId("domain-name-input"), { target: { value: "Payments" } });
    fireEvent.click(screen.getByTestId("create-domain-submit"));

    expect((await screen.findByTestId("create-domain-error")).textContent).toBe(GENERIC_ACTION_ERROR);
    const submit = screen.getByTestId("create-domain-submit") as HTMLButtonElement;
    expect(submit.disabled).toBe(false);
    expect(submit.textContent).toBe("Create");
    // The form stays open, so the user can retry.
    expect(screen.getByTestId("create-domain-form")).toBeDefined();
    expect(consoleError).toHaveBeenCalled();
    consoleError.mockRestore();
  });
});
