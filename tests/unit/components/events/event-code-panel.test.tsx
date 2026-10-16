// @vitest-environment jsdom
import { act, cleanup, fireEvent, render, screen, within } from "@testing-library/react";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";

const h = vi.hoisted(() => ({ preview: vi.fn(), toastSuccess: vi.fn(), toastError: vi.fn(), writeText: vi.fn() }));
vi.mock("@/app/(dashboard)/schemas/[domainSlug]/[productSlug]/event-actions", () => ({ previewEventDocumentAction: h.preview }));
vi.mock("sonner", () => ({ toast: { success: h.toastSuccess, error: h.toastError } }));

import { EventCodePanel } from "@/features/events/event-page/EventCodePanel";
import type { EventCodeSource } from "@/features/events/event-page/event-code-source";
import { CODE_DEBOUNCE_MS } from "@/features/events/event-page/use-event-code";
import { buildInstantAsyncApi } from "@/lib/events/document/instant-asyncapi";
import { emptyEventDocument, type EventDocument } from "@/lib/events/document/types";
import { GENERIC_ACTION_ERROR } from "@/types/action-result";

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

function props(over: Partial<EventCodeSource> = {}): EventCodeSource {
  return { eventId: "ev1", productId: "p1", productSlug: "checkout", doc: makeDoc(), problems: [], entityLabels: ENTITY_LABELS, versionLabels: VERSION_LABELS, ...over };
}
const instantOf = (doc: EventDocument) => buildInstantAsyncApi(doc, { productSlug: "checkout", entityLabels: ENTITY_LABELS, versionLabels: VERSION_LABELS });

const SERVER_YAML = "asyncapi: 3.0.0\ninfo:\n  title: Orders\n  version: draft\n# real payload schemas below\n";
const SERVER_JSON = '{\n  "asyncapi": "3.0.0",\n  "real": true\n}\n';
const emission = (over: Record<string, unknown> = {}) => ({
  success: true as const,
  data: { document: { asyncapi: "3.0.0" }, yaml: SERVER_YAML, json: SERVER_JSON, diagnostics: [], ...over },
});

const flush = (ms: number) => act(async () => { await vi.advanceTimersByTimeAsync(ms); });
const text = (testId: string) => screen.getByTestId(testId).textContent;
/** The code on screen: this test file has no CodeMirror stand-ins for jsdom, so the editor is its textarea (same API). */
const editor = () => screen.getByTestId("event-code-text") as HTMLTextAreaElement;
const code = () => editor().value;
const chip = () => screen.getByTestId("code-status");
const click = (testId: string) => fireEvent.click(screen.getByTestId(testId));

beforeEach(() => {
  vi.useFakeTimers();
  vi.clearAllMocks();
  h.preview.mockResolvedValue(emission());
  h.writeText.mockResolvedValue(undefined);
  Object.defineProperty(navigator, "clipboard", { value: { writeText: h.writeText }, configurable: true });
});
afterEach(() => {
  cleanup();
  vi.useRealTimers();
});

describe("EventCodePanel: the code", () => {
  it("shows the instant YAML of the draft immediately, in a read-only editor named after its format", () => {
    const p = props();
    render(<EventCodePanel {...p} />);
    expect(code()).toBe(instantOf(p.doc).yaml);
    expect(editor().readOnly).toBe(true);
    expect(editor().getAttribute("aria-label")).toBe("AsyncAPI document as YAML");
    expect(screen.getByTestId("event-code-text-editor").getAttribute("data-language")).toBe("yaml");
    expect(h.preview).not.toHaveBeenCalled();
  });

  it("fills the panel: the editor has the whole height of the labelled code region", () => {
    render(<EventCodePanel {...props()} />);
    const region = screen.getByRole("region", { name: "AsyncAPI code" });
    expect(region.contains(editor())).toBe(true);
    expect((screen.getByTestId("event-code-text-editor") as HTMLElement).style.height).toBe("100%");
  });

  it("has one stop for the keyboard, in the editor, not in the region around it", () => {
    render(<EventCodePanel {...props()} />);
    expect(screen.getByRole("region", { name: "AsyncAPI code" }).hasAttribute("tabindex")).toBe(false);
  });

  it("names the entity behind every placeholder schema", () => {
    render(<EventCodePanel {...props()} />);
    expect(code()).toContain("x-super-schema-entity: Order@1.0");
  });

  it("follows an edit at once, without waiting for the server", () => {
    const { rerender } = render(<EventCodePanel {...props()} />);
    expect(code()).toContain("title: Orders");
    rerender(<EventCodePanel {...props({ doc: makeDoc("Orders v2") })} />);
    expect(code()).toContain("title: Orders v2");
    expect(h.preview).not.toHaveBeenCalled();
  });

  it("shows a very long document in full, as the editor draws only what is in view", () => {
    const doc = makeDoc();
    doc.channels = Array.from({ length: 300 }, (_, i) => ({
      key: `ch${i}`, address: `topic.${i}`, protocol: "kafka", serverKeys: ["kafka"], format: "avro" as const, messageKeys: ["OrderCreated"],
    }));
    doc.operations = doc.channels.map((c, i) => ({ key: `op${i}`, action: "send" as const, channelKey: c.key, messageKeys: ["OrderCreated"], traitKeys: [] }));
    render(<EventCodePanel {...props({ doc })} />);
    expect(instantOf(doc).yaml.split("\n").length - 1).toBeGreaterThan(3000);
    expect(code()).toBe(instantOf(doc).yaml);
  });
});

