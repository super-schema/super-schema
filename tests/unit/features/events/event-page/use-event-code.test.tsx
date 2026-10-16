// @vitest-environment jsdom
import { act, cleanup, renderHook } from "@testing-library/react";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";

const h = vi.hoisted(() => ({ preview: vi.fn() }));
vi.mock("@/app/(dashboard)/schemas/[domainSlug]/[productSlug]/event-actions", () => ({ previewEventDocumentAction: h.preview }));

import { CODE_DEBOUNCE_MS, useEventCode, type UseEventCodeArgs } from "@/features/events/event-page/use-event-code";
import { emptyEventDocument, type EventDocument } from "@/lib/events/document/types";
import { PLACEHOLDER_ENTITY_KEY } from "@/lib/events/document/instant-asyncapi";
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
const retitle = (doc: EventDocument, title: string): EventDocument => ({ ...doc, info: { ...doc.info, title } });

const emission = (marker: string, over: Record<string, unknown> = {}) => ({
  success: true as const,
  data: {
    document: { asyncapi: "3.0.0", info: { title: marker, version: "draft" } },
    yaml: `# server ${marker}\nasyncapi: 3.0.0\n`,
    json: `{"server":"${marker}"}\n`,
    diagnostics: [{ severity: "warning" as const, code: "FROM_SERVER", message: `server says ${marker}`, pointer: "/info" }],
    ...over,
  },
});

type Props = Partial<UseEventCodeArgs> & { doc: EventDocument };
function setup(initial: Props) {
  const render = (p: Props): UseEventCodeArgs => ({
    eventId: "ev1", productId: "p1", productSlug: "checkout", blocked: false, entityLabels: ENTITY_LABELS, versionLabels: VERSION_LABELS, ...p,
  });
  return renderHook((p: Props) => useEventCode(render(p)), { initialProps: initial });
}

const flush = (ms: number) => act(async () => { await vi.advanceTimersByTimeAsync(ms); });
function deferred<T>() {
  let resolve!: (value: T) => void;
  const promise = new Promise<T>((r) => { resolve = r; });
  return { promise, resolve };
}

beforeEach(() => {
  vi.useFakeTimers();
  h.preview.mockReset();
  h.preview.mockImplementation(async (_e: string, _p: string, doc: EventDocument) => emission(doc.info.title));
});
afterEach(() => {
  cleanup();
  vi.useRealTimers();
  vi.restoreAllMocks();
});

describe("useEventCode: the instant code", () => {
  it("is there on the very first render, built from the draft with placeholder schemas, before any server call", () => {
    const { result } = setup({ doc: makeDoc() });
    expect(result.current.instant.document).not.toBeNull();
    expect(result.current.yaml).toBe(result.current.instant.yaml);
    expect(result.current.yaml).toContain("title: Orders");
    expect(result.current.yaml).toContain(`${PLACEHOLDER_ENTITY_KEY}: Order@1.0`);
    expect(result.current.json).toBe(result.current.instant.json);
    expect(result.current.status).toBe("rendering");
    expect(h.preview).not.toHaveBeenCalled();
  });

  it("follows every edit synchronously: no timer has to run for the code to change", () => {
    const { result, rerender } = setup({ doc: makeDoc() });
    const before = result.current.yaml;
    rerender({ doc: retitle(makeDoc(), "Orders v2") });
    expect(result.current.yaml).toContain("title: Orders v2");
    expect(result.current.yaml).not.toBe(before);
    rerender({ doc: retitle(makeDoc(), "Orders v3") });
    expect(result.current.yaml).toContain("title: Orders v3");
    expect(JSON.parse(result.current.json).info.title).toBe("Orders v3");
    expect(h.preview).not.toHaveBeenCalled();
  });

  it("uses the entity labels it is given", () => {
    const { result } = setup({ doc: makeDoc(), entityLabels: new Map([["ent-1", "Purchase"]]), versionLabels: new Map([["ver-1", "7.2"]]) });
    expect(result.current.yaml).toContain(`${PLACEHOLDER_ENTITY_KEY}: Purchase@7.2`);
  });
});

