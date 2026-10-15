// @vitest-environment jsdom
import { cleanup, fireEvent, render, screen, waitFor } from "@testing-library/react";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";

const h = vi.hoisted(() => ({
  emitEventSpecDraftAction: vi.fn(),
  getEventSpecVersionDocumentAction: vi.fn(),
  getEventSpecPublishPreviewAction: vi.fn(),
  publishEventSpecAction: vi.fn(),
  refresh: vi.fn(),
}));
vi.mock("next/navigation", () => ({ useRouter: () => ({ refresh: h.refresh, push: vi.fn() }) }));
vi.mock("@/app/(dashboard)/schemas/[domainSlug]/[productSlug]/event-spec-emit-actions", () => ({
  emitEventSpecDraftAction: h.emitEventSpecDraftAction, getEventSpecVersionDocumentAction: h.getEventSpecVersionDocumentAction,
}));
vi.mock("@/app/(dashboard)/schemas/[domainSlug]/[productSlug]/event-spec-version-actions", () => ({
  getEventSpecPublishPreviewAction: h.getEventSpecPublishPreviewAction, publishEventSpecAction: h.publishEventSpecAction,
}));
vi.mock("@/features/events/event-specs/EventSpecEditor", () => ({
  EventSpecEditor: (p: { onSaved: (d: unknown) => void }) => (
    <div data-testid="spec-editor">
      <input data-testid="spec-editor-input" />
      <button data-testid="spec-editor-saved" onClick={() => p.onSaved({})} />
    </div>
  ),
}));
vi.mock("@/features/events/event-specs/AsyncApiPreview", () => ({ AsyncApiPreview: (p: { document: unknown }) => <div data-testid="preview">{JSON.stringify(p.document)}</div> }));
vi.mock("@/features/events/shared/PublishVersionButton", () => ({
  PublishVersionButton: (p: { loadPreview: () => void; publish: (i: object) => void }) => (
    <div>
      <button data-testid="spec-publish" onClick={() => p.loadPreview()}>Publish</button>
      <button data-testid="spec-publish-confirm" onClick={() => p.publish({ bump: "MINOR" })}>Confirm</button>
    </div>
  ),
}));
import { EventSpecPage, normalizeSpecTab } from "@/features/events/event-specs/EventSpecPage";

const emission = { specId: "s1", specName: "checkout-service", version: "draft", published: false, document: { asyncapi: "3.0.0" }, json: "{}", yaml: "asyncapi: 3.0.0\n", diagnostics: [], unpublishedMessages: [] };
const base = {
  spec: { id: "s1", name: "checkout-service", specType: "asyncapi@3.0", latestVersionLabel: "1.0", hasUnpublishedChanges: true, tenantId: "t", domainId: "d1", productId: "p1", document: { info: { title: "x" }, servers: [], operations: [] } },
  productId: "p1", domainSlug: "payments", productSlug: "checkout", crumbs: [{ label: "Event Specs" }],
  channelOptions: [], messageOptions: [], operationTraits: [], owner: null,
  versions: [
    { id: "v2", major: 2, minor: 0, label: "2.0", sequence: 2, changeKind: "MAJOR" as const, changeSummary: null, publishedByName: "Ada", publishedAt: "2026-10-15T00:00:00.000Z" },
    { id: "v1", major: 1, minor: 0, label: "1.0", sequence: 1, changeKind: "INITIAL" as const, changeSummary: null, publishedByName: "Ada", publishedAt: "2026-10-14T00:00:00.000Z" },
  ],
};

beforeEach(() => {
  vi.clearAllMocks();
  h.emitEventSpecDraftAction.mockResolvedValue({ success: true, data: emission });
  h.getEventSpecVersionDocumentAction.mockImplementation(async (_id: string, label: string) => ({
    success: true, data: { ...emission, version: label, published: true },
  }));
  window.history.replaceState(null, "", "/schemas/payments/checkout/specs/s1");
});
afterEach(() => cleanup());