describe("EventCodePanel: YAML | JSON", () => {
  it("starts on YAML and switches to the JSON of the same document and back", () => {
    const p = props();
    render(<EventCodePanel {...p} />);
    const instant = instantOf(p.doc);
    expect(screen.getByTestId("code-format-yaml").getAttribute("aria-pressed")).toBe("true");
    expect(screen.getByTestId("code-format-json").getAttribute("aria-pressed")).toBe("false");

    click("code-format-json");
    expect(code()).toBe(instant.json);
    expect(screen.getByTestId("code-format-json").getAttribute("aria-pressed")).toBe("true");
    expect(screen.getByTestId("code-format-yaml").getAttribute("aria-pressed")).toBe("false");
    expect(screen.getByTestId("event-code-text-editor").getAttribute("data-language")).toBe("json");
    expect(editor().getAttribute("aria-label")).toBe("AsyncAPI document as JSON");
    expect(JSON.parse(code())).toEqual(instant.document);

    click("code-format-yaml");
    expect(code()).toBe(instant.yaml);
    expect(screen.getByTestId("event-code-text-editor").getAttribute("data-language")).toBe("yaml");
  });

  it("keeps the chosen format when the document changes", () => {
    const { rerender } = render(<EventCodePanel {...props()} />);
    click("code-format-json");
    rerender(<EventCodePanel {...props({ doc: makeDoc("Orders v2") })} />);
    expect(code()).toContain('"title": "Orders v2"');
  });

  it("shows the server's JSON, not only its YAML, once the full render arrived", async () => {
    render(<EventCodePanel {...props()} />);
    click("code-format-json");
    await flush(CODE_DEBOUNCE_MS);
    expect(code()).toBe(SERVER_JSON);
    click("code-format-yaml");
    expect(code()).toBe(SERVER_YAML);
  });
});

describe("EventCodePanel: Copy", () => {
  const copied = async () => { await act(async () => { await Promise.resolve(); }); };

  it("copies the YAML that is on screen, and says so", async () => {
    const p = props();
    render(<EventCodePanel {...p} />);
    click("code-copy");
    await copied();
    expect(h.writeText).toHaveBeenCalledWith(instantOf(p.doc).yaml);
    expect(h.toastSuccess).toHaveBeenCalledTimes(1);
    expect(h.toastSuccess.mock.calls[0][0]).toContain("YAML");
  });

  it("copies the JSON when JSON is shown", async () => {
    const p = props();
    render(<EventCodePanel {...p} />);
    click("code-format-json");
    click("code-copy");
    await copied();
    expect(h.writeText).toHaveBeenCalledWith(instantOf(p.doc).json);
    expect(h.toastSuccess.mock.calls[0][0]).toContain("JSON");
  });

  it("copies the server's full code once it replaced the instant one", async () => {
    render(<EventCodePanel {...props()} />);
    await flush(CODE_DEBOUNCE_MS);
    click("code-copy");
    await copied();
    expect(h.writeText).toHaveBeenCalledWith(SERVER_YAML);
  });

  it("flips its label to Copied for a moment", async () => {
    render(<EventCodePanel {...props()} />);
    expect(text("code-copy")).toContain("Copy");
    click("code-copy");
    await copied();
    expect(text("code-copy")).toContain("Copied");
    await flush(2000);
    expect(text("code-copy")).not.toContain("Copied");
  });

  it("toasts an error and keeps the label when the clipboard refuses", async () => {
    h.writeText.mockRejectedValue(new Error("denied"));
    render(<EventCodePanel {...props()} />);
    click("code-copy");
    await copied();
    expect(h.toastError).toHaveBeenCalledTimes(1);
    expect(h.toastSuccess).not.toHaveBeenCalled();
    expect(text("code-copy")).not.toContain("Copied");
  });

  it("toasts an error when there is no clipboard API at all", async () => {
    Object.defineProperty(navigator, "clipboard", { value: undefined, configurable: true });
    render(<EventCodePanel {...props()} />);
    click("code-copy");
    await copied();
    expect(h.toastError).toHaveBeenCalledTimes(1);
  });
});