describe("useEventCode: the server render", () => {
  it("is requested once, after 800 ms without an edit, with the unsaved document", async () => {
    expect(CODE_DEBOUNCE_MS).toBe(800);
    const doc = makeDoc("Orders v2");
    setup({ doc });
    await flush(CODE_DEBOUNCE_MS - 1);
    expect(h.preview).not.toHaveBeenCalled();
    await flush(1);
    expect(h.preview).toHaveBeenCalledTimes(1);
    expect(h.preview).toHaveBeenCalledWith("ev1", "p1", doc);
    await flush(10_000);
    expect(h.preview).toHaveBeenCalledTimes(1);
  });

  it("swaps in the server's YAML, JSON, document and diagnostics when it answers for the SAME document", async () => {
    const { result } = setup({ doc: makeDoc("A") });
    const instant = result.current.instant;
    await flush(CODE_DEBOUNCE_MS);
    expect(result.current.status).toBe("full");
    expect(result.current.yaml).toBe("# server A\nasyncapi: 3.0.0\n");
    expect(result.current.json).toBe('{"server":"A"}\n');
    expect(result.current.document).toEqual({ asyncapi: "3.0.0", info: { title: "A", version: "draft" } });
    expect(result.current.diagnostics).toEqual([{ severity: "warning", code: "FROM_SERVER", message: "server says A", pointer: "/info" }]);
    expect(result.current.error).toBeNull();
    // the instant build stays available underneath
    expect(result.current.instant).toBe(instant);
  });

  it("restarts the debounce on every edit and sends only the last document", async () => {
    const { rerender } = setup({ doc: makeDoc("A") });
    await flush(500);
    rerender({ doc: makeDoc("B") });
    await flush(500);
    rerender({ doc: makeDoc("C") });
    await flush(799);
    expect(h.preview).not.toHaveBeenCalled();
    await flush(1);
    expect(h.preview).toHaveBeenCalledTimes(1);
    expect(h.preview.mock.calls[0][2].info.title).toBe("C");
  });

  it("falls back to the instant code the moment the document changes after a full render, and renders again", async () => {
    const { result, rerender } = setup({ doc: makeDoc("A") });
    await flush(CODE_DEBOUNCE_MS);
    expect(result.current.status).toBe("full");
    rerender({ doc: makeDoc("B") });
    expect(result.current.status).toBe("rendering");
    expect(result.current.yaml).toContain("title: B");
    expect(result.current.yaml).not.toContain("# server");
    await flush(CODE_DEBOUNCE_MS);
    expect(result.current.status).toBe("full");
    expect(result.current.yaml).toBe("# server B\nasyncapi: 3.0.0\n");
  });

  it("DROPS a stale answer: the answer for the old document never shows over the new document's code", async () => {
    const first = deferred<unknown>();
    const second = deferred<unknown>();
    h.preview.mockReturnValueOnce(first.promise).mockReturnValueOnce(second.promise);
    const { result, rerender } = setup({ doc: makeDoc("A") });
    await flush(CODE_DEBOUNCE_MS);
    expect(h.preview).toHaveBeenCalledTimes(1);

    rerender({ doc: makeDoc("B") }); // the user kept typing while A was in flight
    await act(async () => { first.resolve(emission("A")); });
    expect(result.current.status).toBe("rendering");
    expect(result.current.yaml).toContain("title: B");
    expect(result.current.yaml).not.toContain("# server A");

    await flush(CODE_DEBOUNCE_MS);
    expect(h.preview).toHaveBeenCalledTimes(2);
    await act(async () => { second.resolve(emission("B")); });
    expect(result.current.status).toBe("full");
    expect(result.current.yaml).toBe("# server B\nasyncapi: 3.0.0\n");
  });

  it("drops an older answer that arrives AFTER the newer one", async () => {
    const first = deferred<unknown>();
    const second = deferred<unknown>();
    h.preview.mockReturnValueOnce(first.promise).mockReturnValueOnce(second.promise);
    const { result, rerender } = setup({ doc: makeDoc("A") });
    await flush(CODE_DEBOUNCE_MS);
    rerender({ doc: makeDoc("B") });
    await flush(CODE_DEBOUNCE_MS);
    expect(h.preview).toHaveBeenCalledTimes(2);
    await act(async () => { second.resolve(emission("B")); });
    await act(async () => { first.resolve(emission("A")); });
    expect(result.current.yaml).toBe("# server B\nasyncapi: 3.0.0\n");
    expect(result.current.diagnostics[0].message).toBe("server says B");
  });

  it("reuses the answer when an edit is undone before the next one arrives (same content, new object)", async () => {
    const { result, rerender } = setup({ doc: makeDoc("A") });
    await flush(CODE_DEBOUNCE_MS);
    rerender({ doc: makeDoc("B") });
    expect(result.current.status).toBe("rendering");
    rerender({ doc: makeDoc("A") });
    expect(result.current.status).toBe("full");
    expect(result.current.yaml).toBe("# server A\nasyncapi: 3.0.0\n");
    await flush(10_000);
    expect(h.preview).toHaveBeenCalledTimes(1);
  });

  it("treats key order as no change: the same content with its keys in another order is the same document", async () => {
    const doc = makeDoc("A");
    const { result, rerender } = setup({ doc });
    await flush(CODE_DEBOUNCE_MS);
    const reordered = { operations: doc.operations, messages: doc.messages, channels: doc.channels, servers: doc.servers, info: doc.info, traits: doc.traits, externalRefs: doc.externalRefs, documentVersion: doc.documentVersion } as EventDocument;
    rerender({ doc: reordered });
    expect(result.current.status).toBe("full");
    await flush(10_000);
    expect(h.preview).toHaveBeenCalledTimes(1);
  });

  it("does not apply an answer that belongs to another event", async () => {
    const { result, rerender } = setup({ doc: makeDoc("A") });
    await flush(CODE_DEBOUNCE_MS);
    expect(result.current.status).toBe("full");
    rerender({ doc: makeDoc("A"), eventId: "ev2" });
    expect(result.current.status).toBe("rendering");
    expect(result.current.yaml).toContain("title: A");
    expect(result.current.yaml).not.toContain("# server");
    await flush(CODE_DEBOUNCE_MS);
    expect(h.preview).toHaveBeenCalledTimes(2);
    expect(h.preview.mock.calls[1].slice(0, 2)).toEqual(["ev2", "p1"]);
  });

  it("keeps the instant code, and shows the server's diagnostics, when the server could not build the document", async () => {
    h.preview.mockResolvedValue(emission("A", {
      document: null, yaml: null, json: null,
      diagnostics: [{ severity: "error", code: "RENDER_FAILED", message: "The payload does not render.", pointer: "/messages/0/payload" }],
    }));
    const { result } = setup({ doc: makeDoc("A") });
    await flush(CODE_DEBOUNCE_MS);
    expect(result.current.status).toBe("draft");
    expect(result.current.yaml).toBe(result.current.instant.yaml);
    expect(result.current.json).toBe(result.current.instant.json);
    expect(result.current.document).toBe(result.current.instant.document);
    expect(result.current.diagnostics.map((d) => d.code)).toEqual(["RENDER_FAILED"]);
    expect(result.current.error).toBeNull();
  });

  it("stops the pending call when the hook unmounts, and sets no state after it", async () => {
    const error = vi.spyOn(console, "error").mockImplementation(() => {});
    const pending = deferred<unknown>();
    h.preview.mockReturnValue(pending.promise);
    const { unmount } = setup({ doc: makeDoc("A") });
    await flush(CODE_DEBOUNCE_MS);
    unmount();
    await act(async () => { pending.resolve(emission("A")); });
    expect(error).not.toHaveBeenCalled();

    const { unmount: unmount2 } = setup({ doc: makeDoc("B") });
    h.preview.mockClear();
    unmount2();
    await flush(10_000);
    expect(h.preview).not.toHaveBeenCalled();
  });
});

