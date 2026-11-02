// @vitest-environment jsdom
/**
 * The entity workspace guards its other unsaved editors the way it guards the field panel: the TypeSpec source (its tab) and the inline tags,
 * owner and description (above the tabs). Leaving the view, following a link away, reloading or closing the page asks first; "Save and
 * continue" saves the drafts before the view changes, "Discard and continue" drops them, and a save that fails keeps the page and the question.
 * The editors are stubbed here; each one reports its draft and answers the guard through the same refs as the real components.
 */
import { useEffect, useSyncExternalStore, type MutableRefObject } from "react";
import { cleanup, fireEvent, render, screen, waitFor, within } from "@testing-library/react";
import "@testing-library/jest-dom/vitest";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { EntityWorkspace, type EntityWorkspaceProps } from "@/app/(dashboard)/schemas/[domainSlug]/[productSlug]/[entityId]/entity-workspace";
import { toast } from "sonner";
import { reorderFieldsAction } from "@/app/(dashboard)/schemas/[domainSlug]/[productSlug]/[entityId]/actions";

const mocks = vi.hoisted(() => {
  const push = vi.fn(), replace = vi.fn(), refresh = vi.fn();
  return {
    push, replace, refresh, router: { push, replace, refresh }, invalidate: vi.fn(),
    save: vi.fn(), discard: vi.fn(), typeSpecSave: vi.fn(), typeSpecDiscard: vi.fn(), metaSave: vi.fn(), metaDiscard: vi.fn(),
  };
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
  addFieldAction: vi.fn(), updateFieldAction: vi.fn(), deleteFieldAction: vi.fn(), updateEntityStatusAction: vi.fn(), emitEntityAction: vi.fn(),
  createTypeMappingOverrideAction: vi.fn(), acknowledgeLossyMappingAction: vi.fn(), getVersionHistoryAction: vi.fn(), compareVersionsAction: vi.fn(),
  getChangeHistoryAction: vi.fn(), setFieldReferenceAction: vi.fn(), updateEntityMetadataAction: vi.fn(), reorderFieldsAction: vi.fn(),
}));
vi.mock("@/app/(dashboard)/schemas/[domainSlug]/actions", () => ({ deleteEntityAction: vi.fn() }));
vi.mock("@/app/(dashboard)/schemas/[domainSlug]/[productSlug]/[entityId]/version-actions", () => ({ getPublishPreviewAction: vi.fn(), publishEntityAction: vi.fn(), listEntityVersionsAction: vi.fn() }));
vi.mock("@/app/(dashboard)/schemas/usage-actions", () => ({ listUsagesAction: vi.fn().mockResolvedValue({ success: true, data: { rows: [], truncated: false } }) }));
vi.mock("@/app/(dashboard)/schemas/[domainSlug]/[productSlug]/[entityId]/components/useReferencePick", () => ({ useReferencePick: () => ({ pickReference: async () => true, resolveReferences: (run: () => Promise<unknown>) => run(), dialog: null }) }));
// The field editor is stubbed with one control that asks the page to save a field order (its drag does the same).
vi.mock("@/app/(dashboard)/schemas/[domainSlug]/[productSlug]/[entityId]/field-editor", () => ({
  FieldEditor: ({ onReorderFields }: { onReorderFields: (orderedIds: string[]) => Promise<boolean> }) => (
    <div>
      <p>Field editor view</p>
      <button onClick={() => void onReorderFields(["field-1"])}>Reorder fields</button>
    </div>
  ),
}));
vi.mock("@/app/(dashboard)/schemas/[domainSlug]/[productSlug]/[entityId]/components/RightPanelRouter", () => ({ RightPanelRouter: () => null }));
vi.mock("@/app/(dashboard)/schemas/[domainSlug]/[productSlug]/[entityId]/components/TypeSpecSourceTab", () => ({
  TypeSpecSourceTab: ({ onDirtyChange, saveRef, discardRef }: {
    onDirtyChange: (dirty: boolean) => void;
    saveRef: MutableRefObject<(() => Promise<boolean>) | null>;
    discardRef: MutableRefObject<(() => void) | null>;
  }) => {
    useEffect(() => {
      const save = () => mocks.typeSpecSave(), discard = () => mocks.typeSpecDiscard();
      saveRef.current = save; discardRef.current = discard;
      return () => { if (saveRef.current === save) saveRef.current = null; if (discardRef.current === discard) discardRef.current = null; };
    }, [saveRef, discardRef]);
    // As the real tab: leaving it takes its draft with it.
    useEffect(() => () => onDirtyChange(false), [onDirtyChange]);
    return (
      <div>
        <p>TypeSpec source view</p>
        <button onClick={() => onDirtyChange(true)}>Edit TypeSpec</button>
        {/* eslint-disable-next-line @next/next/no-html-link-for-pages -- a plain anchor is the link the guard intercepts (as in the other tests) */}
        <a href="/schemas/payments/checkout/other">Other entity</a>
      </div>
    );
  },
}));
vi.mock("@/app/(dashboard)/schemas/[domainSlug]/[productSlug]/[entityId]/components/InlineEntityMeta", () => ({
  InlineEntityMeta: ({ onDirtyChange, saveRef, discardRef }: {
    onDirtyChange?: (dirty: boolean) => void;
    saveRef?: MutableRefObject<(() => Promise<boolean>) | null>;
    discardRef?: MutableRefObject<(() => void) | null>;
  }) => {
    useEffect(() => {
      if (!saveRef || !discardRef) return;
      const save = () => mocks.metaSave(), discard = () => mocks.metaDiscard();
      saveRef.current = save; discardRef.current = discard;
      return () => { if (saveRef.current === save) saveRef.current = null; if (discardRef.current === discard) discardRef.current = null; };
    }, [saveRef, discardRef]);
    useEffect(() => () => onDirtyChange?.(false), [onDirtyChange]);
    return <button onClick={() => onDirtyChange?.(true)}>Edit details</button>;
  },
}));
vi.mock("@/app/(dashboard)/schemas/[domainSlug]/[productSlug]/[entityId]/components/SchemasTab", () => ({ SchemasTab: () => <p>Generated schemas view</p> }));
vi.mock("@/app/(dashboard)/schemas/[domainSlug]/[productSlug]/[entityId]/components/EntityDeploymentsTab", () => ({ EntityDeploymentsTab: () => null }));
vi.mock("@/app/(dashboard)/schemas/[domainSlug]/[productSlug]/[entityId]/components/AlertsTab", () => ({ AlertsTab: () => null }));
vi.mock("@/app/(dashboard)/schemas/[domainSlug]/[productSlug]/[entityId]/components/ApiTab", () => ({ ApiTab: () => null }));
vi.mock("@/components/custom/DiffViewer", () => ({ DiffViewer: () => null }));
vi.mock("@/components/custom/TypeMappingOverrideDialog", () => ({ TypeMappingOverrideDialog: () => null }));
vi.mock("@/components/custom/ChangeHistoryView", () => ({ ChangeHistoryView: () => null }));
vi.mock("@/features/governance/RetentionPolicyEditor/RetentionPolicyEditor", () => ({ RetentionPolicyEditor: () => null }));

