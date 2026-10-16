// @vitest-environment jsdom
// The Code panel with the REAL CodeMirror editor (jsdom with the stand-ins of ./template/codemirror-jsdom). The behaviour of the panel
// itself (status chip, diagnostics, stale answers, Copy) is covered with the textarea in event-code-panel.test.tsx.
import "./template/codemirror-jsdom";
import { act, cleanup, fireEvent, render, screen, waitFor } from "@testing-library/react";
import { EditorView } from "@codemirror/view";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";

const h = vi.hoisted(() => ({ preview: vi.fn(), writeText: vi.fn() }));
vi.mock("@/app/(dashboard)/schemas/[domainSlug]/[productSlug]/event-actions", () => ({ previewEventDocumentAction: h.preview }));
vi.mock("sonner", () => ({ toast: { success: vi.fn(), error: vi.fn() } }));

import { EventCodePanel } from "@/features/events/event-page/EventCodePanel";
import type { EventCodeSource } from "@/features/events/event-page/event-code-source";
import { buildInstantAsyncApi } from "@/lib/events/document/instant-asyncapi";
import { emptyEventDocument, type EventDocument } from "@/lib/events/document/types";

const PIN = { entityId: "ent-1", entityVersionId: "ver-1" };
const ENTITY_LABELS = new Map([["ent-1", "Order"]]);
const VERSION_LABELS = new Map([["ver-1", "1.0"]]);

function makeDoc(title = "Orders"): EventDocument {
  return {
    ...emptyEventDocument(title),
    servers: [{ key: "kafka", protocol: "kafka", host: "h:9092" }],
    channels: [{ key: "orders", address: "orders.v1", protocol: "kafka", serverKeys: ["kafka"], format: "avro", messageKeys: ["OrderCreated"] }],
    messages: [{ key: "OrderCreated", payload: PIN, traitKeys: [] }],
    operations: [{ key: "publishOrder", action: "send", channelKey: "orders", messageKeys: ["OrderCreated"], traitKeys: [] }],
  };
}
const props = (over: Partial<EventCodeSource> = {}): EventCodeSource =>
  ({ eventId: "ev1", productId: "p1", productSlug: "checkout", doc: makeDoc(), problems: [], entityLabels: ENTITY_LABELS, versionLabels: VERSION_LABELS, ...over });
const instantOf = (doc: EventDocument) => buildInstantAsyncApi(doc, { productSlug: "checkout", entityLabels: ENTITY_LABELS, versionLabels: VERSION_LABELS });

const SERVER_YAML = "asyncapi: 3.0.0\ninfo:\n  title: Orders\n  version: draft\n# real payload schemas below\n";

beforeEach(() => {
  // the server never answers unless a test says so, so only the instant code is on screen
  h.preview.mockReturnValue(new Promise(() => {}));
  h.writeText.mockResolvedValue(undefined);
  Object.defineProperty(navigator, "clipboard", { value: { writeText: h.writeText }, configurable: true });
});
afterEach(() => {
  cleanup();
  vi.clearAllMocks();
  vi.restoreAllMocks();
});

/** Render and wait for CodeMirror to replace the textarea. */
async function mountPanel(p: EventCodeSource = props()) {
  const rendered = render(<EventCodePanel {...p} />);
  await waitFor(() => expect(rendered.container.querySelector(".cm-editor")).not.toBeNull());
  return { ...rendered, view: () => EditorView.findFromDOM(rendered.container.querySelector(".cm-editor") as HTMLElement) as EditorView };
}
const click = (testId: string) => fireEvent.click(screen.getByTestId(testId));

