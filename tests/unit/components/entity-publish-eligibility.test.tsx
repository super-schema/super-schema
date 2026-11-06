// @vitest-environment jsdom
import { act, cleanup, renderHook, waitFor } from "@testing-library/react";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { usePublishEligibility } from "@/app/(dashboard)/schemas/[domainSlug]/[productSlug]/[entityId]/components/usePublishEligibility";

const { preview } = vi.hoisted(() => ({ preview: vi.fn() }));
vi.mock("@/app/(dashboard)/schemas/[domainSlug]/[productSlug]/[entityId]/version-actions", () => ({ getPublishPreviewAction: preview }));

const CLEAR = { success: true, preview: { blockers: [] } };
const BLOCKER = { kind: "NO_CHANGES", message: "No unpublished changes." };
const BLOCKED = { success: true, preview: { blockers: [BLOCKER] } };
beforeEach(() => { vi.resetAllMocks(); });
afterEach(cleanup);

describe("publish eligibility", () => {
  it("waits for the server and returns its blockers", async () => {
    let finish!: (response: typeof BLOCKED) => void;
    preview.mockImplementation(() => new Promise((resolve) => { finish = resolve; }));
    const revision = {};
    const { result } = renderHook(() => usePublishEligibility("ent-1", revision, true));
    expect(result.current.checking).toBe(true);
    await act(async () => finish(BLOCKED));
    expect(result.current.checking).toBe(false);
    expect(result.current.blockers).toEqual([BLOCKER]);
  });

  it("invalidates the old answer immediately and ignores a late reply for an older draft", async () => {
    let finishOld!: (response: typeof CLEAR) => void;
    preview.mockImplementationOnce(() => new Promise((resolve) => { finishOld = resolve; })).mockResolvedValueOnce(BLOCKED);
    const { result, rerender } = renderHook(({ revision }) => usePublishEligibility("ent-1", revision, true), { initialProps: { revision: {} } });
    rerender({ revision: {} });
    await waitFor(() => expect(result.current.blockers).toEqual([BLOCKER]));
    await act(async () => finishOld(CLEAR));
    expect(result.current.blockers).toEqual([BLOCKER]);

    preview.mockReturnValueOnce(new Promise(() => {}));
    rerender({ revision: {} });
    expect(result.current.checking).toBe(true);
    expect(result.current.blockers).toEqual([]);
  });

  it("recovers from a failed check when retried", async () => {
    preview.mockRejectedValueOnce(new Error("network down")).mockResolvedValueOnce(CLEAR);
    const revision = {};
    const { result } = renderHook(() => usePublishEligibility("ent-1", revision, true));
    await waitFor(() => expect(result.current.error).toBeTruthy());
    act(() => result.current.retry());
    expect(result.current.checking).toBe(true);
    await waitFor(() => expect(result.current.checking).toBe(false));
    expect(result.current.error).toBeNull();
    expect(result.current.blockers).toEqual([]);
  });

  it("does not request a preview when publishing is unavailable", () => {
    const revision = {};
    const { result } = renderHook(() => usePublishEligibility("ent-1", revision, false));
    expect(preview).not.toHaveBeenCalled();
    expect(result.current.checking).toBe(false);
  });
});
