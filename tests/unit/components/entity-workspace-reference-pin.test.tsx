/**
 * The pin control on the entity page: a reference field of the entity lists the REFERENCED entity's published versions and pins one (or
 * removes the pin) with `setFieldReferenceAction` on this entity's field. A pin is a draft change like any other edit of the field.
 *
 * @vitest-environment jsdom
 */
import { afterEach, beforeAll, beforeEach, describe, expect, it, vi } from "vitest";
import { cleanup, fireEvent, render, screen, waitFor } from "@testing-library/react";
import {
  EntityWorkspace,
  type EntityWorkspaceProps,
} from "@/app/(dashboard)/schemas/[domainSlug]/[productSlug]/[entityId]/entity-workspace";

const mocks = vi.hoisted(() => ({
  listVersions: vi.fn(),
  setReference: vi.fn(),
  toastError: vi.fn(),
  toastSuccess: vi.fn(),
}));

vi.mock("next/navigation", () => ({
  useSearchParams: () => new URLSearchParams(),
  useRouter: () => ({ push: vi.fn(), replace: vi.fn(), refresh: vi.fn() }),
}));
vi.mock("@/lib/recent-entities", () => ({ trackRecentEntity: vi.fn() }));
vi.mock("sonner", () => ({ toast: { error: mocks.toastError, success: mocks.toastSuccess } }));
vi.mock("@/hooks/useDomainsTree", () => ({ useInvalidateDomainsTree: () => vi.fn() }));
vi.mock("@/app/(dashboard)/schemas/[domainSlug]/[productSlug]/[entityId]/actions", () => ({
  getVersionHistoryAction: vi.fn().mockResolvedValue({ versions: [] }),
  updateEntityMetadataAction: vi.fn(),
  addFieldAction: vi.fn(),
  updateFieldAction: vi.fn(),
  deleteFieldAction: vi.fn(),
  setFieldReferenceAction: mocks.setReference,
}));
vi.mock("@/app/(dashboard)/schemas/[domainSlug]/[productSlug]/[entityId]/version-actions", () => ({
  getPublishPreviewAction: vi.fn(),
  publishEntityAction: vi.fn(),
  listEntityVersionsAction: mocks.listVersions,
}));
vi.mock("@/app/(dashboard)/schemas/usage-actions", () => ({ listUsagesAction: vi.fn().mockResolvedValue({ success: true, data: { rows: [], truncated: false } }) }));
vi.mock("@/app/(dashboard)/schemas/[domainSlug]/actions", () => ({ deleteEntityAction: vi.fn() }));
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

beforeAll(() => {
  // cmdk (the type picker's search list) needs these browser APIs.
  globalThis.ResizeObserver ??= class {
    observe() {}
    unobserve() {}
    disconnect() {}
  };
  Element.prototype.scrollIntoView ??= () => {};
});

beforeEach(() => {
  vi.clearAllMocks();
  mocks.listVersions.mockResolvedValue({
    success: true,
    versions: [
      { id: "a2", entityId: "ent-addr", major: 2, minor: 0, label: "2.0", sequence: 2, changeKind: "MAJOR", changeSummary: null, publishedById: "u", publishedByName: null, publishedAt: "2026-10-14T10:00:00.000Z" },
      { id: "a1", entityId: "ent-addr", major: 1, minor: 0, label: "1.0", sequence: 1, changeKind: "INITIAL", changeSummary: null, publishedById: "u", publishedByName: null, publishedAt: "2026-10-01T10:00:00.000Z" },
    ],
  });
  mocks.setReference.mockResolvedValue({ success: true, data: undefined });
});
afterEach(cleanup);

const REFERENCE_FIELD = {
  id: "f9", slug: "billing-address", name: "billingAddress", type: "reference", precision: null, scale: null, nullable: true, isKey: false,
  fieldNumber: null, description: "", classification: null, aliases: [], sortOrder: 0,
  decorators: { referencedEntityId: "ent-addr", referencedEntityName: "Address", referencedQualifiedName: "Billing/Core/Address" },
};

function props(over: Partial<EntityWorkspaceProps["entity"]> = {}): EntityWorkspaceProps {
  return {
    level: "PRODUCT",
    entity: {
      id: "ent-1", name: "Customer", slug: "customer", description: "", status: "DRAFT", version: 1, metadata: null,
      domainId: "dom-1", domainName: "Payments", domainSlug: "payments", productSlug: "checkout", productName: "Checkout",
      latestVersionLabel: "1.0", hasUnpublishedChanges: false,
      ...over,
    },
    domainPolicy: null,
    fields: [REFERENCE_FIELD],
    apiServiceId: null,
    apiOperations: [],
  };
}

describe("pinning a reference field's version on the entity page", () => {
  it("lists the referenced entity's published versions, pins the chosen one on this field and marks the draft changed", async () => {
    render(<EntityWorkspace {...props()} />);
    expect(screen.getByTestId("entity-version-state").textContent).toBe("Published · v1.0");

    fireEvent.click(screen.getByTestId("reference-pin-open"));
    const select = (await screen.findByTestId("reference-pin-control")) as HTMLSelectElement;

    expect(mocks.listVersions).toHaveBeenCalledWith("ent-addr");
    expect(Array.from(select.options).map((o) => o.value)).toEqual(["", "2.0", "1.0"]);

    fireEvent.change(select, { target: { value: "1.0" } });

    await waitFor(() => expect(mocks.setReference).toHaveBeenCalledWith("ent-1", "f9", { entityId: "ent-addr", pinnedVersion: "1.0" }));
    expect((await screen.findByTestId("reference-pin-badge")).textContent).toContain("v1.0");
    await waitFor(() => expect(screen.getByTestId("entity-version-state").textContent).toBe("Draft · unpublished changes · latest v1.0"));
  });

  it("unpins with null (the reference goes back to meaning the latest published version)", async () => {
    const withPin = { ...REFERENCE_FIELD, decorators: { ...REFERENCE_FIELD.decorators, referencedEntityVersion: "1.0" } };
    render(<EntityWorkspace {...props()} fields={[withPin]} />);
    expect(screen.getByTestId("reference-pin-badge").textContent).toContain("v1.0");

    fireEvent.click(screen.getByTestId("reference-pin-open"));
    fireEvent.change(await screen.findByTestId("reference-pin-control"), { target: { value: "" } });

    await waitFor(() => expect(mocks.setReference).toHaveBeenCalledWith("ent-1", "f9", { entityId: "ent-addr", pinnedVersion: null }));
    await waitFor(() => expect(screen.queryByTestId("reference-pin-badge")).toBeNull());
  });

  it("shows the action's refusal beside the control and does not mark the draft", async () => {
    mocks.setReference.mockResolvedValue({ success: false, error: { code: "VALIDATION_ERROR", message: "Address has no published version 2.0" } });
    render(<EntityWorkspace {...props()} />);

    fireEvent.click(screen.getByTestId("reference-pin-open"));
    fireEvent.change(await screen.findByTestId("reference-pin-control"), { target: { value: "2.0" } });

    expect((await screen.findByRole("alert")).textContent).toBe("Address has no published version 2.0");
    expect(screen.getByTestId("entity-version-state").textContent).toBe("Published · v1.0");
    expect(screen.queryByTestId("reference-pin-badge")).toBeNull();
  });

  it("offers no pin control on a read-only (retired) entity", () => {
    render(<EntityWorkspace {...props({ status: "RETIRED" })} />);
    expect(screen.queryByTestId("reference-pin-open")).toBeNull();
  });
});