const props: EntityWorkspaceProps = {
  level: "PRODUCT",
  entity: { id: "ent-1", name: "Customer", slug: "customer", description: "", status: "DRAFT", version: 1, metadata: null, domainId: "dom-1", domainName: "Payments", domainSlug: "payments", productSlug: "checkout", productName: "Checkout", latestVersionLabel: "1.0", hasUnpublishedChanges: false },
  fields: [{ id: "field-1", name: "email", type: "string", precision: null, scale: null, nullable: false, isKey: false, fieldNumber: null, description: "", classification: null, aliases: [], decorators: {}, sortOrder: 0 }],
  domainPolicy: null, apiServiceId: null, apiOperations: [],
  capabilities: { write: true, publish: true, deploy: true, overrideEntity: true, overrideGlobal: true },
};
function mount(overrides: Partial<EntityWorkspaceProps> = {}) { return render(<EntityWorkspace {...props} {...overrides} />); }
function tab(id: string) { return screen.getByTestId(`tab-${id}`); }
function dialog() { return within(screen.getByRole("dialog")); }
function editTypeSpec() { fireEvent.click(screen.getByRole("button", { name: "Edit TypeSpec" })); }
function editDetails() { fireEvent.click(screen.getByRole("button", { name: "Edit details" })); }
/** Dispatches `beforeunload` (a reload or a closed tab) and says whether the page asked to stay. */
function beforeUnloadPrevented() {
  const event = new Event("beforeunload", { cancelable: true });
  window.dispatchEvent(event);
  return event.defaultPrevented;
}
const saveAndContinue = /^Save and (?:continue|generate)$/i;
const discardAndContinue = /^Discard and (?:continue|generate)$/i;

