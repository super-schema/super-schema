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

  it("still deletes an empty product", async () => {
    renderGrid([product()]);
    fireEvent.click(screen.getByRole("button", { name: /Delete product Checkout/i }));
    await waitFor(() => expect(deleteProductActionMock).toHaveBeenCalledWith("prd-1"));
    expect(refreshMock).toHaveBeenCalled();
  });
});