describe("EventCodePanel: status chip", () => {
  it("says Draft preview while the placeholders are shown, and Full schemas once the server render arrived", async () => {
    render(<EventCodePanel {...props()} />);
    expect(chip().textContent).toContain("Draft preview");
    expect(chip().getAttribute("data-state")).toBe("rendering");
    expect(chip().getAttribute("title")).toContain("placeholder");

    await flush(CODE_DEBOUNCE_MS - 1);
    expect(chip().getAttribute("data-state")).toBe("rendering");
    await flush(1);
    expect(h.preview).toHaveBeenCalledTimes(1);
    expect(chip().textContent).toContain("Full schemas");
    expect(chip().getAttribute("data-state")).toBe("full");
    expect(code()).toBe(SERVER_YAML);
  });

  it("goes back to Draft preview with the instant code the moment the draft is edited, then to Full schemas again", async () => {
    const { rerender } = render(<EventCodePanel {...props()} />);
    await flush(CODE_DEBOUNCE_MS);
    expect(chip().getAttribute("data-state")).toBe("full");

    rerender(<EventCodePanel {...props({ doc: makeDoc("Orders v2") })} />);
    expect(chip().textContent).toContain("Draft preview");
    expect(chip().getAttribute("data-state")).toBe("rendering");
    expect(code()).toContain("title: Orders v2");
    expect(code()).not.toContain("real payload schemas");

    h.preview.mockResolvedValue(emission({ yaml: "asyncapi: 3.0.0\n# second\n" }));
    await flush(CODE_DEBOUNCE_MS);
    expect(chip().getAttribute("data-state")).toBe("full");
    expect(code()).toBe("asyncapi: 3.0.0\n# second\n");
  });

  it("never shows a stale server answer for a document that was edited while it was in flight", async () => {
    let answer!: (v: unknown) => void;
    h.preview.mockReturnValueOnce(new Promise((r) => { answer = r; }));
    const { rerender } = render(<EventCodePanel {...props()} />);
    await flush(CODE_DEBOUNCE_MS);
    rerender(<EventCodePanel {...props({ doc: makeDoc("Orders v2") })} />);
    await act(async () => { answer(emission()); });
    expect(chip().getAttribute("data-state")).toBe("rendering");
    expect(code()).toContain("title: Orders v2");
    expect(code()).not.toContain("real payload schemas");
  });

  it("keeps Draft preview, with the server's diagnostics, when the server could not build the document", async () => {
    h.preview.mockResolvedValue(emission({
      document: null, yaml: null, json: null,
      diagnostics: [{ severity: "error", code: "RENDER_FAILED", message: "The payload of OrderCreated does not render.", pointer: "/messages/0/payload" }],
    }));
    const p = props();
    render(<EventCodePanel {...p} />);
    await flush(CODE_DEBOUNCE_MS);
    expect(chip().textContent).toContain("Draft preview");
    expect(chip().getAttribute("data-state")).toBe("draft");
    expect(code()).toBe(instantOf(p.doc).yaml);
    expect(text("code-diagnostics")).toContain("The payload of OrderCreated does not render.");
  });
});

describe("EventCodePanel: when the full render fails", () => {
  it("falls back to the instant code with a small note, and Retry asks again", async () => {
    h.preview.mockResolvedValueOnce({ success: false, error: 'Event "ev1" not found', code: "NOT_FOUND" });
    const p = props();
    render(<EventCodePanel {...p} />);
    await flush(CODE_DEBOUNCE_MS);
    expect(code()).toBe(instantOf(p.doc).yaml);
    expect(chip().textContent).toContain("Draft preview");
    expect(chip().getAttribute("data-state")).toBe("error");
    const note = screen.getByTestId("code-error-note");
    expect(note.textContent).toContain("Full schemas are unavailable");
    expect(note.textContent).toContain('Event "ev1" not found');
    expect(note.getAttribute("role")).toBe("status");

    click("code-retry");
    expect(h.preview).toHaveBeenCalledTimes(2);
    await flush(0);
    expect(screen.queryByTestId("code-error-note")).toBeNull();
    expect(chip().getAttribute("data-state")).toBe("full");
    expect(code()).toBe(SERVER_YAML);
  });

  it("never prints the cause of a rejected action", async () => {
    h.preview.mockRejectedValue(new Error("connect ECONNREFUSED 10.0.0.5:5432"));
    render(<EventCodePanel {...props()} />);
    await flush(CODE_DEBOUNCE_MS);
    expect(text("code-error-note")).toContain(GENERIC_ACTION_ERROR);
    expect(text("code-error-note")).not.toContain("ECONNREFUSED");
  });
});