beforeEach(() => {
  vi.clearAllMocks();
  window.history.replaceState(null, "", "/schemas/payments/checkout/customer");
  mocks.push.mockImplementation((href: string) => { window.history.pushState(null, "", href); window.dispatchEvent(new PopStateEvent("popstate")); });
  mocks.replace.mockImplementation((href: string) => { window.history.replaceState(null, "", href); window.dispatchEvent(new PopStateEvent("popstate")); });
  mocks.typeSpecSave.mockResolvedValue(true);
  mocks.metaSave.mockResolvedValue(true);
});
afterEach(cleanup);

describe("entity workspace: unsaved TypeSpec source is guarded like the field edits", () => {
  it("leaving the TypeSpec source for the Editor asks first; Save and continue saves the source, then changes the view", async () => {
    window.history.replaceState(null, "", "/schemas/payments/checkout/customer?tab=typespec");
    mount();
    editTypeSpec();

    fireEvent.click(tab("editor"));

    expect(screen.getByRole("dialog")).toBeInTheDocument();
    expect(screen.getByText(/This entity has unsaved edits/)).toBeInTheDocument();
    expect(tab("typespec")).toHaveAttribute("aria-selected", "true");
    expect(mocks.typeSpecSave).not.toHaveBeenCalled();

    fireEvent.click(dialog().getByRole("button", { name: saveAndContinue }));

    await waitFor(() => expect(tab("editor")).toHaveAttribute("aria-selected", "true"));
    expect(mocks.typeSpecSave).toHaveBeenCalledTimes(1);
    expect(mocks.typeSpecDiscard).not.toHaveBeenCalled();
  });

  it("Discard and continue drops the TypeSpec source and changes the view", async () => {
    window.history.replaceState(null, "", "/schemas/payments/checkout/customer?tab=typespec");
    mount();
    editTypeSpec();
    fireEvent.click(tab("editor"));

    fireEvent.click(dialog().getByRole("button", { name: discardAndContinue }));

    await waitFor(() => expect(tab("editor")).toHaveAttribute("aria-selected", "true"));
    expect(mocks.typeSpecDiscard).toHaveBeenCalledTimes(1);
    expect(mocks.typeSpecSave).not.toHaveBeenCalled();
  });

  it("Stay keeps the TypeSpec source and the view", () => {
    window.history.replaceState(null, "", "/schemas/payments/checkout/customer?tab=typespec");
    mount();
    editTypeSpec();
    fireEvent.click(tab("editor"));

    fireEvent.click(dialog().getByRole("button", { name: /^Stay$/i }));

    expect(screen.queryByRole("dialog")).not.toBeInTheDocument();
    expect(tab("typespec")).toHaveAttribute("aria-selected", "true");
    expect(mocks.typeSpecSave).not.toHaveBeenCalled();
    expect(mocks.typeSpecDiscard).not.toHaveBeenCalled();
  });

  it("a TypeSpec save that fails keeps the question and the view, and says why", async () => {
    mocks.typeSpecSave.mockResolvedValue(false);
    window.history.replaceState(null, "", "/schemas/payments/checkout/customer?tab=typespec");
    mount();
    editTypeSpec();
    fireEvent.click(tab("editor"));

    fireEvent.click(dialog().getByRole("button", { name: saveAndContinue }));

    await waitFor(() => expect(mocks.typeSpecSave).toHaveBeenCalledTimes(1));
    expect(await screen.findByTestId("unsaved-changes-error")).toHaveTextContent(/The TypeSpec source could not be saved/);
    expect(screen.getByRole("dialog")).toBeInTheDocument();
    expect(tab("typespec")).toHaveAttribute("aria-selected", "true");
    expect(mocks.typeSpecDiscard).not.toHaveBeenCalled();
  });

  it("a link away from the page asks first while the TypeSpec source is unsaved; Discard and continue leaves for the link", async () => {
    window.history.replaceState(null, "", "/schemas/payments/checkout/customer?tab=typespec");
    mount();
    editTypeSpec();

    fireEvent.click(screen.getByRole("link", { name: "Other entity" }));

    expect(screen.getByRole("dialog")).toBeInTheDocument();
    expect(mocks.push).not.toHaveBeenCalled();
    fireEvent.click(dialog().getByRole("button", { name: discardAndContinue }));
    await waitFor(() => expect(mocks.push).toHaveBeenCalledWith("/schemas/payments/checkout/other"));
    expect(mocks.typeSpecDiscard).toHaveBeenCalledTimes(1);
  });

  it("a reload or a closed tab is prevented while the TypeSpec source is unsaved, and allowed once it is discarded", async () => {
    window.history.replaceState(null, "", "/schemas/payments/checkout/customer?tab=typespec");
    mount();
    expect(beforeUnloadPrevented()).toBe(false);

    editTypeSpec();
    expect(beforeUnloadPrevented()).toBe(true);

    fireEvent.click(tab("editor"));
    fireEvent.click(dialog().getByRole("button", { name: discardAndContinue }));
    await waitFor(() => expect(tab("editor")).toHaveAttribute("aria-selected", "true"));
    // The TypeSpec tab is gone with its draft: the page no longer holds the reload.
    expect(beforeUnloadPrevented()).toBe(false);
  });
});

