// @vitest-environment jsdom
import { useEffect, useSyncExternalStore, type MutableRefObject } from "react";
import { act, cleanup, fireEvent, render, screen, waitFor, within } from "@testing-library/react";
import "@testing-library/jest-dom/vitest";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { EntityWorkspace, type EntityWorkspaceProps } from "@/app/(dashboard)/schemas/[domainSlug]/[productSlug]/[entityId]/entity-workspace";

const mocks = vi.hoisted(() => {
  const push = vi.fn(), replace = vi.fn(), refresh = vi.fn();
  return { push, replace, refresh, router: { push, replace, refresh }, invalidate: vi.fn(), save: vi.fn(), discard: vi.fn(), emit: vi.fn(), history: vi.fn(), versions: vi.fn(), preview: vi.fn(), publish: vi.fn(), updateField: vi.fn(), deleteEntity: vi.fn() };
});
vi.mock("next/navigation", () => ({
  useRouter: () => mocks.router,
  useSearchParams: () => {
    const search = useSyncExternalStore(
      (notify) => { window.addEventListener("popstate", notify); return () => window.removeEventListener("popstate", notify); },
      () => window.location.search,
      () => "",
    );
    return new URLSearchParams(search);
  },
}));
vi.mock("@/hooks/useDomainsTree", () => ({ useInvalidateDomainsTree: () => mocks.invalidate }));
vi.mock("@/lib/recent-entities", () => ({ trackRecentEntity: vi.fn() }));
vi.mock("sonner", () => ({ toast: { error: vi.fn(), success: vi.fn(), warning: vi.fn() } }));
vi.mock("@/app/(dashboard)/schemas/[domainSlug]/[productSlug]/[entityId]/actions", () => ({
  addFieldAction: vi.fn(), updateFieldAction: mocks.updateField, deleteFieldAction: vi.fn(), updateEntityStatusAction: vi.fn(), emitEntityAction: mocks.emit,
  createTypeMappingOverrideAction: vi.fn(), acknowledgeLossyMappingAction: vi.fn(), getVersionHistoryAction: mocks.history, compareVersionsAction: vi.fn(), getChangeHistoryAction: vi.fn(), setFieldReferenceAction: vi.fn(), updateEntityMetadataAction: vi.fn(),
}));
vi.mock("@/app/(dashboard)/schemas/[domainSlug]/actions", () => ({ deleteEntityAction: mocks.deleteEntity }));
vi.mock("@/app/(dashboard)/schemas/[domainSlug]/[productSlug]/[entityId]/version-actions", () => ({ getPublishPreviewAction: mocks.preview, publishEntityAction: mocks.publish, listEntityVersionsAction: mocks.versions }));
vi.mock("@/app/(dashboard)/schemas/usage-actions", () => ({ listUsagesAction: vi.fn().mockResolvedValue({ success: true, data: { rows: [], truncated: false } }) }));
vi.mock("@/app/(dashboard)/schemas/[domainSlug]/[productSlug]/[entityId]/components/useReferencePick", () => ({ useReferencePick: () => ({ pickReference: async () => true, resolveReferences: (run: () => Promise<unknown>) => run(), dialog: null }) }));
vi.mock("@/app/(dashboard)/schemas/[domainSlug]/[productSlug]/[entityId]/field-editor", () => ({ FieldEditor: ({ onFieldSelect }: { onFieldSelect: (id: string) => void }) => <><button onClick={() => onFieldSelect("field-1")}>Select email</button><button onClick={() => onFieldSelect("field-2")}>Select name</button></> }));
vi.mock("@/app/(dashboard)/schemas/[domainSlug]/[productSlug]/[entityId]/components/RightPanelRouter", () => ({
  RightPanelRouter: ({ fieldSaveRef, fieldDiscardRef, onDirtyChange, onTypeSpecApplied }: {
    fieldSaveRef: MutableRefObject<(() => Promise<boolean>) | null>; fieldDiscardRef: MutableRefObject<(() => void) | null>; onDirtyChange: (dirty: boolean) => void; onTypeSpecApplied: () => void;
  }) => {
    useEffect(() => {
      const save = () => mocks.save(), discard = () => mocks.discard();
      fieldSaveRef.current = save; fieldDiscardRef.current = discard;
      return () => { if (fieldSaveRef.current === save) fieldSaveRef.current = null; if (fieldDiscardRef.current === discard) fieldDiscardRef.current = null; };
    }, [fieldSaveRef, fieldDiscardRef]);
    return <aside><button onClick={() => onDirtyChange(true)}>Edit local field</button><button onClick={onTypeSpecApplied}>Apply TypeSpec</button></aside>;
  },
}));
vi.mock("@/app/(dashboard)/schemas/[domainSlug]/[productSlug]/[entityId]/components/AlertsTab", () => ({ AlertsTab: ({ onNavigateToField, onNavigateToTab }: { onNavigateToField: (id: string) => void; onNavigateToTab: (tab: string) => void }) => <><button onClick={() => onNavigateToField("field-1")}>Fix email field</button><button onClick={() => onNavigateToTab("schemas")}>Fix schema target</button></> }));
vi.mock("@/app/(dashboard)/schemas/[domainSlug]/[productSlug]/[entityId]/components/EntityVersionList", () => ({ EntityVersionList: () => <p>Published versions loaded</p> }));
vi.mock("@/app/(dashboard)/schemas/[domainSlug]/[productSlug]/[entityId]/components/SchemasTab", () => ({ SchemasTab: () => <p>Generated schemas view</p> }));
vi.mock("@/app/(dashboard)/schemas/[domainSlug]/[productSlug]/[entityId]/components/EntityDeploymentsTab", () => ({ EntityDeploymentsTab: () => null }));
vi.mock("@/app/(dashboard)/schemas/[domainSlug]/[productSlug]/[entityId]/components/TypeSpecSourceTab", () => ({ TypeSpecSourceTab: () => <p>TypeSpec source view</p> }));
vi.mock("@/app/(dashboard)/schemas/[domainSlug]/[productSlug]/[entityId]/components/InlineEntityMeta", () => ({ InlineEntityMeta: () => null }));
vi.mock("@/app/(dashboard)/schemas/[domainSlug]/[productSlug]/[entityId]/components/ApiTab", () => ({ ApiTab: () => null }));
vi.mock("@/components/custom/DiffViewer", () => ({ DiffViewer: () => null }));
vi.mock("@/components/custom/TypeMappingOverrideDialog", () => ({ TypeMappingOverrideDialog: () => null }));
vi.mock("@/components/custom/ChangeHistoryView", () => ({ ChangeHistoryView: () => null }));
vi.mock("@/features/governance/RetentionPolicyEditor/RetentionPolicyEditor", () => ({ RetentionPolicyEditor: () => null }));