describe("EventCodePanel with CodeMirror", () => {
  it("shows the instant YAML in a read-only editor with line numbers", async () => {
    const p = props();
    const { view, container } = await mountPanel(p);
    expect(view().state.doc.toString()).toBe(instantOf(p.doc).yaml);
    expect(view().state.readOnly).toBe(true);
    expect(container.querySelector(".cm-lineNumbers")).not.toBeNull();
    const content = container.querySelector(".cm-content") as HTMLElement;
    expect(content.getAttribute("aria-label")).toBe("AsyncAPI document as YAML");
    expect(content.getAttribute("aria-readonly")).toBe("true");
    expect(screen.getByRole("region", { name: "AsyncAPI code" }).contains(content)).toBe(true);
    expect(container.querySelector("textarea")).toBeNull();
  });

  it("highlights the code", async () => {
    const { container } = await mountPanel();
    expect(container.querySelectorAll(".cm-line span").length).toBeGreaterThan(10);
  });

  it("can be selected from the keyboard, but never edited", async () => {
    const { view } = await mountPanel();
    expect(view().contentDOM.getAttribute("contenteditable")).toBe("true");
    expect(view().state.readOnly).toBe(true);
    expect(screen.queryByTestId("event-code-text-tab-hint")).toBeNull();
  });

  it("switches to the JSON of the same document and back, in the same editor", async () => {
    const p = props();
    const { view, container } = await mountPanel(p);
    const dom = container.querySelector(".cm-editor");
    click("code-format-json");
    expect(view().state.doc.toString()).toBe(instantOf(p.doc).json);
    expect(screen.getByTestId("event-code-text-editor").getAttribute("data-language")).toBe("json");
    expect((container.querySelector(".cm-content") as HTMLElement).getAttribute("aria-label")).toBe("AsyncAPI document as JSON");
    click("code-format-yaml");
    expect(view().state.doc.toString()).toBe(instantOf(p.doc).yaml);
    expect(container.querySelector(".cm-editor")).toBe(dom);
  });

  it("follows an edit of the draft at once, in the same editor and without moving the view", async () => {
    const { view, container, rerender } = await mountPanel();
    const dom = container.querySelector(".cm-editor");
    const next = props({ doc: makeDoc("Orders v2") });
    rerender(<EventCodePanel {...next} />);
    expect(view().state.doc.toString()).toBe(instantOf(next.doc).yaml);
    expect(view().state.doc.toString()).toContain("title: Orders v2");
    expect(container.querySelector(".cm-editor")).toBe(dom);
    expect(h.preview).not.toHaveBeenCalled();
  });

  it("swaps in the server's full render when it arrives, and the status chip says so", async () => {
    h.preview.mockResolvedValue({ success: true, data: { document: { asyncapi: "3.0.0" }, yaml: SERVER_YAML, json: "{}", diagnostics: [] } });
    const { view } = await mountPanel();
    await waitFor(() => expect(view().state.doc.toString()).toBe(SERVER_YAML), { timeout: 4000 });
    expect(screen.getByTestId("code-status").getAttribute("data-state")).toBe("full");
  });

  it("copies the text of the editor", async () => {
    const p = props();
    await mountPanel(p);
    click("code-copy");
    await act(async () => { await Promise.resolve(); });
    expect(h.writeText).toHaveBeenCalledWith(instantOf(p.doc).yaml);
  });

  it("builds no editor while the draft has problems, and builds it once they are fixed", async () => {
    const broken = props({ doc: makeDoc(""), problems: [{ pointer: "/info/title", message: "title is required" }] });
    const { container, rerender } = render(<EventCodePanel {...broken} />);
    await act(async () => { await new Promise((r) => setTimeout(r, 30)); });
    expect(container.querySelector(".cm-editor")).toBeNull();
    expect(screen.getByTestId("code-empty")).toBeTruthy();
    rerender(<EventCodePanel {...props({ doc: makeDoc("Fixed") })} />);
    await waitFor(() => expect(container.querySelector(".cm-editor")).not.toBeNull());
  });

  it("destroys the editor when the panel goes away (a closed panel keeps nothing running)", async () => {
    const destroy = vi.spyOn(EditorView.prototype, "destroy");
    const { unmount } = await mountPanel();
    unmount();
    expect(destroy).toHaveBeenCalledTimes(1);
    expect(document.querySelector(".cm-editor")).toBeNull();
  });
});
