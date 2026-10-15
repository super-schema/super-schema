/**
 * @vitest-environment jsdom
 */
import { QueryClient, QueryClientProvider } from "@tanstack/react-query";
import { cleanup, fireEvent, render, screen, waitFor } from "@testing-library/react";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { ProductGrid, type ProductGridItem } from "@/app/(dashboard)/schemas/[domainSlug]/product-grid";
import { GENERIC_ACTION_ERROR } from "@/types/action-result";

const { createProductActionMock, deleteProductActionMock, refreshMock, pushMock, toastErrorMock, toastSuccessMock } = vi.hoisted(() => ({
  createProductActionMock: vi.fn(),
  deleteProductActionMock: vi.fn(),
  refreshMock: vi.fn(),
  pushMock: vi.fn(),
  toastErrorMock: vi.fn(),
  toastSuccessMock: vi.fn(),
}));

vi.mock("@/app/(dashboard)/schemas/[domainSlug]/product-actions", () => ({
  createProductAction: createProductActionMock,
  deleteProductAction: deleteProductActionMock,
}));
vi.mock("next/navigation", () => ({ useRouter: () => ({ refresh: refreshMock, push: pushMock }) }));
vi.mock("sonner", () => ({ toast: { error: toastErrorMock, success: toastSuccessMock } }));

const PRODUCT: ProductGridItem = {
  id: "prd-1", name: "Checkout", slug: "checkout", description: "", ownerTeam: null, isSystem: false,
  entityCount: 0, dataTypeCount: 0, apiCount: 0, updatedAt: new Date("2026-01-01T00:00:00.000Z"), tier: null,
};

function renderGrid(products: ProductGridItem[] = [PRODUCT]) {
  return render(
    <QueryClientProvider client={new QueryClient()}>
      <ProductGrid domainId="dom-1" domainName="Orders" domainSlug="orders" products={products} tiers={[]} />
    </QueryClientProvider>
  );
}

function openCreateFormAndSubmit() {
  fireEvent.click(screen.getAllByRole("button", { name: /New Product/i })[0]);
  fireEvent.change(screen.getByPlaceholderText(/OneSCM/), { target: { value: "Billing" } });
  fireEvent.click(screen.getByRole("button", { name: "Create" }));
}

describe("ProductGrid create / delete when the server action fails", () => {
  let consoleError: ReturnType<typeof vi.spyOn>;
  beforeEach(() => {
    vi.clearAllMocks();
    consoleError = vi.spyOn(console, "error").mockImplementation(() => undefined);
  });
  afterEach(() => {
    cleanup();
    consoleError.mockRestore();
  });

  it("create: a REJECTED action shows the generic message and re-enables the form (never stuck on 'Creating...')", async () => {
    createProductActionMock.mockRejectedValue(new Error("Failed to fetch"));
    renderGrid();
    openCreateFormAndSubmit();
    expect(await screen.findByText(GENERIC_ACTION_ERROR)).toBeTruthy();
    const create = screen.getByRole("button", { name: "Create" }) as HTMLButtonElement;
    expect(create.disabled).toBe(false);
    expect(screen.queryByText("Creating...")).toBeNull();
    expect(pushMock).not.toHaveBeenCalled();
    expect(consoleError).toHaveBeenCalled();
  });

  it("create: a returned { error } is shown and the form is re-enabled", async () => {
    createProductActionMock.mockResolvedValue({ error: 'A product named "Billing" already exists in this domain' });
    renderGrid();
    openCreateFormAndSubmit();
    expect(await screen.findByText(/already exists in this domain/)).toBeTruthy();
    expect((screen.getByRole("button", { name: "Create" }) as HTMLButtonElement).disabled).toBe(false);
  });

  it("create: success still navigates to the new product and closes the form", async () => {
    createProductActionMock.mockResolvedValue({ success: true, productId: "prd-2", slug: "billing" });
    renderGrid();
    openCreateFormAndSubmit();
    await waitFor(() => expect(pushMock).toHaveBeenCalledWith(expect.stringContaining("billing")));
    expect(screen.queryByRole("button", { name: "Create" })).toBeNull();
  });

  it("delete: a REJECTED action shows the generic error toast (no unhandled rejection)", async () => {
    deleteProductActionMock.mockRejectedValue(new Error("Failed to fetch"));
    renderGrid();
    fireEvent.click(screen.getByRole("button", { name: /Delete product Checkout/i }));
    await waitFor(() => expect(toastErrorMock).toHaveBeenCalledWith(GENERIC_ACTION_ERROR));
    expect(toastSuccessMock).not.toHaveBeenCalled();
    expect(refreshMock).not.toHaveBeenCalled();
  });

  it("delete: a returned { error } is toasted as is", async () => {
    deleteProductActionMock.mockResolvedValue({ error: "Product is in use" });
    renderGrid();
    fireEvent.click(screen.getByRole("button", { name: /Delete product Checkout/i }));
    await waitFor(() => expect(toastErrorMock).toHaveBeenCalledWith("Product is in use"));
    expect(refreshMock).not.toHaveBeenCalled();
  });
});
