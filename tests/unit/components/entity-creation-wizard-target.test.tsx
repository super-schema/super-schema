/**
 * @vitest-environment jsdom
 */
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { cleanup, fireEvent, render, screen, waitFor } from "@testing-library/react";
import { EntityCreationWizard } from "@/components/custom/EntityCreationWizard/EntityCreationWizard";

const mocks = vi.hoisted(() => ({
  push: vi.fn(),
  refresh: vi.fn(),
  invalidate: vi.fn(),
  createEntityWithFieldsAction: vi.fn(),
  createTenantEntityAction: vi.fn(),
}));

vi.mock("next/navigation", () => ({
  useRouter: () => ({ push: mocks.push, refresh: mocks.refresh }),
}));
vi.mock("@/app/(dashboard)/schemas/[domainSlug]/actions", () => ({
  createEntityWithFieldsAction: mocks.createEntityWithFieldsAction,
}));
vi.mock("@/app/(dashboard)/schemas/enterprise/actions", () => ({
  createTenantEntityAction: mocks.createTenantEntityAction,
}));
vi.mock("@/app/(dashboard)/schemas/[domainSlug]/typespec-import-actions", () => ({
  importTypeSpecDocumentAction: vi.fn(),
}));
vi.mock("@/app/(dashboard)/schemas/[domainSlug]/openapi-import-actions", () => ({
  importOpenApiDocumentAction: vi.fn(),
}));
vi.mock("@/hooks/useDomainsTree", () => ({ useInvalidateDomainsTree: () => mocks.invalidate }));
vi.mock("@/components/custom/VisualSchemaBuilder/VisualSchemaBuilder", () => ({ VisualSchemaBuilder: () => null }));
vi.mock("@/components/custom/TypePicker", () => ({ TypePicker: () => <select /> }));
vi.mock("@/components/custom/ClassificationPicker", () => ({ ClassificationPicker: () => null }));
vi.mock("sonner", () => ({ toast: { error: vi.fn(), success: vi.fn(), warning: vi.fn() } }));

const PRODUCT_TARGET = {
  level: "PRODUCT" as const,
  productId: "prod-1",
  domainId: "dom-1",
  domainName: "Payments",
  domainSlug: "payments",
  productSlug: "checkout",
};

function startBlankAndCreate(name: string) {
  fireEvent.click(screen.getByRole("button", { name: /Start Blank/ }));
  fireEvent.change(screen.getByPlaceholderText("EntityName"), { target: { value: name } });
  fireEvent.click(screen.getByRole("button", { name: "Create Entity" }));
}

beforeEach(() => {
  vi.clearAllMocks();
  mocks.createEntityWithFieldsAction.mockResolvedValue({ success: true, entityId: "e1" });
  mocks.createTenantEntityAction.mockResolvedValue({ success: true, entity: { id: "e2", slug: "customer" } });
});

afterEach(cleanup);

describe("EntityCreationWizard with a TENANT target", () => {
  it("creates through createTenantEntityAction and redirects to the tenant entity", async () => {
    render(<EntityCreationWizard target={{ level: "TENANT", tenantId: "tenant-1" }} />);
    startBlankAndCreate("Customer");

    await waitFor(() => expect(mocks.createTenantEntityAction).toHaveBeenCalledTimes(1));
    expect(mocks.createTenantEntityAction).toHaveBeenCalledWith({
      name: "Customer",
      description: "",
      fields: [],
    });
    expect(mocks.createEntityWithFieldsAction).not.toHaveBeenCalled();
    await waitFor(() => expect(mocks.push).toHaveBeenCalledWith("/schemas/enterprise/entities/customer"));
  });

  it("shows the action error and stays on the page when creation is rejected", async () => {
    mocks.createTenantEntityAction.mockResolvedValue({ error: "dup" });
    render(<EntityCreationWizard target={{ level: "TENANT", tenantId: "tenant-1" }} />);
    startBlankAndCreate("Customer");

    expect(await screen.findByText("dup")).toBeDefined();
    expect(mocks.push).not.toHaveBeenCalled();
  });

  it("addresses the Enterprise and does not offer AI generation, which needs a domain", () => {
    render(<EntityCreationWizard target={{ level: "TENANT", tenantId: "tenant-1" }} />);
    expect(screen.getByText("Enterprise")).toBeDefined();
    expect(screen.queryByText("Describe in Natural Language")).toBeNull();
    expect(screen.getByText("Standards Library")).toBeDefined();
  });
});

describe("EntityCreationWizard with a PRODUCT target", () => {
  it("keeps creating in the product and returns to the product page", async () => {
    render(<EntityCreationWizard target={PRODUCT_TARGET} />);
    startBlankAndCreate("Order");

    await waitFor(() => expect(mocks.createEntityWithFieldsAction).toHaveBeenCalledTimes(1));
    expect(mocks.createEntityWithFieldsAction).toHaveBeenCalledWith(
      "dom-1",
      { name: "Order", description: "", fields: [] },
      "prod-1"
    );
    expect(mocks.createTenantEntityAction).not.toHaveBeenCalled();
    await waitFor(() => expect(mocks.push).toHaveBeenCalledWith("/schemas/payments/checkout"));
  });

  it("offers every creation method", () => {
    render(<EntityCreationWizard target={PRODUCT_TARGET} />);
    expect(screen.getByText("Describe in Natural Language")).toBeDefined();
  });
});
