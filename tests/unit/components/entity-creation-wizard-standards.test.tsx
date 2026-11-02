/**
 * @vitest-environment jsdom
 */
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { cleanup, fireEvent, render, screen } from "@testing-library/react";
import { EntityCreationWizard } from "@/components/custom/EntityCreationWizard/EntityCreationWizard";

const mocks = vi.hoisted(() => ({
  push: vi.fn(),
  refresh: vi.fn(),
  invalidate: vi.fn(),
}));

vi.mock("next/navigation", () => ({
  useRouter: () => ({ push: mocks.push, refresh: mocks.refresh }),
}));
vi.mock("@/app/(dashboard)/schemas/[domainSlug]/actions", () => ({
  createEntityWithFieldsAction: vi.fn(),
}));
vi.mock("@/app/(dashboard)/schemas/enterprise/actions", () => ({
  createTenantEntityAction: vi.fn(),
}));
vi.mock("@/app/(dashboard)/schemas/[domainSlug]/typespec-import-actions", () => ({
  importTypeSpecDocumentAction: vi.fn(),
}));
vi.mock("@/app/(dashboard)/schemas/[domainSlug]/openapi-import-actions", () => ({
  importOpenApiDocumentAction: vi.fn(),
}));
vi.mock("@/hooks/useDomainsTree", () => ({ useInvalidateDomainsTree: () => mocks.invalidate }));
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

beforeEach(() => {
  vi.clearAllMocks();
});

afterEach(cleanup);

describe("EntityCreationWizard: Standards Library", () => {
  it("Back from the review returns to the populated Standards Library step, not an empty card", () => {
    render(<EntityCreationWizard target={PRODUCT_TARGET} />);

    fireEvent.click(screen.getByTestId("creation-method-standards"));
    const template = screen.getAllByTestId("standards-template")[0];
    const entityName = template.getAttribute("data-name");
    fireEvent.click(template);

    // The review step carries the chosen template.
    expect((screen.getByTestId("wizard-entity-name") as HTMLInputElement).value).toBe(entityName);

    fireEvent.click(screen.getByTestId("wizard-back"));

    expect(screen.getByTestId("standards-search")).toBeDefined();
    expect(screen.getAllByTestId("standards-template").length).toBeGreaterThan(0);
  });

  it("can pick a second template after Back from the review", () => {
    render(<EntityCreationWizard target={PRODUCT_TARGET} />);

    fireEvent.click(screen.getByTestId("creation-method-standards"));
    fireEvent.click(screen.getAllByTestId("standards-template")[0]);
    fireEvent.click(screen.getByTestId("wizard-back"));
    fireEvent.click(screen.getAllByTestId("standards-template")[1]);

    expect(screen.getByTestId("wizard-entity-name")).toBeDefined();
    expect(screen.queryByTestId("standards-search")).toBeNull();
  });
});
