// @vitest-environment jsdom
// The Versions tab's two reads. In development React Strict Mode runs the effect, cleans it up and runs it again, and the server action
// called by the second run can stay queued behind the first one: the answer of the FIRST call was thrown away because the effect that
// asked for it had been cleaned up, and the tab showed "Loading v1.0…" forever. (Strict Mode does not double-run effects under vitest,
// so these tests make the same thing happen explicitly: the arguments change away and back while the first call is pending, so its
// effect is cleaned up, and the later calls never return.) An answer is shown when it is for what the hook wants NOW, and dropped when
// the arguments have since changed.
import { act, cleanup, renderHook, waitFor } from "@testing-library/react";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";

const h = vi.hoisted(() => ({ list: vi.fn(), read: vi.fn() }));
vi.mock("@/app/(dashboard)/schemas/[domainSlug]/[productSlug]/event-actions", () => ({
  listEventVersionsAction: h.list,
  readEventVersionAction: h.read,
}));

import { useEventVersionCode, useEventVersions } from "@/features/events/event-page/use-event-versions";
import { GENERIC_ACTION_ERROR } from "@/types/action-result";

const forever = () => new Promise<never>(() => undefined);
const code = (marker: string) => ({ success: true as const, data: { yaml: `# ${marker}\n`, json: `{"v":"${marker}"}\n` } });
const versions = (...sequences: number[]) => ({
  success: true as const,
  data: sequences.map((sequence) => ({ sequence, label: `1.${sequence}` })) as never,
});

beforeEach(() => {
  h.list.mockReset();
  h.read.mockReset();
});
afterEach(cleanup);

describe("useEventVersionCode", () => {
  it("shows the answer of a call whose effect was cleaned up, when it is for the label wanted now and the later calls never return", async () => {
    let answerFirst!: (v: ReturnType<typeof code>) => void;
    h.read
      .mockImplementationOnce(() => new Promise((resolve) => { answerFirst = resolve; }))
      .mockImplementation(forever);

    const { result, rerender } = renderHook(({ label }) => useEventVersionCode({ eventId: "e1", productId: "p1", label }), {
      initialProps: { label: "1.0" as string | null },
    });
    rerender({ label: "1.1" }); // the first call's effect is cleaned up while it is pending
    rerender({ label: "1.0" }); // ... and 1.0 is wanted again; this second call for 1.0 never returns
    expect(result.current.status).toBe("loading");

    await act(async () => { answerFirst(code("one")); });

    await waitFor(() => expect(result.current).toMatchObject({ status: "ready", yaml: "# one\n" }));
  });

  it("drops an answer for a label that is no longer selected, and shows the answer for the one that is", async () => {
    let resolveOld!: (v: ReturnType<typeof code>) => void;
    h.read.mockImplementation((_eventId: string, _productId: string, label: string) =>
      label === "1.0" ? new Promise((resolve) => { resolveOld = resolve; }) : Promise.resolve(code("new")));

    const { result, rerender } = renderHook(({ label }) => useEventVersionCode({ eventId: "e1", productId: "p1", label }), {
      initialProps: { label: "1.0" as string | null },
    });
    expect(result.current.status).toBe("loading");

    rerender({ label: "1.1" });
    await waitFor(() => expect(result.current).toMatchObject({ status: "ready", yaml: "# new\n" }));

    await act(async () => { resolveOld(code("old")); });
    expect(result.current).toMatchObject({ status: "ready", yaml: "# new\n" });
  });

  it("is idle without a label, and a refused read is an error that retry() asks again", async () => {
    h.read.mockResolvedValueOnce({ success: false as const, error: "No such version.", code: "NOT_FOUND" }).mockResolvedValue(code("again"));

    const idle = renderHook(() => useEventVersionCode({ eventId: "e1", productId: "p1", label: null }));
    expect(idle.result.current.status).toBe("idle");
    expect(h.read).not.toHaveBeenCalled();

    const { result } = renderHook(() => useEventVersionCode({ eventId: "e1", productId: "p1", label: "9.9" }));
    await waitFor(() => expect(result.current.status).toBe("error"));
    expect(result.current).toMatchObject({ status: "error", message: expect.stringContaining("No such version.") });

    act(() => result.current.retry());
    await waitFor(() => expect(result.current).toMatchObject({ status: "ready", yaml: "# again\n" }));
  });

  it("turns a rejected server action into the generic message, never the cause", async () => {
    h.read.mockRejectedValue(new Error("connect ECONNRESET 10.0.0.1:5432"));

    const { result } = renderHook(() => useEventVersionCode({ eventId: "e1", productId: "p1", label: "1.0" }));

    await waitFor(() => expect(result.current.status).toBe("error"));
    expect(result.current).toMatchObject({ status: "error", message: GENERIC_ACTION_ERROR });
  });
});

describe("useEventVersions", () => {
  it("shows the answer of a call whose effect was cleaned up, when it is for the label wanted now and the later calls never return", async () => {
    let answerFirst!: (v: ReturnType<typeof versions>) => void;
    h.list
      .mockImplementationOnce(() => new Promise((resolve) => { answerFirst = resolve; }))
      .mockImplementation(forever);

    const { result, rerender } = renderHook(({ latest }) => useEventVersions({ eventId: "e1", productId: "p1", latestLabel: latest }), {
      initialProps: { latest: "1.2" },
    });
    rerender({ latest: "1.3" });
    rerender({ latest: "1.2" });
    expect(result.current.versions).toBeNull();

    await act(async () => { answerFirst(versions(1, 2)); });

    await waitFor(() => expect(result.current.versions?.map((v) => v.sequence)).toEqual([2, 1]));
    expect(result.current.error).toBeNull();
  });

  it("asks again when the header's latest label changes (a publish), and reload() asks again", async () => {
    h.list.mockResolvedValueOnce(versions(1)).mockResolvedValueOnce(versions(1, 2)).mockResolvedValue(versions(1, 2, 3));

    const { result, rerender } = renderHook(({ latest }) => useEventVersions({ eventId: "e1", productId: "p1", latestLabel: latest }), {
      initialProps: { latest: "1.1" },
    });
    await waitFor(() => expect(result.current.versions?.length).toBe(1));

    rerender({ latest: "1.2" });
    await waitFor(() => expect(result.current.versions?.length).toBe(2));

    act(() => result.current.reload());
    await waitFor(() => expect(result.current.versions?.length).toBe(3));
  });
});
