// @vitest-environment jsdom
import { act, cleanup, renderHook } from "@testing-library/react";
import { afterEach, describe, expect, it, vi, type Mock } from "vitest";
import { useEventDraft, type SaveDocument } from "@/features/events/builder/use-event-draft";
import { emptyEventDocument, type EventDocument } from "@/lib/events/document/types";
import { GENERIC_ACTION_ERROR, type ActionResult } from "@/types/action-result";
import type { EventDetail } from "@/services/events/event.service";

const pin = { entityId: "e1", entityVersionId: "v1" };

function makeDoc(): EventDocument {
  return {
    ...emptyEventDocument("Orders", "Order events"),
    servers: [{ key: "kafka-prod", protocol: "kafka", host: "h:9092" }],
    channels: [{ key: "orders", address: "orders", protocol: "kafka", serverKeys: ["kafka-prod"], format: "avro", messageKeys: ["OrderCreated"] }],
    messages: [{ key: "OrderCreated", payload: pin, traitKeys: [] }],
    operations: [{ key: "publishOrder", action: "send", channelKey: "orders", messageKeys: ["OrderCreated"], traitKeys: [] }],
  };
}

function makeEvent(document: EventDocument = makeDoc(), id = "ev1"): EventDetail {
  return {
    id, name: "orders", specType: "asyncapi@3.0", document, latestVersionLabel: null, hasUnpublishedChanges: true,
    tenantId: "t1", domainId: "d1", productId: "p1",
  };
}

const retitle = (title: string) => (d: EventDocument): EventDocument => ({ ...d, info: { ...d.info, title } });

function setup(opts: { event?: EventDetail; saveDocument?: Mock<SaveDocument>; onSaved?: (d: EventDetail) => void } = {}) {
  const event = opts.event ?? makeEvent();
  const saveDocument = opts.saveDocument ?? vi.fn<SaveDocument>().mockResolvedValue({ success: true, data: event });
  const hook = renderHook((props: { event: EventDetail }) => useEventDraft({ event: props.event, productId: "p1", saveDocument, onSaved: opts.onSaved }), {
    initialProps: { event },
  });
  return { ...hook, event, saveDocument };
}

function deferred<T>() {
  let resolve!: (value: T) => void;
  const promise = new Promise<T>((r) => { resolve = r; });
  return { promise, resolve };
}

const validationFailure = (problems: Array<{ pointer: string; message: string }>): ActionResult<EventDetail> => ({
  success: false, error: `${problems.length} problem(s) in the event document`, code: "VALIDATION_ERROR",
  suggestedFix: "Fix the highlighted fields and save again.", details: { problems },
});

afterEach(() => cleanup());

describe("useEventDraft: state", () => {
  it("starts from the event's document, clean, with no problems", () => {
    const { result, event } = setup();
    expect(result.current.doc).toEqual(event.document);
    expect(result.current.dirty).toBe(false);
    expect(result.current.saving).toBe(false);
    expect(result.current.problems).toEqual([]);
    expect(result.current.serverProblems).toEqual([]);
    expect(result.current.error).toBeNull();
  });

  it("toggles dirty on edit and on reverting the edit", () => {
    const { result } = setup();
    act(() => result.current.update(retitle("Orders v2")));
    expect(result.current.doc.info.title).toBe("Orders v2");
    expect(result.current.dirty).toBe(true);
    act(() => result.current.update(retitle("Orders")));
    expect(result.current.dirty).toBe(false);
  });

  it("compares by content, not key order or undefined-valued keys", () => {
    const { result } = setup();
    act(() => result.current.update((d) => ({ ...d, info: { description: "Order events", title: "Orders" } })));
    expect(result.current.dirty).toBe(false);
    act(() => result.current.update((d) => ({ ...d, defaultContentType: undefined })));
    expect(result.current.dirty).toBe(false);
    act(() => result.current.update((d) => ({ ...d, info: { title: "Orders" } })));
    expect(result.current.dirty).toBe(true);
  });

  it("setDoc replaces the whole document", () => {
    const { result } = setup();
    const next = { ...makeDoc(), servers: [] };
    act(() => result.current.setDoc(next));
    expect(result.current.doc).toBe(next);
    expect(result.current.dirty).toBe(true);
  });

  it("recomputes the client problems on every change (empty title → /info/title)", () => {
    const { result } = setup();
    act(() => result.current.update(retitle("")));
    expect(result.current.problems.map((p) => p.pointer)).toEqual(["/info/title"]);
    act(() => result.current.update(retitle("Orders")));
    expect(result.current.problems).toEqual([]);
  });

  it("reports the problems of an incomplete document without blocking edits (blank server host)", () => {
    const { result } = setup();
    act(() => result.current.update((d) => ({ ...d, servers: [...d.servers, { key: "dev", protocol: "kafka", host: "" }] })));
    expect(result.current.problems).toEqual([{ pointer: "/servers/1/host", message: "host is required" }]);
    expect(result.current.dirty).toBe(true);
  });

  it("an update that returns the same document changes nothing (a failed save's problems stay visible)", async () => {
    const failure = validationFailure([{ pointer: "/info/title", message: "server says no" }]);
    const { result } = setup({ saveDocument: vi.fn<SaveDocument>().mockResolvedValue(failure) });
    await act(async () => { await result.current.save(); });
    expect(result.current.serverProblems).toHaveLength(1);
    act(() => result.current.update((d) => d));
    expect(result.current.serverProblems).toHaveLength(1);
    expect(result.current.error).not.toBeNull();
  });
});

