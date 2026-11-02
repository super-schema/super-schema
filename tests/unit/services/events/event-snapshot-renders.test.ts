// @vitest-environment node
/**
 * A resolve of an event starts one render per planned artifact, and the caller's compiler share is charged by that count (`eventRenderShare`), so
 * the share is in step with the work. A render refused as busy makes the whole resolve busy (no document with errors): the caller answers "try again".
 */
import { describe, expect, it, vi } from "vitest";
import { emptyEventDocument } from "@/lib/events/document/types";
import { RUNS_PER_PRINCIPAL } from "@/lib/emission/emission-admission";
import type { ArtifactRenderer, RenderedArtifact } from "@/services/events/artifact-renderer";
import { countEventRenders, eventRenderShare, resolveEventSnapshot } from "@/services/events/event-snapshot";
import { err, ok } from "@/types/result";
import { PAYMENTS_RENDERS, paymentsDocument, snapshotOf } from "../../../helpers/event-snapshot";

const avro: RenderedArtifact = { artifact: { format: "avro", schema: { type: "record", name: "Order", fields: [] } }, warnings: [] };

describe("the renders of an event resolve", () => {
  it("are counted as the resolve starts them: payload and key of each message, the headers pin of a trait", async () => {
    const snapshot = snapshotOf(paymentsDocument());
    expect(countEventRenders(snapshot)).toBe(PAYMENTS_RENDERS);

    const render = vi.fn<ArtifactRenderer["render"]>(async () => ok(avro));
    await resolveEventSnapshot(snapshot, { render }, "draft");
    expect(render).toHaveBeenCalledTimes(PAYMENTS_RENDERS);
  });

  it("charge one unit each, at least one and never more than the whole share", () => {
    expect(eventRenderShare(snapshotOf(emptyEventDocument("no renders")))).toBe(1);
    expect(eventRenderShare(snapshotOf(paymentsDocument()))).toBe(PAYMENTS_RENDERS);

    const many = paymentsDocument();
    const keys = Array.from({ length: RUNS_PER_PRINCIPAL + 4 }, (_, i) => `Event${i}`);
    many.channels[0].messageKeys = keys;
    many.operations[0].messageKeys = keys;
    many.messages = keys.map((key) => ({ key, contentType: "avro/binary", payload: { entityId: "e1", entityVersionId: "v1" }, traitKeys: [] }));
    many.traits = [];
    expect(countEventRenders(snapshotOf(many))).toBe(RUNS_PER_PRINCIPAL + 4);
    expect(eventRenderShare(snapshotOf(many))).toBe(RUNS_PER_PRINCIPAL);
  });

  it("make the resolve busy, with no diagnostic, when a render is refused as busy", async () => {
    const render = vi.fn<ArtifactRenderer["render"]>(async () => err({ code: "EMITTER_BUSY", message: "The TypeSpec compiler is busy." }));
    const result = await resolveEventSnapshot(snapshotOf(paymentsDocument()), { render }, "draft");
    expect(result).toEqual({ resolved: null, diagnostics: [], busy: true });
  });
});
