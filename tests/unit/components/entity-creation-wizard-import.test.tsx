/**
 * EntityCreationWizard — import routing (Epic 15.5 / 15.6).
 *
 * @vitest-environment jsdom
 */
import { readFileSync } from "node:fs";
import path from "node:path";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { cleanup, fireEvent, render, screen, waitFor } from "@testing-library/react";
import { EntityCreationWizard } from "@/components/custom/EntityCreationWizard/EntityCreationWizard";

const mocks = vi.hoisted(() => ({
  push: vi.fn(),
  refresh: vi.fn(),
  invalidate: vi.fn(),
  createEntityWithFieldsAction: vi.fn(),
  createDomainAssetsFromImportAction: vi.fn(),
  createTenantEntityAction: vi.fn(),
}));

vi.mock("next/navigation", () => ({
  useRouter: () => ({ push: mocks.push, refresh: mocks.refresh }),
}));
vi.mock("@/app/(dashboard)/schemas/[domainSlug]/actions", () => ({
  createEntityWithFieldsAction: mocks.createEntityWithFieldsAction,
  createDomainAssetsFromImportAction: mocks.createDomainAssetsFromImportAction,
}));
vi.mock("@/app/(dashboard)/schemas/enterprise/actions", () => ({
  createTenantEntityAction: mocks.createTenantEntityAction,
}));
vi.mock("@/app/(dashboard)/schemas/[domainSlug]/typespec-import-actions", () => ({
  importTypeSpecDocumentAction: vi.fn(),
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

const ORDER_PROTO = readFileSync(
  path.resolve(process.cwd(), "tests/fixtures/importers/order.proto"),
  "utf8"
);

function pasteAndParse(content: string) {
  fireEvent.click(screen.getByRole("button", { name: /Import Schema/ }));
  fireEvent.change(screen.getByPlaceholderText(/Paste your schema content here/), {
    target: { value: content },
  });
  fireEvent.click(screen.getByRole("button", { name: /Parse Schema/ }));
}

beforeEach(() => {
  vi.clearAllMocks();
  mocks.createDomainAssetsFromImportAction.mockResolvedValue({
    modelsCreated: 4,
    entitiesCreated: 4,
    enumsCreated: 2,
    scalarsCreated: 0,
    unionsCreated: 0,
    servicesCreated: 0,
    decoratorsCreated: 0,
    entityIds: [],
    modelIds: [],
    errors: [],
  });
});

afterEach(cleanup);

describe("EntityCreationWizard — multi-entity import", () => {
  it("sends a multi-message proto through the multi-asset review and persists it in the product", async () => {
    render(<EntityCreationWizard target={PRODUCT_TARGET} />);
    pasteAndParse(ORDER_PROTO);

    await waitFor(() => expect(screen.getByTestId("typespec-import-review")).toBeDefined());
    expect(screen.getByText("Review Protobuf Import")).toBeDefined();

    fireEvent.click(screen.getByRole("button", { name: /Import \d+ Asset\(s\)/ }));
    await waitFor(() => expect(mocks.createDomainAssetsFromImportAction).toHaveBeenCalledTimes(1));
    const payload = mocks.createDomainAssetsFromImportAction.mock.calls[0][0];
    expect(payload).toMatchObject({ domainId: "dom-1", productId: "prod-1" });
    expect(payload.entities).toHaveLength(4);
    await waitFor(() => expect(mocks.push).toHaveBeenCalledWith("/schemas/payments/checkout"));
  });

  it("keeps a single-message proto on the field preview", async () => {
    render(<EntityCreationWizard target={PRODUCT_TARGET} />);
    pasteAndParse(`syntax = "proto3";\nmessage User { string id = 1; }`);

    await waitFor(() => expect(screen.getByDisplayValue("User")).toBeDefined());
    expect(screen.queryByTestId("typespec-import-review")).toBeNull();
  });

  it("explains that a multi-asset document needs a domain at the Enterprise level", async () => {
    render(<EntityCreationWizard target={{ level: "TENANT", tenantId: "tenant-1" }} />);
    pasteAndParse(ORDER_PROTO);

    expect(await screen.findByText(/defines 6 assets/)).toBeDefined();
    expect(screen.queryByTestId("typespec-import-review")).toBeNull();
  });
});
