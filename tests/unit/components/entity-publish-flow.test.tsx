/**
 * @vitest-environment jsdom
 */
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { cleanup, fireEvent, render, screen, waitFor } from "@testing-library/react";
import {
  EntityWorkspace,
  type EntityWorkspaceProps,
} from "@/app/(dashboard)/schemas/[domainSlug]/[productSlug]/[entityId]/entity-workspace";

const mocks = vi.hoisted(() => ({
  getPreview: vi.fn(),
  publish: vi.fn(),
  listVersions: vi.fn(),
  listUsages: vi.fn(),
  getHistory: vi.fn(),
  updateMetadata: vi.fn(),
  refresh: vi.fn(),
  toastError: vi.fn(),
  toastSuccess: vi.fn(),
}));

vi.mock("next/navigation", () => ({
  useRouter: () => ({ push: vi.fn(), replace: vi.fn(), refresh: mocks.refresh }),
}));
vi.mock("@/lib/recent-entities", () => ({ trackRecentEntity: vi.fn() }));
vi.mock("sonner", () => ({ toast: { error: mocks.toastError, success: mocks.toastSuccess } }));
vi.mock("@/hooks/useDomainsTree", () => ({ useInvalidateDomainsTree: () => vi.fn() }));
vi.mock("@/app/(dashboard)/schemas/[domainSlug]/[productSlug]/[entityId]/actions", () => ({
  getVersionHistoryAction: mocks.getHistory,
  updateEntityMetadataAction: mocks.updateMetadata,
}));
vi.mock("@/app/(dashboard)/schemas/[domainSlug]/[productSlug]/[entityId]/version-actions", () => ({
  getPublishPreviewAction: mocks.getPreview,
  publishEntityAction: mocks.publish,
  listEntityVersionsAction: mocks.listVersions,
}));
vi.mock("@/app/(dashboard)/schemas/usage-actions", () => ({ listUsagesAction: mocks.listUsages }));
vi.mock("@/app/(dashboard)/schemas/[domainSlug]/actions", () => ({ deleteEntityAction: vi.fn() }));
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
vi.mock("@/features/governance/RetentionPolicyEditor/RetentionPolicyEditor", () => ({
  RetentionPolicyEditor: ({ onSave }: { onSave: (id: string, policy: unknown) => Promise<void> }) => (
    <button data-testid="retention-save" onClick={() => void onSave("ent-1", { period: "P1Y" })}>
      save retention
    </button>
  ),
}));

beforeEach(() => {
  vi.clearAllMocks();
  mocks.getHistory.mockResolvedValue({ versions: [] });
  mocks.listVersions.mockResolvedValue({ success: true, versions: [] });
  mocks.listUsages.mockResolvedValue({ success: true, data: [] });
});
afterEach(cleanup);

function props(entity: Partial<EntityWorkspaceProps["entity"]> = {}): EntityWorkspaceProps {
  return {
    level: "PRODUCT",
    entity: {
      id: "ent-1", name: "Customer", slug: "customer", description: "", status: "DRAFT", version: 1, metadata: null,
      domainId: "dom-1", domainName: "Payments", domainSlug: "payments", productSlug: "checkout", productName: "Checkout",
      ...entity,
    },
    domainPolicy: null,
    fields: [],
    apiServiceId: null,
    apiOperations: [],
  };
}

const PREVIEW = {
  isFirstPublish: true, latestLabel: null, suggestedBump: null, candidateLabels: null, initialLabel: "1.0",
  reasons: [], diffSummary: { added: 1, removed: 0, modified: 0 }, blockers: [], warnings: [], pins: [],
};

