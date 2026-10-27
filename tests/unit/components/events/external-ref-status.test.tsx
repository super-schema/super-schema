// @vitest-environment jsdom
import { act, cleanup, renderHook } from "@testing-library/react";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { useExternalRefStatus } from "@/features/events/builder/use-external-ref-status";
import type { DocExternalRef } from "@/lib/events/document/types";

const h = vi.hoisted(() => ({ statuses: vi.fn() }));
vi.mock("@/app/(dashboard)/schemas/[domainSlug]/[productSlug]/event-actions", () => ({
  getExternalRefStatusesAction: h.statuses,
  getExternalVersionItemsAction: () => Promise.resolve({ success: false, error: "unavailable" }),
}));

const REFS: DocExternalRef[] = [{ key: "orders", kind: "channel", eventVersionId: "v1", itemKey: "orders.v1" }];
const STATUS = { eventVersionId: "v1", eventId: "e1", eventName: "orders", label: "1.0", latestVersionId: "v2", latestLabel: "2.0", newerAvailable: true, newerIsMajor: true, itemsMissingInLatest: [] };
const ANSWER = { success: true, data: [STATUS] };
const never = () => new Promise<never>(() => {});

beforeEach(() => {
  vi.clearAllMocks();
  vi.useFakeTimers();
});
afterEach(() => {
  cleanup();
  vi.useRealTimers();
});

/** Lets the dynamic import of the actions and the pending promises settle, then moves the clock on. */
const advance = (ms: number) => act(async () => { await vi.advanceTimersByTimeAsync(ms); });

describe("useExternalRefStatus", () => {
  it("gives the status of each referenced version once the action answers", async () => {
    h.statuses.mockResolvedValue(ANSWER);
    const { result } = renderHook(() => useExternalRefStatus("p1", REFS));
    expect(result.current).toBeNull();
    await advance(10);
    expect(result.current?.get("v1")).toMatchObject({ newerAvailable: true, latestLabel: "2.0" });
    expect(h.statuses).toHaveBeenCalledTimes(1);
    expect(h.statuses).toHaveBeenCalledWith("p1", [{ eventVersionId: "v1", kind: "channel", itemKey: "orders.v1" }]);
  });

  it("asks again when no answer comes (the app router drops a Server Action that a history change lands on)", async () => {
    h.statuses.mockImplementationOnce(never).mockResolvedValue(ANSWER);
    const { result } = renderHook(() => useExternalRefStatus("p1", REFS));
    await advance(3000);
    expect(h.statuses).toHaveBeenCalledTimes(1);
    expect(result.current).toBeNull();
    await advance(2000);
    expect(h.statuses).toHaveBeenCalledTimes(2);
    expect(result.current?.get("v1")?.newerAvailable).toBe(true);
  });

  it("gives up after three tries, leaves the references without a status, and stops asking", async () => {
    h.statuses.mockImplementation(never);
    const { result } = renderHook(() => useExternalRefStatus("p1", REFS));
    await advance(30_000);
    expect(h.statuses).toHaveBeenCalledTimes(3);
    expect(result.current).toBeNull();
    await advance(60_000);
    expect(h.statuses).toHaveBeenCalledTimes(3);
  });

  it("does not ask again once the references are gone from the screen", async () => {
    h.statuses.mockImplementation(never);
    const { unmount } = renderHook(() => useExternalRefStatus("p1", REFS));
    await advance(10);
    unmount();
    await advance(30_000);
    expect(h.statuses).toHaveBeenCalledTimes(1);
  });

  it("does not ask again after a refusal: a refused call is an answer", async () => {
    h.statuses.mockResolvedValue({ success: false, error: "no", code: "FORBIDDEN" });
    const { result } = renderHook(() => useExternalRefStatus("p1", REFS));
    await advance(30_000);
    expect(h.statuses).toHaveBeenCalledTimes(1);
    expect(result.current).toBeNull();
  });

  it("asks nothing for a document with no references", async () => {
    renderHook(() => useExternalRefStatus("p1", []));
    await advance(30_000);
    expect(h.statuses).not.toHaveBeenCalled();
  });
});
