/**
 * Publishing an entity whose closure holds an ambiguous bare-name reference: the pick dialog opens from the publish PREVIEW (before the
 * user clicks Publish) and from a REFUSED publish (the plan changed after the preview), the pick is saved on the entity + field that hold
 * the reference (often a member of the closure, not this entity), and the operation runs once more.
 *
 * @vitest-environment jsdom
 */
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { cleanup, fireEvent, render, screen, waitFor, within } from "@testing-library/react";
import {
  EntityWorkspace,
  type EntityWorkspaceProps,
} from "@/app/(dashboard)/schemas/[domainSlug]/[productSlug]/[entityId]/entity-workspace";

const mocks = vi.hoisted(() => ({
  getPreview: vi.fn(),
  publish: vi.fn(),
  listVersions: vi.fn(),
  setReference: vi.fn(),
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
  getVersionHistoryAction: vi.fn().mockResolvedValue({ versions: [] }),
  updateEntityMetadataAction: vi.fn(),
  setFieldReferenceAction: mocks.setReference,
}));
vi.mock("@/app/(dashboard)/schemas/[domainSlug]/[productSlug]/[entityId]/version-actions", () => ({
  getPublishPreviewAction: mocks.getPreview,
  publishEntityAction: mocks.publish,
  listEntityVersionsAction: mocks.listVersions,
}));
vi.mock("@/app/(dashboard)/schemas/usage-actions", () => ({ listUsagesAction: vi.fn().mockResolvedValue({ success: true, data: { rows: [], truncated: false } }) }));
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
vi.mock("@/features/governance/RetentionPolicyEditor/RetentionPolicyEditor", () => ({ RetentionPolicyEditor: () => null }));

beforeEach(() => {
  vi.clearAllMocks();
  mocks.listVersions.mockResolvedValue({ success: true, versions: [] });
});
afterEach(cleanup);

function props(): EntityWorkspaceProps {
  return {
    level: "PRODUCT",
    entity: {
      id: "ent-1", name: "Customer", slug: "customer", description: "", status: "DRAFT", version: 1, metadata: null,
      domainId: "dom-1", domainName: "Payments", domainSlug: "payments", productSlug: "checkout", productName: "Checkout",
    },
    domainPolicy: null,
    fields: [],
    apiServiceId: null,
    apiOperations: [],
  };
}

const CANDIDATES = [
  { entityId: "x1", domain: "d1", product: "p1", entity: "Address" },
  { entityId: "x2", domain: "d2", product: "p2", entity: "Address" },
];
// The reference is held by a MEMBER of the closure ("member-1"), not by the entity on screen ("ent-1").
const DETAILS = { field: "addr", name: "Address", candidates: CANDIDATES, entityId: "member-1", fieldId: "fld-9" };
const AMBIGUOUS_BLOCKER = {
  kind: "CLOSURE_BLOCKED",
  code: "AMBIGUOUS_REFERENCE",
  message: 'Field "addr" refers to "Address", which matches 2 entities.',
  entityId: "member-1",
  details: DETAILS,
};
const CLEAR_PREVIEW = {
  isFirstPublish: true, latestLabel: null, suggestedBump: null, candidateLabels: null, initialLabel: "1.0",
  reasons: [], diffSummary: { added: 1, removed: 0, modified: 0 }, blockers: [], warnings: [], pins: [],
};
const BLOCKED_PREVIEW = { ...CLEAR_PREVIEW, blockers: [AMBIGUOUS_BLOCKER] };
const VERSION = { id: "v1", entityId: "ent-1", major: 1, minor: 0, label: "1.0", sequence: 1, changeKind: "INITIAL", changeSummary: null, publishedById: "u", publishedByName: "Ada", publishedAt: "2026-10-14T10:00:00.000Z" };

