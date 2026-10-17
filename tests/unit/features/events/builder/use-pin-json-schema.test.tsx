// @vitest-environment jsdom
// `usePinJsonSchema`: the schema of ONE pin, never another's. What the example editors rely on (Review focus: no stale schema).
import { act, cleanup, renderHook, waitFor } from "@testing-library/react";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { resetPinSchemaCache, usePinJsonSchema } from "@/features/events/builder/use-pin-json-schema";
import type { EntityPin } from "@/lib/events/types";

type Schema = Record<string, unknown>;
type Outcome = { success: true; data: { schema: Schema } } | { success: false; error: string; code: string };

const h = vi.hoisted(() => ({ pinJsonSchemaAction: vi.fn() }));
vi.mock("@/app/(dashboard)/schemas/[domainSlug]/[productSlug]/event-actions", () => ({ pinJsonSchemaAction: h.pinJsonSchemaAction }));

const A: Schema = { type: "object", properties: { a: { type: "string" } } };
const B: Schema = { type: "object", properties: { b: { type: "integer" } } };
const ok = (schema: Schema): Outcome => ({ success: true, data: { schema } });
const FAIL: Outcome = { success: false, error: "The schema of this entity could not be generated", code: "ARTIFACT_RENDER_FAILED" };
const pin = (entityId: string, entityVersionId: string | null = `${entityId}-v1`): EntityPin => ({ entityId, entityVersionId });
const deferred = () => {
  let resolve!: (o: Outcome) => void;
  const promise = new Promise<Outcome>((r) => { resolve = r; });
  return { promise, resolve };
};
const settle = () => act(async () => { await new Promise((r) => setTimeout(r, 0)); });

beforeEach(() => {
  vi.clearAllMocks();
  resetPinSchemaCache();
});
afterEach(cleanup);

function hook(initial: { productId?: string; pin: EntityPin | null | undefined; enabled?: boolean }) {
  return renderHook((p: { productId?: string; pin: EntityPin | null | undefined; enabled?: boolean }) => usePinJsonSchema(p.productId ?? "p1", p.pin, p.enabled), { initialProps: initial });
}
const askedFor = (entityId: string) => h.pinJsonSchemaAction.mock.calls.filter(([, p]) => (p as EntityPin).entityId === entityId).length;