describe("useEventCode: failures fall back to the instant code", () => {
  it("shows the action's error text, keeps the instant code and diagnostics, and does not retry by itself", async () => {
    h.preview.mockResolvedValue({ success: false, error: 'Event "ev1" not found', code: "NOT_FOUND" });
    const { result } = setup({ doc: makeDoc("A") });
    await flush(CODE_DEBOUNCE_MS);
    expect(result.current.status).toBe("error");
    expect(result.current.error).toBe('Event "ev1" not found');
    expect(result.current.yaml).toBe(result.current.instant.yaml);
    expect(result.current.diagnostics).toBe(result.current.instant.diagnostics);
    await flush(10_000);
    expect(h.preview).toHaveBeenCalledTimes(1);
  });

  it("never prints the cause of a rejected action or the raw text of a database error", async () => {
    h.preview.mockRejectedValue(new Error("connect ECONNREFUSED 10.0.0.5:5432"));
    const { result } = setup({ doc: makeDoc("A") });
    await flush(CODE_DEBOUNCE_MS);
    expect(result.current.status).toBe("error");
    expect(result.current.error).toBe(GENERIC_ACTION_ERROR);

    h.preview.mockResolvedValue({ success: false, error: 'relation "event_specs" does not exist', code: "DB_ERROR" });
    act(() => result.current.retry());
    await flush(0);
    expect(result.current.error).toBe(GENERIC_ACTION_ERROR);
  });

  it("clears the error on the next edit and tries the new document", async () => {
    h.preview.mockResolvedValueOnce({ success: false, error: "nope", code: "NOT_FOUND" });
    const { result, rerender } = setup({ doc: makeDoc("A") });
    await flush(CODE_DEBOUNCE_MS);
    expect(result.current.status).toBe("error");
    rerender({ doc: makeDoc("B") });
    expect(result.current.error).toBeNull();
    expect(result.current.status).toBe("rendering");
    await flush(CODE_DEBOUNCE_MS);
    expect(result.current.status).toBe("full");
  });

  it("retry() asks again immediately (no debounce), even for an unchanged document, and recovers", async () => {
    h.preview.mockResolvedValueOnce({ success: false, error: "nope", code: "NOT_FOUND" });
    const { result } = setup({ doc: makeDoc("A") });
    await flush(CODE_DEBOUNCE_MS);
    expect(result.current.status).toBe("error");
    act(() => result.current.retry());
    expect(h.preview).toHaveBeenCalledTimes(2);
    expect(result.current.status).toBe("rendering");
    await flush(0);
    expect(result.current.status).toBe("full");
    expect(result.current.error).toBeNull();
  });
});