describe("EventSpecPage", () => {
  it("normalizes tabs; a version view never opens the editor", () => {
    expect(normalizeSpecTab(null, null)).toBe("editor");
    expect(normalizeSpecTab("preview", null)).toBe("preview");
    expect(normalizeSpecTab("nonsense", null)).toBe("editor");
    expect(normalizeSpecTab("editor", "1.0")).toBe("document");
    expect(normalizeSpecTab(null, "1.0")).toBe("document");
    expect(normalizeSpecTab("diagnostics", "1.0")).toBe("diagnostics");
  });

  it("emits the draft lazily once for Document / Preview / Diagnostics and writes ?tab= to the URL", async () => {
    render(<EventSpecPage {...base} viewingVersion={null} initialTab="editor" />);
    expect(screen.getByTestId("spec-editor")).toBeDefined();
    expect(screen.getByTestId("spec-publish")).toBeDefined();
    expect(h.emitEventSpecDraftAction).not.toHaveBeenCalled();
    fireEvent.click(screen.getByRole("tab", { name: "Document" }));
    expect((await screen.findByTestId("document-text")).textContent).toContain("asyncapi: 3.0.0");
    expect(window.location.search).toBe("?tab=document");
    fireEvent.click(screen.getByRole("tab", { name: "Preview" }));
    expect(screen.getByTestId("preview").textContent).toBe(JSON.stringify({ asyncapi: "3.0.0" }));
    fireEvent.click(screen.getByRole("tab", { name: "Diagnostics" }));
    await waitFor(() => expect(h.emitEventSpecDraftAction).toHaveBeenCalledTimes(1));
    expect(h.emitEventSpecDraftAction).toHaveBeenCalledWith("s1", "p1");
  });

  it("shows a published version read-only from its stored document", async () => {
    render(<EventSpecPage {...base} viewingVersion="1.0" initialTab="document" />);
    await waitFor(() => expect(h.getEventSpecVersionDocumentAction).toHaveBeenCalledWith("s1", "1.0"));
    expect(screen.queryByTestId("spec-publish")).toBeNull();
    expect(screen.queryByTestId("spec-editor")).toBeNull();
    expect(screen.getByRole("tab", { name: "Editor" }).hasAttribute("disabled")).toBe(true);
    expect(screen.getByRole("link", { name: "Back to draft" }).getAttribute("href")).toBe("/schemas/payments/checkout/specs/s1");
    expect(h.emitEventSpecDraftAction).not.toHaveBeenCalled();
  });

  it("keeps the version in the URL when switching tabs of a version view", async () => {
    render(<EventSpecPage {...base} viewingVersion="1.0" initialTab="document" />);
    fireEvent.click(screen.getByRole("tab", { name: "Versions" }));
    expect(window.location.search).toBe("?tab=versions&version=1.0");
    expect(screen.getByTestId("event-version-list")).toBeDefined();
    await waitFor(() => expect(h.getEventSpecVersionDocumentAction).toHaveBeenCalledTimes(1));
  });

  it("links every published version from the Versions tab", () => {
    render(<EventSpecPage {...base} viewingVersion={null} initialTab="versions" />);
    expect(screen.getByRole("link", { name: "v2.0" }).getAttribute("href")).toBe("/schemas/payments/checkout/specs/s1?version=2.0");
    expect(screen.getByRole("link", { name: "v1.0" }).getAttribute("href")).toBe("/schemas/payments/checkout/specs/s1?version=1.0");
  });

  it("re-reads the stored document when client navigation moves to another version (no stale version shown)", async () => {
    const { rerender } = render(<EventSpecPage {...base} viewingVersion="1.0" initialTab="document" />);
    await waitFor(() => expect(h.getEventSpecVersionDocumentAction).toHaveBeenCalledWith("s1", "1.0"));
    rerender(<EventSpecPage {...base} viewingVersion="2.0" initialTab="document" />);
    await waitFor(() => expect(h.getEventSpecVersionDocumentAction).toHaveBeenCalledWith("s1", "2.0"));
    expect(await screen.findByText("v2.0 (stored)")).toBeDefined();
    // And back to the draft: the editor is the landing tab again.
    rerender(<EventSpecPage {...base} viewingVersion={null} initialTab="editor" />);
    expect(screen.getByTestId("spec-editor")).toBeDefined();
  });

  it("shows another product's spec read-only: owner link instead of Back to draft, no editor, no publish, no draft emission", async () => {
    const owner = { label: "Payments / Checkout", href: "/schemas/payments/checkout/specs/s1?version=1.0" };
    const stub = { ...base.spec, document: { info: { title: "checkout-service" }, servers: [], operations: [] }, hasUnpublishedChanges: false, domainId: null, productId: null };
    render(<EventSpecPage {...base} spec={stub} viewingVersion="1.0" initialTab="document" owner={owner} />);
    await waitFor(() => expect(h.getEventSpecVersionDocumentAction).toHaveBeenCalledWith("s1", "1.0"));
    expect(screen.getByTestId("spec-owner").textContent).toContain("Owned by Payments / Checkout");
    expect(screen.getByRole("link", { name: "open in its own product" }).getAttribute("href")).toBe(owner.href);
    expect(screen.queryByRole("link", { name: "Back to draft" })).toBeNull();
    expect(screen.queryByTestId("spec-editor")).toBeNull();
    expect(screen.queryByTestId("spec-publish")).toBeNull();
    expect(screen.getByRole("tab", { name: "Editor" }).hasAttribute("disabled")).toBe(true);
    expect(screen.queryByText("unpublished changes")).toBeNull();
    fireEvent.click(screen.getByRole("tab", { name: "Diagnostics" }));
    await screen.findByTestId("diagnostics-list");
    expect(h.emitEventSpecDraftAction).not.toHaveBeenCalled();
  });

  it("keeps the editor mounted (hidden) while another tab is open, so unsaved edits survive", async () => {
    render(<EventSpecPage {...base} viewingVersion={null} initialTab="editor" />);
    fireEvent.change(screen.getByTestId("spec-editor-input"), { target: { value: "unsaved work" } });
    expect(screen.getByTestId("spec-editor").closest("[hidden]")).toBeNull();
    fireEvent.click(screen.getByRole("tab", { name: "Document" }));
    await screen.findByTestId("document-text");
    expect(screen.getByTestId("spec-editor").closest("[hidden]")).not.toBeNull();
    fireEvent.click(screen.getByRole("tab", { name: "Editor" }));
    expect(screen.getByTestId("spec-editor").closest("[hidden]")).toBeNull();
    expect((screen.getByTestId("spec-editor-input") as HTMLInputElement).value).toBe("unsaved work");
  });

  it("after a save: refreshes the server data, and re-emits only if an emission was already shown", async () => {
    render(<EventSpecPage {...base} viewingVersion={null} initialTab="editor" />);
    fireEvent.click(screen.getByTestId("spec-editor-saved"));
    expect(h.refresh).toHaveBeenCalledTimes(1);
    expect(h.emitEventSpecDraftAction).not.toHaveBeenCalled();

    fireEvent.click(screen.getByRole("tab", { name: "Diagnostics" }));
    await waitFor(() => expect(h.emitEventSpecDraftAction).toHaveBeenCalledTimes(1));
    fireEvent.click(screen.getByRole("tab", { name: "Editor" }));
    fireEvent.click(screen.getByTestId("spec-editor-saved"));
    await waitFor(() => expect(h.emitEventSpecDraftAction).toHaveBeenCalledTimes(2));
  });

  it("passes the owning product to the publish preview and publish actions", () => {
    render(<EventSpecPage {...base} viewingVersion={null} initialTab="editor" />);
    fireEvent.click(screen.getByTestId("spec-publish"));
    expect(h.getEventSpecPublishPreviewAction).toHaveBeenCalledWith("s1", "p1");
    fireEvent.click(screen.getByTestId("spec-publish-confirm"));
    expect(h.publishEventSpecAction).toHaveBeenCalledWith("s1", "p1", { bump: "MINOR" });
  });

  it("shows a client-safe message for opaque failures and a Retry that reloads", async () => {
    h.emitEventSpecDraftAction.mockResolvedValueOnce({ success: false, error: 'relation "event_specs" does not exist', code: "DB_ERROR" });
    render(<EventSpecPage {...base} viewingVersion={null} initialTab="document" />);
    expect((await screen.findByRole("alert")).textContent).toContain("Something went wrong");
    expect(screen.queryByText(/relation/)).toBeNull();
    fireEvent.click(screen.getByRole("button", { name: "Retry" }));
    expect((await screen.findByTestId("document-text")).textContent).toContain("asyncapi: 3.0.0");
    expect(h.emitEventSpecDraftAction).toHaveBeenCalledTimes(2);
  });

  it("shows a thrown action as the generic message, not the exception text", async () => {
    h.emitEventSpecDraftAction.mockRejectedValueOnce(new Error("connect ECONNREFUSED 10.0.0.5:5432"));
    render(<EventSpecPage {...base} viewingVersion={null} initialTab="diagnostics" />);
    await waitFor(() => expect(h.emitEventSpecDraftAction).toHaveBeenCalled());
    expect(await screen.findByRole("alert")).toBeDefined();
    expect(screen.queryByText(/ECONNREFUSED/)).toBeNull();
  });

  it("badges the Diagnostics tab with the error count", async () => {
    const withErrors = { ...emission, diagnostics: [{ severity: "error", code: "E", message: "broken", pointer: "" }] };
    h.emitEventSpecDraftAction.mockResolvedValue({ success: true, data: withErrors });
    render(<EventSpecPage {...base} viewingVersion={null} initialTab="diagnostics" />);
    expect(await screen.findByRole("tab", { name: /^Diagnostics\s*\(1\)$/ })).toBeDefined();
  });

  it("drops the response of an older load that finishes after a newer one", async () => {
    let finishOlder: (r: unknown) => void = () => {};
    h.emitEventSpecDraftAction
      .mockImplementationOnce(() => new Promise((resolve) => { finishOlder = resolve; }))
      .mockResolvedValueOnce({ success: true, data: { ...emission, yaml: "title: newer\n" } });
    render(<EventSpecPage {...base} viewingVersion={null} initialTab="document" />);
    await waitFor(() => expect(h.emitEventSpecDraftAction).toHaveBeenCalledTimes(1));
    fireEvent.click(screen.getByTestId("spec-editor-saved")); // re-emits while the first load is still running
    await waitFor(() => expect(screen.getByTestId("document-text").textContent).toContain("title: newer"));
    finishOlder({ success: true, data: { ...emission, yaml: "title: older\n" } });
    await new Promise((r) => setTimeout(r, 0));
    expect(screen.getByTestId("document-text").textContent).toContain("title: newer");
  });

  it("moves between tabs with the arrow keys, skipping the disabled Editor tab of a version view", async () => {
    render(<EventSpecPage {...base} viewingVersion="1.0" initialTab="document" />);
    await screen.findByTestId("document-text");
    const documentTab = screen.getByRole("tab", { name: "Document" });
    fireEvent.keyDown(documentTab, { key: "ArrowLeft" });
    // From Document, ArrowLeft would land on the disabled Editor: it wraps to the last tab instead.
    expect(screen.getByRole("tab", { name: "Diagnostics" }).getAttribute("aria-selected")).toBe("true");
    fireEvent.keyDown(screen.getByRole("tab", { name: "Diagnostics" }), { key: "ArrowRight" });
    expect(screen.getByRole("tab", { name: "Document" }).getAttribute("aria-selected")).toBe("true");
  });
});