describe("usePinJsonSchema", () => {
  it("is null while the schema loads, then the schema; the action gets the product and exactly the pin", async () => {
    const pending = deferred();
    h.pinJsonSchemaAction.mockReturnValue(pending.promise);
    const { result } = hook({ pin: { ...pin("e1"), extra: "ignored" } as EntityPin });
    expect(result.current).toBeNull();
    await settle();
    expect(result.current).toBeNull();
    expect(h.pinJsonSchemaAction).toHaveBeenCalledWith("p1", { entityId: "e1", entityVersionId: "e1-v1" });
    pending.resolve(ok(A));
    await waitFor(() => expect(result.current).toBe(A));
  });

  it("asks nothing while disabled, or for no pin, an unset pin or a pin without an entity", async () => {
    const off = hook({ pin: pin("e1"), enabled: false });
    for (const none of [null, undefined, { entityId: "", entityVersionId: null }]) hook({ pin: none as never });
    await settle();
    expect(off.result.current).toBeNull();
    expect(h.pinJsonSchemaAction).not.toHaveBeenCalled();
    // turned on, it asks
    h.pinJsonSchemaAction.mockResolvedValue(ok(A));
    off.rerender({ pin: pin("e1"), enabled: true });
    await waitFor(() => expect(off.result.current).toBe(A));
    // and turned off again it is null at once
    off.rerender({ pin: pin("e1"), enabled: false });
    expect(off.result.current).toBeNull();
  });

  it("drops the previous pin's schema in the very render that sees the new pin, and shows the new one when it arrives", async () => {
    const next = deferred();
    h.pinJsonSchemaAction.mockImplementation(async (_p: string, p: EntityPin) => (p.entityId === "e1" ? ok(A) : next.promise));
    const { result, rerender } = hook({ pin: pin("e1") });
    await waitFor(() => expect(result.current).toBe(A));
    rerender({ pin: pin("e2") });
    expect(result.current).toBeNull(); // not A, not even for one render
    await settle();
    expect(result.current).toBeNull();
    next.resolve(ok(B));
    await waitFor(() => expect(result.current).toBe(B));
  });

  it("treats another version of the same entity as another pin", async () => {
    h.pinJsonSchemaAction.mockImplementation(async (_p: string, p: EntityPin) => ok(p.entityVersionId === "v2" ? B : A));
    const { result, rerender } = hook({ pin: pin("e1", "v1") });
    await waitFor(() => expect(result.current).toBe(A));
    rerender({ pin: pin("e1", "v2") });
    expect(result.current).toBeNull();
    await waitFor(() => expect(result.current).toBe(B));
  });

  it("ignores an answer that arrives after the pin has changed again", async () => {
    const slow = deferred();
    h.pinJsonSchemaAction.mockImplementation(async (_p: string, p: EntityPin) => (p.entityId === "e2" ? slow.promise : p.entityId === "e3" ? ok(B) : ok(A)));
    const { result, rerender } = hook({ pin: pin("e1") });
    await waitFor(() => expect(result.current).toBe(A));
    rerender({ pin: pin("e2") });
    rerender({ pin: pin("e3") });
    await waitFor(() => expect(result.current).toBe(B));
    slow.resolve(ok(A)); // e2's answer, long after the message moved on
    await settle();
    expect(result.current).toBe(B);
  });

  it("leaves no schema when the load fails, and does not ask again on its own however often it renders", async () => {
    h.pinJsonSchemaAction.mockResolvedValue(FAIL);
    const { result, rerender } = hook({ pin: pin("e1") });
    await settle();
    expect(result.current).toBeNull();
    for (let i = 0; i < 5; i++) rerender({ pin: pin("e1") });
    await settle();
    expect(result.current).toBeNull();
    expect(askedFor("e1")).toBe(1);
  });

  it("counts a rejected action (and a throw while loading it) as a failed load", async () => {
    h.pinJsonSchemaAction.mockRejectedValue(new Error("network down"));
    const { result } = hook({ pin: pin("e1") });
    await settle();
    expect(result.current).toBeNull();
    expect(askedFor("e1")).toBe(1);
  });

  it("a failed load removes the schema the previous pin had", async () => {
    h.pinJsonSchemaAction.mockImplementation(async (_p: string, p: EntityPin) => (p.entityId === "e1" ? ok(A) : FAIL));
    const { result, rerender } = hook({ pin: pin("e1") });
    await waitFor(() => expect(result.current).toBe(A));
    rerender({ pin: pin("e2") });
    await settle();
    expect(result.current).toBeNull();
  });

  it("keeps the schema of a published version for the session, per product, without asking again", async () => {
    h.pinJsonSchemaAction.mockResolvedValue(ok(A));
    const first = hook({ pin: pin("e1") });
    await waitFor(() => expect(first.result.current).toBe(A));
    first.unmount();
    const again = hook({ pin: pin("e1") });
    expect(again.result.current).toBe(A); // at once, from the first render
    await settle();
    expect(askedFor("e1")).toBe(1);
    // another product is another tenant's view: asked for itself
    const other = hook({ productId: "p2", pin: pin("e1") });
    expect(other.result.current).toBeNull();
    await waitFor(() => expect(other.result.current).toBe(A));
    expect(askedFor("e1")).toBe(2);
  });

  it("does not keep a failure, nor the schema of an unpinned (draft) entity: each asks again when it is needed", async () => {
    h.pinJsonSchemaAction.mockResolvedValueOnce(FAIL).mockResolvedValue(ok(A));
    const failed = hook({ pin: pin("e1") });
    await settle();
    failed.unmount();
    const retried = hook({ pin: pin("e1") });
    await waitFor(() => expect(retried.result.current).toBe(A));
    expect(askedFor("e1")).toBe(2);

    const draft = hook({ pin: pin("e9", null) });
    await waitFor(() => expect(draft.result.current).toBe(A));
    draft.unmount();
    const draftAgain = hook({ pin: pin("e9", null) });
    expect(draftAgain.result.current).toBeNull();
    await waitFor(() => expect(draftAgain.result.current).toBe(A));
    expect(askedFor("e9")).toBe(2);
    expect(h.pinJsonSchemaAction).toHaveBeenCalledWith("p1", { entityId: "e9", entityVersionId: null });
  });

  it("keeps at most a couple of dozen version schemas (the oldest go first)", async () => {
    h.pinJsonSchemaAction.mockResolvedValue(ok(A));
    for (let i = 0; i < 30; i++) {
      const view = hook({ pin: pin(`bulk${i}`) });
      await waitFor(() => expect(view.result.current).toBe(A));
      view.unmount();
    }
    const newest = hook({ pin: pin("bulk29") });
    expect(newest.result.current).toBe(A); // still kept
    const oldest = hook({ pin: pin("bulk0") });
    expect(oldest.result.current).toBeNull(); // evicted: asked for again
    await waitFor(() => expect(oldest.result.current).toBe(A));
    expect(askedFor("bulk0")).toBe(2);
  });
});
