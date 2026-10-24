/**
 * @vitest-environment jsdom
 */
import { QueryClient, QueryClientProvider } from "@tanstack/react-query";
import { cleanup, fireEvent, render, screen, waitFor } from "@testing-library/react";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { ProductGrid, type ProductGridItem } from "@/app/(dashboard)/schemas/[domainSlug]/product-grid";

const { deleteProductActionMock, refreshMock, toastErrorMock } = vi.hoisted(() => ({
  deleteProductActionMock: vi.fn(),
  refreshMock: vi.fn(),
  toastErrorMock: vi.fn(),
}));

vi.mock("@/app/(dashboard)/schemas/[domainSlug]/product-actions", () => ({
  createProductAction: vi.fn(),
  deleteProductAction: deleteProductActionMock,
}));

vi.mock("next/navigation", () => ({
  useRouter: () => ({ refresh: refreshMock, push: vi.fn() }),
}));

vi.mock("sonner", () => ({
  toast: { error: toastErrorMock, success: vi.fn() },
}));

function product(overrides: Partial<ProductGridItem> = {}): ProductGridItem {
  return {
    id: "prd-1",
    name: "Checkout",
    slug: "checkout",
    description: "",
    ownerTeam: null,
    isSystem: false,
    entityCount: 0,
    dataTypeCount: 0,
    apiCount: 0,
    updatedAt: new Date("2026-01-01T00:00:00.000Z"),
    tier: null,
    ...overrides,
  };
}

function renderGrid(products: ProductGridItem[]) {
  const queryClient = new QueryClient();
  return render(
    <QueryClientProvider client={queryClient}>
      <ProductGrid
        domainId="dom-1"
        domainName="Orders"
        domainSlug="orders"
        products={products}
        tiers={[]}
      />
    </QueryClientProvider>
  );
}

describe("ProductGrid delete", () => {
  beforeEach(() => {
    vi.clearAllMocks();
    deleteProductActionMock.mockResolvedValue({ success: true });
  });
  afterEach(() => cleanup());

  it("disables delete when the product owns product-level Data Types or APIs", () => {
    renderGrid([product({ dataTypeCount: 2, apiCount: 1 })]);
    const button = screen.getByRole("button", { name: /Delete product Checkout/i }) as HTMLButtonElement;
    expect(button.disabled).toBe(true);
    expect(button.title).toBe("Delete the product's 2 Data Types and 1 API before removing it");
    fireEvent.click(button);
    expect(deleteProductActionMock).not.toHaveBeenCalled();
  });

  it("disables delete when the product owns events", () => {
    renderGrid([product({ eventsAssets: { traits: 0, eventSpecs: 2 } })]);
    const button = screen.getByRole("button", { name: /Delete product Checkout/i }) as HTMLButtonElement;
    expect(button.disabled).toBe(true);
    expect(button.title).toBe("Delete the product's 2 events before removing it");
    fireEvent.click(button);
    expect(deleteProductActionMock).not.toHaveBeenCalled();
  });

  it("asks first: the trash button opens a confirmation that names the product, and deletes nothing", () => {
    renderGrid([product()]);
    fireEvent.click(screen.getByRole("button", { name: /Delete product Checkout/i }));

    const dialog = screen.getByTestId("delete-product-dialog");
    expect(dialog.textContent).toContain("Delete \u201cCheckout\u201d?");
    expect(dialog.textContent).toContain("This permanently deletes this product. This action cannot be undone.");
    expect(deleteProductActionMock).not.toHaveBeenCalled();
  });

  it("Cancel closes the confirmation and the product is not deleted", async () => {
    renderGrid([product()]);
    fireEvent.click(screen.getByRole("button", { name: /Delete product Checkout/i }));
    fireEvent.click(screen.getByTestId("delete-product-cancel"));

    await waitFor(() => expect(screen.queryByTestId("delete-product-dialog")).toBeNull());
    expect(deleteProductActionMock).not.toHaveBeenCalled();
    expect(refreshMock).not.toHaveBeenCalled();
  });

  it("deletes an empty product only after the confirmation", async () => {
    renderGrid([product()]);
    fireEvent.click(screen.getByRole("button", { name: /Delete product Checkout/i }));
    expect(deleteProductActionMock).not.toHaveBeenCalled();

    fireEvent.click(screen.getByTestId("delete-product-confirm"));
    await waitFor(() => expect(deleteProductActionMock).toHaveBeenCalledWith("prd-1"));
    expect(deleteProductActionMock).toHaveBeenCalledTimes(1);
    await waitFor(() => expect(refreshMock).toHaveBeenCalled());
    await waitFor(() => expect(screen.queryByTestId("delete-product-dialog")).toBeNull());
  });

  it("never opens the confirmation for a product that cannot be deleted", () => {
    renderGrid([product({ entityCount: 1 })]);
    const button = screen.getByRole("button", { name: /Delete product Checkout/i }) as HTMLButtonElement;
    expect(button.disabled).toBe(true);
    fireEvent.click(button);
    expect(screen.queryByTestId("delete-product-dialog")).toBeNull();
  });
});