describe("useEventCode: a draft that does not parse", () => {
  const broken = () => retitle(makeDoc(), "");

  it("has no code, only the parse problems as diagnostics, and never calls the server", async () => {
    const { result } = setup({ doc: broken(), blocked: true });
    expect(result.current.instant.document).toBeNull();
    expect(result.current.document).toBeNull();
    expect(result.current.yaml).toBe("");
    expect(result.current.json).toBe("");
    expect(result.current.status).toBe("draft");
    expect(result.current.diagnostics.map((d) => [d.code, d.pointer])).toEqual([["INVALID_DRAFT", "/info/title"]]);
    await flush(10_000);
    expect(h.preview).not.toHaveBeenCalled();
  });

  it("cancels a pending call when the draft becomes invalid, and renders once it is fixed", async () => {
    const { result, rerender } = setup({ doc: makeDoc("A") });
    await flush(CODE_DEBOUNCE_MS - 100);
    rerender({ doc: broken(), blocked: true });
    await flush(10_000);
    expect(h.preview).not.toHaveBeenCalled();
    rerender({ doc: makeDoc("Fixed"), blocked: false });
    expect(result.current.yaml).toContain("title: Fixed");
    await flush(CODE_DEBOUNCE_MS);
    expect(h.preview).toHaveBeenCalledTimes(1);
    expect(h.preview.mock.calls[0][2].info.title).toBe("Fixed");
  });

  it("drops an answer that arrives after the draft became invalid", async () => {
    const pending = deferred<unknown>();
    h.preview.mockReturnValue(pending.promise);
    const { result, rerender } = setup({ doc: makeDoc("A") });
    await flush(CODE_DEBOUNCE_MS);
    rerender({ doc: broken(), blocked: true });
    await act(async () => { pending.resolve(emission("A")); });
    expect(result.current.yaml).toBe("");
    expect(result.current.status).toBe("draft");
  });
});
