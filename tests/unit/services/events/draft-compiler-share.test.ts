// @vitest-environment node
/**
 * The event renders take units of the caller's compiler share (src/lib/emission/emission-admission.ts), one per render a draft emission (the REST route's
 * `version=draft`, the dashboard's draft and preview) starts, and one for a pinned JSON Schema. A caller over its share is refused at once and renders nothing;
 * another caller is admitted meanwhile; a settled call, a failed one included, gives its unit back. The database is stood in for: the snapshot
 * loader and the ownership check are replaced, so the services run their own admission code and nothing else.
 */
import { beforeEach, describe, expect, it, vi } from "vitest";
import { admitCompilerRuns, RUNS_PER_PRINCIPAL } from "@/lib/emission/emission-admission";
import { emptyEventDocument } from "@/lib/events/document/types";
import { err, ok } from "@/types/result";
import type { ServiceContext } from "@/types/service-context";
import type { ArtifactRenderer, RenderedArtifact } from "@/services/events/artifact-renderer";
import { PAYMENTS_RENDERS, paymentsDocument, snapshotOf } from "../../../helpers/event-snapshot";

const h = vi.hoisted(() => ({ loadEventSnapshot: vi.fn(), resolveEventSnapshot: vi.fn() }));
vi.mock("@/services/events/event-snapshot", async (importOriginal) => ({
  ...(await importOriginal<typeof import("@/services/events/event-snapshot")>()),
  loadEventSnapshot: h.loadEventSnapshot,
  resolveEventSnapshot: h.resolveEventSnapshot,
}));
vi.mock("@/services/events/service-guards", async (importOriginal) => ({
  ...(await importOriginal<typeof import("@/services/events/service-guards")>()),
  assertOwnedEvent: async () => ok(undefined),
}));

import { emitEventDraft } from "@/services/events/event-emit.service";
import { renderPinJsonSchema } from "@/services/events/pin-json-schema.service";

const FILLER = "share-filler";
const OTHER = "share-other";
const ctxOf = (userId: string) => ({ userId, userRole: "AUTHOR", assignments: [], prisma: {} }) as unknown as ServiceContext;
const rendered: RenderedArtifact = { artifact: { format: "json-schema", dialect: "2020-12", schema: {} }, warnings: [] };
const renderer: ArtifactRenderer = { render: vi.fn(async () => ok(rendered)) };

beforeEach(() => {
  vi.clearAllMocks();
  h.loadEventSnapshot.mockResolvedValue(ok(snapshotOf(emptyEventDocument("share"))));
  h.resolveEventSnapshot.mockResolvedValue({ resolved: null, diagnostics: [] });
});

describe("draft emissions under the caller's compiler share", () => {
  it("refuses a caller over its share at once, renders nothing, and admits another caller meanwhile", async () => {
    const hold = admitCompilerRuns(FILLER, RUNS_PER_PRINCIPAL)!;
    try {
      const refused = await emitEventDraft("e1", "p1", ctxOf(FILLER), { renderer });
      expect(refused).toMatchObject({ success: false, error: { code: "RATE_LIMITED" } });
      expect(h.resolveEventSnapshot).not.toHaveBeenCalled();

      const admitted = await emitEventDraft("e1", "p1", ctxOf(OTHER), { renderer });
      expect(admitted.success).toBe(true);
      expect(h.resolveEventSnapshot).toHaveBeenCalledTimes(1);
    } finally {
      hold();
    }
  });

  it("gives the unit back when the emission settles, and also when its render throws", async () => {
    h.resolveEventSnapshot.mockResolvedValueOnce({ resolved: null, diagnostics: [] });
    expect((await emitEventDraft("e1", "p1", ctxOf(FILLER), { renderer })).success).toBe(true);
    h.resolveEventSnapshot.mockRejectedValueOnce(new Error("render exploded"));
    await emitEventDraft("e1", "p1", ctxOf(FILLER), { renderer }).catch(() => undefined);

    const everything = admitCompilerRuns(FILLER, RUNS_PER_PRINCIPAL);
    expect(everything).not.toBeNull();
    everything?.();
  });

  it("charges one unit per render: a draft that needs more renders than the caller's free units is refused at once", async () => {
    h.loadEventSnapshot.mockResolvedValue(ok(snapshotOf(paymentsDocument())));
    const hold = admitCompilerRuns(FILLER, RUNS_PER_PRINCIPAL - PAYMENTS_RENDERS + 1)!;
    try {
      expect(await emitEventDraft("e1", "p1", ctxOf(FILLER), { renderer })).toMatchObject({ success: false, error: { code: "RATE_LIMITED" } });
      expect(h.resolveEventSnapshot).not.toHaveBeenCalled();
    } finally {
      hold();
    }
    const fits = admitCompilerRuns(FILLER, RUNS_PER_PRINCIPAL - PAYMENTS_RENDERS)!;
    try {
      expect((await emitEventDraft("e1", "p1", ctxOf(FILLER), { renderer })).success).toBe(true);
      expect(h.resolveEventSnapshot).toHaveBeenCalledTimes(1);
    } finally {
      fits();
    }
  });

  it("answers a busy compiler EMITTER_BUSY, a retry, not a draft with errors", async () => {
    h.resolveEventSnapshot.mockResolvedValueOnce({ resolved: null, diagnostics: [], busy: true });
    expect(await emitEventDraft("e1", "p1", ctxOf(OTHER), { renderer })).toMatchObject({ success: false, error: { code: "EMITTER_BUSY" } });
  });

  it("hands the caller's signal to the render, so a client that went away cancels the draft's compiler runs", async () => {
    const controller = new AbortController();
    await emitEventDraft("e1", "p1", ctxOf(OTHER), { renderer, signal: controller.signal });
    expect(h.resolveEventSnapshot).toHaveBeenCalledWith(expect.anything(), renderer, "draft", undefined, { signal: controller.signal });
  });
});

describe("a pinned JSON Schema under the caller's compiler share", () => {
  const prisma = { entity: { findFirst: async () => ({ id: "e1" }) } } as unknown as ServiceContext["prisma"];
  const input = { tenantId: "t1", pin: { entityId: "e1", entityVersionId: null } };

  it("is refused at once while the caller's share is in use: nothing is rendered", async () => {
    const hold = admitCompilerRuns(FILLER, RUNS_PER_PRINCIPAL)!;
    try {
      const refused = await renderPinJsonSchema({ ...ctxOf(FILLER), prisma }, input, { renderer });
      expect(refused).toMatchObject({ success: false, error: { code: "RATE_LIMITED" } });
      expect(renderer.render).not.toHaveBeenCalled();
    } finally {
      hold();
    }
  });

  it("answers a busy compiler EMITTER_BUSY, not a render failure", async () => {
    const busy: ArtifactRenderer = { render: vi.fn(async () => err({ code: "EMITTER_BUSY", message: "The TypeSpec compiler is busy." })) };
    expect(await renderPinJsonSchema({ ...ctxOf(OTHER), prisma }, input, { renderer: busy })).toMatchObject({ success: false, error: { code: "EMITTER_BUSY" } });
  });
});