describe("Used-by panel on the versions tab", () => {
  it("looks up who uses the entity and lists the referrers under the published versions", async () => {
    mocks.listUsages.mockResolvedValue({
      success: true,
      data: [{ id: "r1", fromKind: "MESSAGE", role: "PAYLOAD", isDraft: true, target: "Customer v1.0", label: "Message CustomerSeen (draft)", href: "/schemas/payments/checkout?tab=events&section=messages" }],
    });
    render(<EntityWorkspace {...props()} />);
    expect(screen.queryByTestId("used-by-panel")).toBeNull();
    fireEvent.click(screen.getByTestId("tab-versions"));

    expect(await screen.findByRole("link", { name: "Message CustomerSeen (draft)" })).toBeDefined();
    expect(screen.getByTestId("used-by-panel")).toBeDefined();
    expect(mocks.listUsages).toHaveBeenCalledWith({ kind: "entity", entityId: "ent-1" });
  });

  it("works for a tenant-level entity (no domain or product)", async () => {
    const tenant = {
      ...props({ domainId: null, domainName: "Enterprise", domainSlug: null, productSlug: null, productName: null }),
      level: "TENANT" as const,
    };
    render(<EntityWorkspace {...tenant} />);
    fireEvent.click(screen.getByTestId("tab-versions"));

    expect(await screen.findByText("Nothing references this yet.")).toBeDefined();
    expect(mocks.listUsages).toHaveBeenCalledWith({ kind: "entity", entityId: "ent-1" });
  });

  it("keeps the published versions list usable when the lookup fails", async () => {
    mocks.listUsages.mockRejectedValue(new Error("network down"));
    render(<EntityWorkspace {...props()} />);
    fireEvent.click(screen.getByTestId("tab-versions"));

    expect((await screen.findByRole("alert")).textContent).toBe("Could not load usages. Try again.");
    expect(await screen.findByTestId("entity-version-list-empty")).toBeDefined();
  });
});

describe("published versions tab", () => {
  it("shows the load error instead of 'Not published yet' when listing versions fails", async () => {
    mocks.listVersions.mockResolvedValue({ error: "Entity not found" });
    render(<EntityWorkspace {...props()} />);
    fireEvent.click(screen.getByTestId("tab-versions"));

    const alert = await screen.findByTestId("versions-error");
    expect(alert.textContent).toContain("Entity not found");
    expect(screen.queryByTestId("entity-version-list-empty")).toBeNull();
  });

  it("shows the error when the list action throws", async () => {
    mocks.listVersions.mockRejectedValue(new Error("network down"));
    render(<EntityWorkspace {...props()} />);
    fireEvent.click(screen.getByTestId("tab-versions"));

    expect((await screen.findByTestId("versions-error")).textContent).toContain("network down");
    expect(screen.queryByTestId("entity-version-list-empty")).toBeNull();
  });

  it("does not claim 'Not published yet' while the first load is still running", async () => {
    mocks.listVersions.mockReturnValue(new Promise(() => {}));
    render(<EntityWorkspace {...props()} />);
    fireEvent.click(screen.getByTestId("tab-versions"));

    expect(await screen.findByTestId("versions-loading")).toBeDefined();
    expect(screen.queryByTestId("entity-version-list-empty")).toBeNull();
  });

  it("lists the published versions when loading succeeds", async () => {
    mocks.listVersions.mockResolvedValue({
      success: true,
      versions: [
        { id: "v1", entityId: "ent-1", major: 1, minor: 0, label: "1.0", sequence: 1, changeKind: "INITIAL", changeSummary: null, publishedById: "u", publishedByName: "Ada", publishedAt: "2026-10-14T10:00:00.000Z" },
      ],
    });
    render(<EntityWorkspace {...props()} />);
    fireEvent.click(screen.getByTestId("tab-versions"));

    expect((await screen.findByTestId("entity-version-list")).textContent).toContain("v1.0");
  });
});