describe("EventCodePanel: diagnostics", () => {
  const serverDiagnostics = [
    { severity: "warning", code: "UNPUBLISHED_PIN", message: "Payload is not pinned.", pointer: "/messages/0/payload" },
    { severity: "info", code: "NOTE", message: "Just so you know.", pointer: "" },
  ];

  it("shows a count badge and keeps the list collapsed when nothing is an error", async () => {
    h.preview.mockResolvedValue(emission({ diagnostics: serverDiagnostics }));
    render(<EventCodePanel {...props()} />);
    await flush(CODE_DEBOUNCE_MS);
    expect(text("code-diagnostics-count")).toBe("2");
    expect(screen.getByTestId("code-diagnostics-toggle").getAttribute("aria-expanded")).toBe("false");
    expect(screen.queryByTestId("diagnostics-list")).toBeNull();

    click("code-diagnostics-toggle");
    expect(screen.getByTestId("code-diagnostics-toggle").getAttribute("aria-expanded")).toBe("true");
    const list = screen.getByTestId("diagnostics-list");
    expect(list.textContent).toContain("Payload is not pinned.");
    expect(list.textContent).toContain("/messages/0/payload");
    expect(list.textContent).toContain("0 errors · 1 warning · 1 info");

    click("code-diagnostics-toggle");
    expect(screen.queryByTestId("diagnostics-list")).toBeNull();
  });

  it("opens by itself when there is an error, and the user can still close it", async () => {
    h.preview.mockResolvedValue(emission({ diagnostics: [{ severity: "error", code: "BAD", message: "Something is wrong.", pointer: "/x" }] }));
    render(<EventCodePanel {...props()} />);
    await flush(CODE_DEBOUNCE_MS);
    expect(screen.getByTestId("diagnostics-list").textContent).toContain("Something is wrong.");
    expect(within(screen.getByTestId("code-diagnostics-count")).queryByText("1")).not.toBeNull();
    click("code-diagnostics-toggle");
    expect(screen.queryByTestId("diagnostics-list")).toBeNull();
  });

  it("says there are no problems, and has nothing to expand, for an empty list", () => {
    render(<EventCodePanel {...props()} />);
    expect(text("code-diagnostics")).toContain("No problems");
    expect(screen.queryByTestId("code-diagnostics-count")).toBeNull();
    expect(screen.queryByTestId("diagnostics-list")).toBeNull();
  });

  it("reports the instant build's own notes (an external reference left out) before the server answered", () => {
    const doc = makeDoc();
    doc.externalRefs = [{ key: "ext", eventVersionId: "evv-1", kind: "message", itemKey: "AuditRecorded" }];
    render(<EventCodePanel {...props({ doc })} />);
    expect(text("code-diagnostics-count")).toBe("1");
    click("code-diagnostics-toggle");
    expect(screen.getByTestId("diagnostics-list").textContent).toContain("AuditRecorded");
  });
});

describe("EventCodePanel: a draft with problems", () => {
  const problems = [{ pointer: "/info/title", message: "title is required" }];
  const broken = () => props({ doc: makeDoc(""), problems });

  it("shows no code, says to fix the draft, lists the problems open, and sends nothing to the server", async () => {
    render(<EventCodePanel {...broken()} />);
    expect(screen.queryByTestId("event-code-text")).toBeNull();
    expect(text("code-empty")).toContain("Fix the problems in Design");
    expect(screen.getByTestId("diagnostics-list").textContent).toContain("title is required");
    expect(screen.getByTestId("diagnostics-list").textContent).toContain("/info/title");
    expect(screen.queryByTestId("code-status")).toBeNull();
    await flush(10_000);
    expect(h.preview).not.toHaveBeenCalled();
  });

  it("disables Copy and the format switch's effect while there is nothing to copy", async () => {
    render(<EventCodePanel {...broken()} />);
    expect((screen.getByTestId("code-copy") as HTMLButtonElement).disabled).toBe(true);
    click("code-copy");
    await act(async () => { await Promise.resolve(); });
    expect(h.writeText).not.toHaveBeenCalled();
  });

  it("comes back to life with code and status once the draft is fixed", async () => {
    const { rerender } = render(<EventCodePanel {...broken()} />);
    rerender(<EventCodePanel {...props({ doc: makeDoc("Fixed"), problems: [] })} />);
    expect(screen.queryByTestId("code-empty")).toBeNull();
    expect(code()).toContain("title: Fixed");
    expect(chip().getAttribute("data-state")).toBe("rendering");
    await flush(CODE_DEBOUNCE_MS);
    expect(chip().getAttribute("data-state")).toBe("full");
  });
});