describe("the publish preview names an ambiguous reference", () => {
  it("opens the pick dialog as soon as the preview shows it, saves the pick on the owning field and loads the preview again", async () => {
    mocks.getPreview.mockResolvedValueOnce({ success: true, preview: BLOCKED_PREVIEW }).mockResolvedValueOnce({ success: true, preview: CLEAR_PREVIEW });
    mocks.setReference.mockResolvedValue({ success: true, data: undefined });
    render(<EntityWorkspace {...props()} />);

    fireEvent.click(screen.getByTestId("publish-entity-button"));
    const dialog = await screen.findByTestId("reference-pick-dialog");
    expect(within(dialog).getAllByTestId("reference-pick-candidate").map((el) => el.textContent)).toEqual(["d1 / p1 / Address", "d2 / p2 / Address"]);
    // nothing was published, and nothing is written before the pick
    expect(mocks.publish).not.toHaveBeenCalled();
    expect(mocks.setReference).not.toHaveBeenCalled();

    fireEvent.click(within(dialog).getAllByTestId("reference-pick-candidate")[1]);

    await waitFor(() => expect(mocks.getPreview).toHaveBeenCalledTimes(2));
    expect(mocks.setReference).toHaveBeenCalledWith("member-1", "fld-9", { entityId: "x2" });
    // the blocker is gone, so Publish can be clicked
    await waitFor(() => expect((screen.getByTestId("confirm-publish") as HTMLButtonElement).disabled).toBe(false));
    expect(screen.queryByTestId("reference-pick-dialog")).toBeNull();
    expect(mocks.publish).not.toHaveBeenCalled();
  });

  it("Cancel keeps the blocker listed, with a button to choose again", async () => {
    mocks.getPreview.mockResolvedValue({ success: true, preview: BLOCKED_PREVIEW });
    mocks.setReference.mockResolvedValue({ success: true, data: undefined });
    render(<EntityWorkspace {...props()} />);

    fireEvent.click(screen.getByTestId("publish-entity-button"));
    fireEvent.click(await within(await screen.findByTestId("reference-pick-dialog")).findByRole("button", { name: /cancel/i }));

    await waitFor(() => expect(screen.queryByTestId("reference-pick-dialog")).toBeNull());
    expect(screen.getByText(AMBIGUOUS_BLOCKER.message)).toBeDefined();
    expect((screen.getByTestId("confirm-publish") as HTMLButtonElement).disabled).toBe(true);
    expect(mocks.setReference).not.toHaveBeenCalled();

    fireEvent.click(screen.getByTestId("publish-pick-reference"));

    expect(await screen.findByTestId("reference-pick-dialog")).toBeDefined();
  });

  it("offers no pick button for a blocker that is not an ambiguous reference", async () => {
    mocks.getPreview.mockResolvedValue({
      success: true,
      preview: { ...CLEAR_PREVIEW, blockers: [{ kind: "NO_CHANGES", message: "No unpublished changes since v1.0." }] },
    });
    render(<EntityWorkspace {...props()} />);

    fireEvent.click(screen.getByTestId("publish-entity-button"));

    expect(await screen.findByText("No unpublished changes since v1.0.")).toBeDefined();
    expect(screen.queryByTestId("publish-pick-reference")).toBeNull();
    expect(screen.queryByTestId("reference-pick-dialog")).toBeNull();
  });
});

describe("a publish the server refuses for an ambiguous reference", () => {
  it("asks BEFORE showing the error, saves the pick and publishes once more", async () => {
    mocks.getPreview.mockResolvedValue({ success: true, preview: CLEAR_PREVIEW });
    mocks.publish
      .mockResolvedValueOnce({ error: AMBIGUOUS_BLOCKER.message, code: "PUBLISH_BLOCKED", needsReference: DETAILS })
      .mockResolvedValueOnce({ success: true, version: VERSION });
    mocks.setReference.mockResolvedValue({ success: true, data: undefined });
    render(<EntityWorkspace {...props()} />);

    fireEvent.click(screen.getByTestId("publish-entity-button"));
    fireEvent.click(await screen.findByTestId("confirm-publish"));

    const dialog = await screen.findByTestId("reference-pick-dialog");
    // the refusal's own text is not shown while the question is open
    expect(screen.queryByText(AMBIGUOUS_BLOCKER.message)).toBeNull();

    fireEvent.click(within(dialog).getAllByTestId("reference-pick-candidate")[0]);

    await waitFor(() => expect(mocks.publish).toHaveBeenCalledTimes(2));
    expect(mocks.setReference).toHaveBeenCalledWith("member-1", "fld-9", { entityId: "x1" });
    expect(mocks.publish.mock.calls[1]).toEqual(mocks.publish.mock.calls[0]);
    await waitFor(() => expect(mocks.toastSuccess).toHaveBeenCalledWith("Published Customer v1.0"));
  });

  it("Cancel publishes nothing more and shows no error", async () => {
    mocks.getPreview.mockResolvedValue({ success: true, preview: CLEAR_PREVIEW });
    mocks.publish.mockResolvedValue({ error: AMBIGUOUS_BLOCKER.message, code: "PUBLISH_BLOCKED", needsReference: DETAILS });
    render(<EntityWorkspace {...props()} />);

    fireEvent.click(screen.getByTestId("publish-entity-button"));
    fireEvent.click(await screen.findByTestId("confirm-publish"));
    fireEvent.click(await within(await screen.findByTestId("reference-pick-dialog")).findByRole("button", { name: /cancel/i }));

    await waitFor(() => expect(screen.queryByTestId("reference-pick-dialog")).toBeNull());
    expect(mocks.publish).toHaveBeenCalledTimes(1);
    expect(mocks.setReference).not.toHaveBeenCalled();
    expect(screen.queryByRole("alert")).toBeNull();
    expect((screen.getByTestId("confirm-publish") as HTMLButtonElement).disabled).toBe(false);
  });

  it("a pick the server still finds ambiguous shows the refusal's error instead of asking again", async () => {
    mocks.getPreview.mockResolvedValue({ success: true, preview: CLEAR_PREVIEW });
    mocks.publish.mockResolvedValue({ error: AMBIGUOUS_BLOCKER.message, code: "PUBLISH_BLOCKED", needsReference: DETAILS });
    mocks.setReference.mockResolvedValue({ success: true, data: undefined });
    render(<EntityWorkspace {...props()} />);

    fireEvent.click(screen.getByTestId("publish-entity-button"));
    fireEvent.click(await screen.findByTestId("confirm-publish"));
    fireEvent.click((await screen.findAllByTestId("reference-pick-candidate"))[0]);

    await waitFor(() => expect(screen.getByRole("alert").textContent).toContain(AMBIGUOUS_BLOCKER.message));
    expect(mocks.publish).toHaveBeenCalledTimes(2);
    expect(screen.queryByTestId("reference-pick-dialog")).toBeNull();
  });
});