describe("useEventDraft: save", () => {
  it("calls saveDocument(event.id, productId, doc), resets dirty and calls onSaved with the detail", async () => {
    const onSaved = vi.fn();
    const event = makeEvent();
    const detail = makeEvent({ ...makeDoc(), info: { title: "Orders v2", description: "Order events" } });
    const saveDocument = vi.fn<SaveDocument>().mockResolvedValue({ success: true, data: detail });
    const { result } = setup({ event, saveDocument, onSaved });
    act(() => result.current.update(retitle("Orders v2")));
    let saved: boolean | undefined;
    await act(async () => { saved = await result.current.save(); });
    expect(saved).toBe(true);
    expect(saveDocument).toHaveBeenCalledTimes(1);
    expect(saveDocument).toHaveBeenCalledWith("ev1", "p1", expect.objectContaining({ info: { title: "Orders v2", description: "Order events" } }));
    expect(onSaved).toHaveBeenCalledWith(detail);
    expect(result.current.dirty).toBe(false);
    expect(result.current.saving).toBe(false);
    expect(result.current.error).toBeNull();
    expect(result.current.serverProblems).toEqual([]);
    expect(result.current.doc.info.title).toBe("Orders v2");
  });

  it("works without onSaved", async () => {
    const { result } = setup();
    act(() => result.current.update(retitle("Orders v2")));
    let saved: boolean | undefined;
    await act(async () => { saved = await result.current.save(); });
    expect(saved).toBe(true);
    expect(result.current.dirty).toBe(false);
  });

  it("an edit after a successful save is dirty against the saved document, and reverting it is clean again", async () => {
    const { result } = setup();
    act(() => result.current.update(retitle("Orders v2")));
    await act(async () => { await result.current.save(); });
    act(() => result.current.update(retitle("Orders v3")));
    expect(result.current.dirty).toBe(true);
    act(() => result.current.update(retitle("Orders v2")));
    expect(result.current.dirty).toBe(false);
    act(() => result.current.update(retitle("Orders v3")));
    act(() => result.current.discard());
    expect(result.current.doc.info.title).toBe("Orders v2");
  });

  it("keeps every edit and exposes serverProblems + error when the save fails with validation problems", async () => {
    const onSaved = vi.fn();
    const problems = [{ pointer: "/servers/0/host", message: "host must be host or host:port" }, { pointer: "/info/title", message: "title is required" }];
    const saveDocument = vi.fn<SaveDocument>().mockResolvedValue(validationFailure(problems));
    const { result } = setup({ saveDocument, onSaved });
    act(() => result.current.update(retitle("Orders v2")));
    let saved: boolean | undefined;
    await act(async () => { saved = await result.current.save(); });
    expect(saved).toBe(false);
    expect(result.current.serverProblems).toEqual(problems);
    expect(result.current.error).toBe("2 problem(s) in the event document. Fix the highlighted fields and save again.");
    expect(result.current.doc.info.title).toBe("Orders v2");
    expect(result.current.dirty).toBe(true);
    expect(result.current.saving).toBe(false);
    expect(onSaved).not.toHaveBeenCalled();
  });

  it("never exposes raw database text: a DB_ERROR failure becomes the generic message", async () => {
    const saveDocument = vi.fn<SaveDocument>().mockResolvedValue({ success: false, error: "connect ECONNREFUSED 10.0.0.5:5432", code: "DB_ERROR" });
    const { result } = setup({ saveDocument });
    act(() => result.current.update(retitle("Orders v2")));
    await act(async () => { await result.current.save(); });
    expect(result.current.error).toBe(GENERIC_ACTION_ERROR);
    expect(result.current.serverProblems).toEqual([]);
  });

  it("a failure without details.problems leaves serverProblems empty but still shows the error", async () => {
    const saveDocument = vi.fn<SaveDocument>().mockResolvedValue({ success: false, error: "You do not have access to this event", code: "FORBIDDEN" });
    const { result } = setup({ saveDocument });
    act(() => result.current.update(retitle("Orders v2")));
    await act(async () => { await result.current.save(); });
    expect(result.current.error).toBe("You do not have access to this event");
    expect(result.current.serverProblems).toEqual([]);
    expect(result.current.dirty).toBe(true);
  });

  it("a rejected action shows the generic message, keeps the edits and leaves Save usable (nothing unhandled)", async () => {
    const unhandled = vi.fn();
    process.on("unhandledRejection", unhandled);
    try {
      const saveDocument = vi.fn<SaveDocument>()
        .mockRejectedValueOnce(new Error("connect ECONNREFUSED 10.0.0.5:5432 password authentication failed"))
        .mockResolvedValueOnce({ success: true, data: makeEvent() });
      const { result } = setup({ saveDocument });
      act(() => result.current.update(retitle("Orders v2")));
      let saved: boolean | undefined;
      await act(async () => { saved = await result.current.save(); });
      expect(saved).toBe(false);
      expect(result.current.error).toBe(GENERIC_ACTION_ERROR);
      expect(result.current.saving).toBe(false);
      expect(result.current.dirty).toBe(true);
      await act(async () => { saved = await result.current.save(); });
      expect(saved).toBe(true);
      expect(result.current.error).toBeNull();
      await new Promise((r) => setTimeout(r, 0));
      expect(unhandled).not.toHaveBeenCalled();
    } finally {
      process.off("unhandledRejection", unhandled);
    }
  });

  it("a throwing onSaved does not turn a saved draft into a failed save", async () => {
    const consoleError = vi.spyOn(console, "error").mockImplementation(() => undefined);
    try {
      const onSaved = vi.fn(() => { throw new Error("router exploded"); });
      const { result } = setup({ onSaved });
      act(() => result.current.update(retitle("Orders v2")));
      let saved: boolean | undefined;
      await act(async () => { saved = await result.current.save(); });
      expect(saved).toBe(true);
      expect(onSaved).toHaveBeenCalledTimes(1);
      expect(result.current.dirty).toBe(false);
      expect(result.current.error).toBeNull();
      expect(consoleError).toHaveBeenCalled();
    } finally {
      consoleError.mockRestore();
    }
  });

  it("still calls the action when the client already sees problems: the server is the authority", async () => {
    const { result, saveDocument } = setup();
    act(() => result.current.update(retitle("")));
    expect(result.current.problems).toHaveLength(1);
    await act(async () => { await result.current.save(); });
    expect(saveDocument).toHaveBeenCalledTimes(1);
    expect(saveDocument.mock.calls[0][2]).toMatchObject({ info: { title: "" } });
  });

  it("clears serverProblems and error on the next edit", async () => {
    const saveDocument = vi.fn<SaveDocument>().mockResolvedValue(validationFailure([{ pointer: "/info/title", message: "title is required" }]));
    const { result } = setup({ saveDocument });
    act(() => result.current.update(retitle("")));
    await act(async () => { await result.current.save(); });
    expect(result.current.serverProblems).toHaveLength(1);
    act(() => result.current.update(retitle("Orders v2")));
    expect(result.current.serverProblems).toEqual([]);
    expect(result.current.error).toBeNull();
  });

  it("is single-flight: a second save while one is in flight returns false and does not call the action again", async () => {
    const gate = deferred<ActionResult<EventDetail>>();
    const saveDocument = vi.fn<SaveDocument>().mockReturnValue(gate.promise);
    const { result } = setup({ saveDocument });
    act(() => result.current.update(retitle("Orders v2")));
    let first!: Promise<boolean>;
    let second: boolean | undefined;
    await act(async () => {
      first = result.current.save();
      second = await result.current.save();
    });
    expect(second).toBe(false);
    expect(saveDocument).toHaveBeenCalledTimes(1);
    expect(result.current.saving).toBe(true);
    await act(async () => { gate.resolve({ success: true, data: makeEvent() }); await first; });
    expect(await first).toBe(true);
    expect(result.current.saving).toBe(false);
    await act(async () => { await result.current.save(); });
    expect(saveDocument).toHaveBeenCalledTimes(2);
  });

  it("an edit made while the save is in flight stays dirty and is not overwritten by the save result", async () => {
    const gate = deferred<ActionResult<EventDetail>>();
    const saveDocument = vi.fn<SaveDocument>().mockReturnValue(gate.promise);
    const { result } = setup({ saveDocument });
    act(() => result.current.update(retitle("Orders v2")));
    let pending!: Promise<boolean>;
    act(() => { pending = result.current.save(); });
    act(() => result.current.update(retitle("Orders v3")));
    await act(async () => { gate.resolve({ success: true, data: makeEvent() }); await pending; });
    expect(result.current.doc.info.title).toBe("Orders v3");
    expect(result.current.dirty).toBe(true);
  });

  it("a failure of an in-flight save does not attach its problems to a document that has changed since", async () => {
    const gate = deferred<ActionResult<EventDetail>>();
    const saveDocument = vi.fn<SaveDocument>().mockReturnValue(gate.promise);
    const { result } = setup({ saveDocument });
    act(() => result.current.update(retitle("")));
    let pending!: Promise<boolean>;
    act(() => { pending = result.current.save(); });
    act(() => result.current.update(retitle("Orders v2")));
    await act(async () => { gate.resolve(validationFailure([{ pointer: "/info/title", message: "title is required" }])); await pending; });
    expect(result.current.serverProblems).toEqual([]);
    expect(result.current.doc.info.title).toBe("Orders v2");
  });
});

