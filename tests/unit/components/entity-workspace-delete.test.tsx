/**
 * Deleting an entity from its own page must refresh the explorer tree (its React Query cache is only
 * refreshed through invalidate; revalidatePath does not reach it), and only when the delete succeeded.
 *
 * @vitest-environment jsdom
 */
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { cleanup, fireEvent, render, screen, waitFor } from "@testing-library/react";
import {
  EntityWorkspace,
  type EntityWorkspaceProps,
} from "@/app/(dashboard)/schemas/[domainSlug]/[productSlug]/[entityId]/entity-workspace";

const mocks = vi.hoisted(() => ({ push: vi.fn(), invalidate: vi.fn(), deleteEntity: vi.fn() }));

vi.mock("next/navigation", () => ({
  useRouter: () => ({ push: mocks.push, replace: vi.fn(), refresh: vi.fn() }),
}));
vi.mock("@/hooks/useDomainsTree", () => ({ useInvalidateDomainsTree: () => mocks.invalidate }));
vi.mock("@/lib/recent-entities", () => ({ trackRecentEntity: vi.fn() }));
vi.mock("sonner", () => ({ toast: { error: vi.fn(), success: vi.fn() } }));
vi.mock("@/app/(dashboard)/schemas/[domainSlug]/[productSlug]/[entityId]/actions", () => ({}));
vi.mock("@/app/(dashboard)/schemas/[domainSlug]/[productSlug]/[entityId]/version-actions", () => ({
  getPublishPreviewAction: vi.fn(),
  publishEntityAction: vi.fn(),
  listEntityVersionsAction: vi.fn(),
}));
vi.mock("@/app/(dashboard)/schemas/usage-actions", () => ({ listUsagesAction: vi.fn().mockResolvedValue({ success: true, data: [] }) }));
vi.mock("@/app/(dashboard)/schemas/[domainSlug]/actions", () => ({ deleteEntityAction: mocks.deleteEntity }));
vi.mock("@/app/(dashboard)/schemas/[domainSlug]/[productSlug]/[entityId]/field-editor", () => ({ FieldEditor: () => null }));
vi.mock("@/app/(dashboard)/schemas/[domainSlug]/[productSlug]/[entityId]/components/SchemasTab", () => ({ SchemasTab: () => null }));
vi.mock("@/app/(dashboard)/schemas/[domainSlug]/[productSlug]/[entityId]/components/EntityDeploymentsTab", () => ({ EntityDeploymentsTab: () => null }));
vi.mock("@/app/(dashboard)/schemas/[domainSlug]/[productSlug]/[entityId]/components/TypeSpecSourceTab", () => ({ TypeSpecSourceTab: () => null }));
vi.mock("@/app/(dashboard)/schemas/[domainSlug]/[productSlug]/[entityId]/components/RightPanelRouter", () => ({ RightPanelRouter: () => null }));
vi.mock("@/app/(dashboard)/schemas/[domainSlug]/[productSlug]/[entityId]/components/InlineEntityMeta", () => ({ InlineEntityMeta: () => null }));
vi.mock("@/app/(dashboard)/schemas/[domainSlug]/[productSlug]/[entityId]/components/AlertsTab", () => ({ AlertsTab: () => null }));
vi.mock("@/app/(dashboard)/schemas/[domainSlug]/[productSlug]/[entityId]/components/ApiTab", () => ({ ApiTab: () => null }));
vi.mock("@/components/custom/DiffViewer", () => ({ DiffViewer: () => null }));
vi.mock("@/components/custom/TypeMappingOverrideDialog", () => ({ TypeMappingOverrideDialog: () => null }));
vi.mock("@/components/custom/ChangeHistoryView", () => ({ ChangeHistoryView: () => null }));
vi.mock("@/features/governance/RetentionPolicyEditor/RetentionPolicyEditor", () => ({ RetentionPolicyEditor: () => null }));

beforeEach(() => vi.clearAllMocks());
afterEach(cleanup);

const props: EntityWorkspaceProps = {
  level: "PRODUCT",
  entity: {
    id: "ent-1",
    name: "Customer",
    slug: "customer",
    description: "",
    status: "DRAFT",
    version: 1,
    metadata: null,
    domainId: "dom-1",
    domainName: "Payments",
    domainSlug: "payments",
    productSlug: "checkout",
    productName: "Checkout",
  },
  domainPolicy: null,
  fields: [],
  apiServiceId: null,
  apiOperations: [],
} as EntityWorkspaceProps;

function openDeleteDialog() {
  render(<EntityWorkspace {...props} />);
  fireEvent.click(screen.getByTitle("Delete entity"));
  return screen.getByRole("dialog");
}

describe("EntityWorkspace delete refreshes the explorer", () => {
  it("invalidates the tree and returns to the product after a successful delete", async () => {
    mocks.deleteEntity.mockResolvedValue({ success: true });
    const dialog = openDeleteDialog();
    fireEvent.click(dialog.querySelector("button:last-of-type") as HTMLButtonElement);
    await waitFor(() => expect(mocks.deleteEntity).toHaveBeenCalledWith("ent-1"));
    await waitFor(() => expect(mocks.invalidate).toHaveBeenCalledTimes(1));
    expect(mocks.push).toHaveBeenCalledWith("/schemas/payments/checkout");
  });

  it("does not invalidate when the delete is refused", async () => {
    mocks.deleteEntity.mockResolvedValue({ error: "Entity is in use" });
    const dialog = openDeleteDialog();
    fireEvent.click(dialog.querySelector("button:last-of-type") as HTMLButtonElement);
    await waitFor(() => expect(mocks.deleteEntity).toHaveBeenCalledWith("ent-1"));
    await waitFor(() => expect(screen.queryByRole("dialog")).toBeNull());
    expect(mocks.invalidate).not.toHaveBeenCalled();
    expect(mocks.push).not.toHaveBeenCalled();
  });
});