describe("entity workspace: unsaved inline details are guarded like the field edits", () => {
  it("leaving the editor for another view asks first; Save and continue saves the details, then changes the view", async () => {
    mount();
    editDetails();

    fireEvent.click(tab("schemas"));

    expect(screen.getByRole("dialog")).toBeInTheDocument();
    expect(mocks.metaSave).not.toHaveBeenCalled();
    fireEvent.click(dialog().getByRole("button", { name: saveAndContinue }));

    await waitFor(() => expect(tab("schemas")).toHaveAttribute("aria-selected", "true"));
    expect(mocks.metaSave).toHaveBeenCalledTimes(1);
    expect(mocks.metaDiscard).not.toHaveBeenCalled();
  });

  it("a tags or owner save that is refused keeps the question and the view, and says why", async () => {
    mocks.metaSave.mockResolvedValue(false);
    mount();
    editDetails();
    fireEvent.click(tab("schemas"));

    fireEvent.click(dialog().getByRole("button", { name: saveAndContinue }));

    await waitFor(() => expect(mocks.metaSave).toHaveBeenCalledTimes(1));
    expect(await screen.findByTestId("unsaved-changes-error")).toHaveTextContent(/The tags, owner or description could not be saved/);
    expect(screen.getByRole("dialog")).toBeInTheDocument();
    expect(tab("editor")).toHaveAttribute("aria-selected", "true");
    expect(mocks.metaDiscard).not.toHaveBeenCalled();
  });

  it("a reload or a closed tab is prevented while the details are unsaved", () => {
    mount();
    expect(beforeUnloadPrevented()).toBe(false);
    editDetails();
    expect(beforeUnloadPrevented()).toBe(true);
  });

  it("Discard and continue drops the details and changes the view", async () => {
    mount();
    editDetails();
    fireEvent.click(tab("schemas"));

    fireEvent.click(dialog().getByRole("button", { name: discardAndContinue }));

    await waitFor(() => expect(tab("schemas")).toHaveAttribute("aria-selected", "true"));
    expect(mocks.metaDiscard).toHaveBeenCalledTimes(1);
    expect(mocks.metaSave).not.toHaveBeenCalled();
  });
});

describe("entity workspace: a field order that is not saved is put back, and the page is reloaded", () => {
  it("a saved field order neither reports an error nor reloads the page", async () => {
    vi.mocked(reorderFieldsAction).mockResolvedValue({ success: true });
    mount();
    fireEvent.click(screen.getByRole("button", { name: "Reorder fields" }));

    await waitFor(() => expect(reorderFieldsAction).toHaveBeenCalledWith("ent-1", ["field-1"]));
    expect(toast.error).not.toHaveBeenCalled();
    expect(mocks.refresh).not.toHaveBeenCalled();
  });

  it("a refused field order says why, and reloads the page so the stored order and any new field are shown", async () => {
    const message = "The field list has changed since this page was loaded. It is being reloaded; try the move again.";
    vi.mocked(reorderFieldsAction).mockResolvedValue({ error: message, code: "VALIDATION_ERROR" } as never);
    mount();
    fireEvent.click(screen.getByRole("button", { name: "Reorder fields" }));

    await waitFor(() => expect(toast.error).toHaveBeenCalledWith(message));
    expect(mocks.refresh).toHaveBeenCalledTimes(1);
  });

  it("a field order whose save throws says so, and reloads the page", async () => {
    vi.mocked(reorderFieldsAction).mockRejectedValue(new Error("Failed to fetch"));
    mount();
    fireEvent.click(screen.getByRole("button", { name: "Reorder fields" }));

    await waitFor(() => expect(toast.error).toHaveBeenCalledWith("Could not change the field order. Try again."));
    expect(mocks.refresh).toHaveBeenCalledTimes(1);
  });
});