describe("useEventDraft: discard", () => {
  it("restores the last saved document and clears problems and error", async () => {
    const saveDocument = vi.fn<SaveDocument>().mockResolvedValue(validationFailure([{ pointer: "/info/title", message: "title is required" }]));
    const { result, event } = setup({ saveDocument });
    act(() => result.current.update(retitle("")));
    await act(async () => { await result.current.save(); });
    act(() => result.current.discard());
    expect(result.current.doc).toEqual(event.document);
    expect(result.current.dirty).toBe(false);
    expect(result.current.problems).toEqual([]);
    expect(result.current.serverProblems).toEqual([]);
    expect(result.current.error).toBeNull();
  });
});

describe("useEventDraft: leave-without-saving guard", () => {
  const fire = () => {
    const e = new Event("beforeunload", { cancelable: true });
    window.dispatchEvent(e);
    return e.defaultPrevented;
  };

  it("asks the browser to confirm leaving while the draft is dirty, and only then", async () => {
    const { result } = setup();
    expect(fire()).toBe(false);
    act(() => result.current.update(retitle("Orders v2")));
    expect(fire()).toBe(true);
    await act(async () => { await result.current.save(); });
    expect(fire()).toBe(false);
  });

  it("is lifted by discard and removed on unmount", () => {
    const { result, unmount } = setup();
    act(() => result.current.update(retitle("Orders v2")));
    expect(fire()).toBe(true);
    act(() => result.current.discard());
    expect(fire()).toBe(false);
    act(() => result.current.update(retitle("Orders v3")));
    expect(fire()).toBe(true);
    unmount();
    expect(fire()).toBe(false);
  });
});

describe("useEventDraft: a different event", () => {
  it("starts over from the new event's document instead of showing another event's edits", () => {
    const { result, rerender } = setup();
    act(() => result.current.update(retitle("Unsaved edit")));
    expect(result.current.dirty).toBe(true);
    const other = makeEvent({ ...emptyEventDocument("Payments"), servers: [] }, "ev2");
    rerender({ event: other });
    expect(result.current.doc.info.title).toBe("Payments");
    expect(result.current.dirty).toBe(false);
  });

  it("keeps the draft when the same event is re-rendered with a refreshed copy (after router.refresh)", () => {
    const { result, rerender } = setup();
    act(() => result.current.update(retitle("Unsaved edit")));
    rerender({ event: makeEvent(makeDoc(), "ev1") });
    expect(result.current.doc.info.title).toBe("Unsaved edit");
    expect(result.current.dirty).toBe(true);
  });
});