describe("publish dialog failure paths", () => {
  it("shows an error and stops the spinner when loading the preview throws", async () => {
    mocks.getPreview.mockRejectedValue(new Error("preview exploded"));
    render(<EntityWorkspace {...props()} />);
    fireEvent.click(screen.getByTestId("publish-entity-button"));

    const alert = await screen.findByRole("alert");
    expect(alert.textContent).toContain("preview exploded");
    expect(screen.queryByText(/Checking changes/)).toBeNull();
  });

  it("shows the preview error when the action returns one", async () => {
    mocks.getPreview.mockResolvedValue({ error: "Not authenticated" });
    render(<EntityWorkspace {...props()} />);
    fireEvent.click(screen.getByTestId("publish-entity-button"));

    expect((await screen.findByRole("alert")).textContent).toContain("Not authenticated");
    expect(screen.queryByText(/Checking changes/)).toBeNull();
  });

  it("shows the error, re-enables Publish and does not announce success when publishing throws", async () => {
    mocks.getPreview.mockResolvedValue({ success: true, preview: PREVIEW });
    mocks.publish.mockRejectedValue(new Error("server blew up"));
    render(<EntityWorkspace {...props()} />);
    fireEvent.click(screen.getByTestId("publish-entity-button"));

    const confirm = await screen.findByTestId("confirm-publish");
    fireEvent.click(confirm);

    await waitFor(() => expect(screen.getByRole("alert").textContent).toContain("server blew up"));
    expect(screen.getByTestId("confirm-publish").hasAttribute("disabled")).toBe(false);
    expect(mocks.toastSuccess).not.toHaveBeenCalled();
    expect(mocks.refresh).not.toHaveBeenCalled();
  });

  it("closes the dialog, updates the header and toasts on a successful publish", async () => {
    mocks.getPreview.mockResolvedValue({ success: true, preview: PREVIEW });
    mocks.publish.mockResolvedValue({
      success: true,
      version: { id: "v1", entityId: "ent-1", major: 1, minor: 0, label: "1.0", sequence: 1, changeKind: "INITIAL", changeSummary: null, publishedById: "u", publishedByName: "Ada", publishedAt: "2026-10-14T10:00:00.000Z" },
    });
    render(<EntityWorkspace {...props()} />);
    fireEvent.click(screen.getByTestId("publish-entity-button"));
    fireEvent.click(await screen.findByTestId("confirm-publish"));

    await waitFor(() => expect(mocks.toastSuccess).toHaveBeenCalledWith("Published Customer v1.0"));
    expect(screen.getByTestId("entity-version-state").textContent).toBe("Published · v1.0");
    expect(mocks.refresh).toHaveBeenCalled();
  });
});

describe("retention editor save", () => {
  it("marks the draft dirty like the other draft-mutating paths", async () => {
    mocks.updateMetadata.mockResolvedValue({ success: true });
    render(<EntityWorkspace {...props({ latestVersionLabel: "1.0", hasUnpublishedChanges: false })} />);
    expect(screen.getByTestId("entity-version-state").textContent).toBe("Published · v1.0");

    fireEvent.click(screen.getByTestId("tab-governance"));
    fireEvent.click(await screen.findByTestId("retention-save"));

    await waitFor(() =>
      expect(screen.getByTestId("entity-version-state").textContent).toBe("Draft · unpublished changes · latest v1.0")
    );
    expect(mocks.updateMetadata).toHaveBeenCalledWith("ent-1", { retentionPolicy: { period: "P1Y" } });
    expect(mocks.toastSuccess).toHaveBeenCalledWith("Retention policy saved");
  });

  it("does not mark the draft dirty, and says so, when the save fails", async () => {
    mocks.updateMetadata.mockResolvedValue({ error: "Entity not found" });
    render(<EntityWorkspace {...props({ latestVersionLabel: "1.0", hasUnpublishedChanges: false })} />);

    fireEvent.click(screen.getByTestId("tab-governance"));
    fireEvent.click(await screen.findByTestId("retention-save"));

    await waitFor(() => expect(mocks.toastError).toHaveBeenCalledWith("Entity not found"));
    expect(screen.getByTestId("entity-version-state").textContent).toBe("Published · v1.0");
    expect(mocks.toastSuccess).not.toHaveBeenCalled();
  });
});