const props: EntityWorkspaceProps = {
  level: "PRODUCT",
  entity: { id: "ent-1", name: "Customer", slug: "customer", description: "", status: "DRAFT", version: 1, metadata: null, domainId: "dom-1", domainName: "Payments", domainSlug: "payments", productSlug: "checkout", productName: "Checkout", latestVersionLabel: "1.0", hasUnpublishedChanges: false },
  fields: ["email", "name"].map((name, index) => ({ id: `field-${index + 1}`, name, type: "string", precision: null, scale: null, nullable: false, isKey: false, fieldNumber: null, description: "", classification: null, aliases: [], decorators: {}, sortOrder: index })),
  domainPolicy: null, apiServiceId: null, apiOperations: [],
  capabilities: { write: true, publish: true, deploy: true, overrideEntity: true, overrideGlobal: true },
};
function mount(overrides: Partial<EntityWorkspaceProps> = {}) { return render(<EntityWorkspace {...props} {...overrides} />); }
function dirty() { fireEvent.click(screen.getByRole("button", { name: "Edit local field" })); }
function tab(id: string) { return screen.getByTestId(`tab-${id}`); }
function dialog() { return within(screen.getByRole("dialog")); }
const saveAndContinue = /^Save and (?:continue|generate)$/i;
const discardAndContinue = /^Discard and (?:continue|generate)$/i;

beforeEach(() => {
  vi.clearAllMocks();
  window.history.replaceState(null, "", "/schemas/payments/checkout/customer");
  mocks.push.mockImplementation((href: string) => { window.history.pushState(null, "", href); window.dispatchEvent(new PopStateEvent("popstate")); });
  mocks.replace.mockImplementation((href: string) => { window.history.replaceState(null, "", href); window.dispatchEvent(new PopStateEvent("popstate")); });
  mocks.save.mockResolvedValue(true);
  mocks.history.mockResolvedValue({ versions: [] });
  mocks.versions.mockResolvedValue({ versions: [] });
  mocks.emit.mockResolvedValue({ result: { summary: { totalTargets: 1, invalidCount: 0, warningCount: 0 } } });
  mocks.preview.mockResolvedValue({ preview: { isFirstPublish: false, latestLabel: "1.0", suggestedBump: "MINOR", candidateLabels: { MINOR: "1.1", MAJOR: "2.0" }, initialLabel: "1.0", reasons: [], blockers: [], warnings: [] } });
});
afterEach(cleanup);

describe("entity workspace UX", () => {
  it("does not discard dirty edits when Escape is pressed", () => {
    mount(); dirty(); fireEvent.keyDown(window, { key: "Escape" });
    expect(mocks.discard).not.toHaveBeenCalled(); expect(mocks.save).not.toHaveBeenCalled();
    expect(screen.getByTestId("workspace-draft-status")).toHaveTextContent(/unsaved field edits/i);
  });
  it("keeps the guard and current view when saving fails", async () => {
    mocks.save.mockResolvedValue(false); mount(); dirty(); fireEvent.click(tab("versions"));
    fireEvent.click(dialog().getByRole("button", { name: saveAndContinue }));
    await waitFor(() => expect(mocks.save).toHaveBeenCalledTimes(1));
    expect(screen.getByRole("dialog")).toBeInTheDocument(); expect(tab("editor")).toHaveAttribute("aria-selected", "true");
    expect(mocks.versions).not.toHaveBeenCalled(); expect(mocks.discard).not.toHaveBeenCalled();
  });
  it("waits for successful persistence before changing views", async () => {
    let finish!: (saved: boolean) => void;
    mocks.save.mockImplementation(() => new Promise<boolean>((resolve) => { finish = resolve; }));
    mount(); dirty(); fireEvent.click(tab("versions")); fireEvent.click(dialog().getByRole("button", { name: saveAndContinue }));
    expect(tab("editor")).toHaveAttribute("aria-selected", "true"); expect(mocks.versions).not.toHaveBeenCalled();
    await waitFor(() => expect(mocks.save).toHaveBeenCalledTimes(1)); await act(async () => finish(true));
    await waitFor(() => expect(tab("versions")).toHaveAttribute("aria-selected", "true"));
    expect(mocks.save).toHaveBeenCalledTimes(1); expect(mocks.discard).not.toHaveBeenCalled();
  });
  it("discards only after an explicit decision and continues once", async () => {
    mount(); dirty(); fireEvent.click(tab("schemas")); expect(mocks.discard).not.toHaveBeenCalled();
    fireEvent.click(dialog().getByRole("button", { name: discardAndContinue }));
    await waitFor(() => expect(tab("schemas")).toHaveAttribute("aria-selected", "true"));
    expect(mocks.discard).toHaveBeenCalledTimes(1); expect(mocks.save).not.toHaveBeenCalled();
  });
  it("guards both alert correction paths and retains edits on Stay", () => {
    mount(); fireEvent.click(tab("alerts")); dirty(); fireEvent.click(screen.getByRole("button", { name: "Fix schema target" }));
    expect(screen.getByRole("dialog")).toBeInTheDocument(); expect(tab("alerts")).toHaveAttribute("aria-selected", "true");
    fireEvent.click(dialog().getByRole("button", { name: /^Stay$/i })); expect(screen.queryByRole("dialog")).not.toBeInTheDocument();
    fireEvent.click(screen.getByRole("button", { name: "Fix email field" })); expect(screen.getByRole("dialog")).toBeInTheDocument();
    expect(tab("alerts")).toHaveAttribute("aria-selected", "true"); expect(mocks.save).not.toHaveBeenCalled(); expect(mocks.discard).not.toHaveBeenCalled();
  });
  it("routes Ctrl+S to the registered field save callback", async () => {
    mount(); dirty(); fireEvent.keyDown(window, { key: "s", ctrlKey: true });
    await waitFor(() => expect(mocks.save).toHaveBeenCalledTimes(1)); expect(mocks.discard).not.toHaveBeenCalled();
  });
  it("saves before keyboard generation and never generates after failed save", async () => {
    mocks.save.mockResolvedValueOnce(false).mockResolvedValueOnce(true); mount(); dirty(); fireEvent.keyDown(window, { key: "e", metaKey: true });
    expect(mocks.emit).not.toHaveBeenCalled(); fireEvent.click(dialog().getByRole("button", { name: saveAndContinue }));
    await waitFor(() => expect(mocks.save).toHaveBeenCalledTimes(1)); expect(mocks.emit).not.toHaveBeenCalled(); expect(screen.getByRole("dialog")).toBeInTheDocument();
    await waitFor(() => expect(dialog().getByRole("button", { name: saveAndContinue })).toBeEnabled());
    fireEvent.click(dialog().getByRole("button", { name: saveAndContinue }));
    await waitFor(() => expect(mocks.emit).toHaveBeenCalledWith("ent-1")); expect(mocks.save).toHaveBeenCalledTimes(2);
  });
  it("restores URL views, preserves other parameters, and responds to history", async () => {
    window.history.replaceState(null, "", "?tab=versions&keep=1"); mount(); expect(tab("versions")).toHaveAttribute("aria-selected", "true");
    await waitFor(() => expect(mocks.versions).toHaveBeenCalledWith("ent-1")); fireEvent.click(tab("schemas"));
    await waitFor(() => { const query = new URLSearchParams(window.location.search); expect(query.get("tab")).toBe("schemas"); expect(query.get("keep")).toBe("1"); });
    act(() => { window.history.replaceState(null, "", "?tab=editor&keep=1"); window.dispatchEvent(new PopStateEvent("popstate")); });
    await waitFor(() => expect(tab("editor")).toHaveAttribute("aria-selected", "true"));
  });
  it("falls back to Editor for an unavailable tenant API view", () => {
    window.history.replaceState(null, "", "?tab=api&keep=1");
    mount({ level: "TENANT", entity: { ...props.entity, domainId: null, domainSlug: null, productSlug: null, productName: null } });
    expect(tab("editor")).toHaveAttribute("aria-selected", "true"); expect(screen.queryByTestId("tab-api")).not.toBeInTheDocument();
  });
  it("shows legacy-history failure independently and permits retry", async () => {
    mocks.history.mockRejectedValueOnce(new Error("Legacy service unavailable")); window.history.replaceState(null, "", "?tab=versions"); mount();
    expect(await screen.findByText("Published versions loaded")).toBeVisible(); expect(await screen.findByText(/Legacy service unavailable/)).toBeVisible();
    expect(screen.queryByText("No legacy snapshots.")).not.toBeInTheDocument(); fireEvent.click(screen.getByRole("button", { name: /Retry legacy history/i }));
    await waitFor(() => expect(mocks.history).toHaveBeenCalledTimes(2)); expect(await screen.findByText("No legacy snapshots.")).toBeVisible(); expect(screen.getByText("Published versions loaded")).toBeVisible();
    expect(mocks.versions).toHaveBeenCalledTimes(1);
  });
  it("refreshes TypeSpec data without losing context and distinguishes draft states", async () => {
    window.history.replaceState(null, "", "?tab=typespec&keep=1"); mount(); expect(screen.getByTestId("workspace-draft-status")).toHaveTextContent(/published.*1\.0/i);
    fireEvent.click(screen.getByRole("button", { name: "Apply TypeSpec" })); await waitFor(() => expect(mocks.refresh).toHaveBeenCalledTimes(1));
    expect(tab("typespec")).toHaveAttribute("aria-selected", "true"); expect(new URLSearchParams(window.location.search).get("keep")).toBe("1");
    expect(screen.getByTestId("workspace-draft-status")).toHaveTextContent(/draft saved.*unpublished/i); dirty(); expect(screen.getByTestId("workspace-draft-status")).toHaveTextContent(/unsaved field edits/i);
  });
});
