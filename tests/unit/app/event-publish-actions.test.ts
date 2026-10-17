import { describe, it, expect, vi, beforeEach, afterEach } from "vitest";

const h = vi.hoisted(() => ({
  auth: vi.fn(), revalidatePath: vi.fn(), resolveCurrentUserId: vi.fn(), withOwnedTarget: vi.fn(),
  previewEventPublish: vi.fn(), publishEvent: vi.fn(), listEventVersions: vi.fn(), emitEventStoredVersion: vi.fn(),
}));
// The real parent check (the client-supplied product must lie in the active tenant) is covered by
// tests/unit/app/events-actions-tenant-guard.test.ts; here it is a spy that lets every parent through unless a test says otherwise.
vi.mock("@/lib/action-context", async (importOriginal) => ({
  ...(await importOriginal<typeof import("@/lib/action-context")>()),
  withOwnedTarget: h.withOwnedTarget,
}));
vi.mock("@/lib/db", () => ({ prisma: { tag: "prisma" } }));
vi.mock("@/lib/auth", () => ({ auth: h.auth }));
vi.mock("@/lib/current-user", () => ({ resolveCurrentUserId: h.resolveCurrentUserId }));
vi.mock("next/cache", () => ({ revalidatePath: h.revalidatePath }));
vi.mock("@/services/rbac.service", () => ({ getEffectiveRole: vi.fn().mockResolvedValue({ success: true, data: "VIEWER" }) }));
vi.mock("@/services/events/event.service", () => ({
  createEvent: vi.fn(), updateEventDocument: vi.fn(), renameEvent: vi.fn(), deleteEvent: vi.fn(),
}));
vi.mock("@/services/events/event-emit.service", () => ({
  emitEventDraft: vi.fn(), emitEventDocumentPreview: vi.fn(), emitEventStoredVersion: h.emitEventStoredVersion,
}));
vi.mock("@/services/events/event-publish.service", () => ({
  previewEventPublish: h.previewEventPublish, publishEvent: h.publishEvent, listEventVersions: h.listEventVersions,
}));

import {
  listEventVersionsAction, previewEventPublishAction, publishEventAction, readEventVersionAction,
} from "@/app/(dashboard)/schemas/[domainSlug]/[productSlug]/event-actions";
import { GENERIC_ACTION_ERROR } from "@/types/action-result";

const CTX = { userId: "u1", userRole: "VIEWER", prisma: { tag: "prisma" } };
const OWNER = { level: "PRODUCT", productId: "p1" };
const ANALYSIS = {
  isFirstPublish: false, latestLabel: "1.0", suggestedBump: "MINOR", candidateLabels: { MAJOR: "2.0", MINOR: "1.1" },
  initialLabel: "1.0", reasons: [], blockers: [{ kind: "UNPUBLISHED_PIN", message: "Order has no published version pinned", pointer: "/messages/0/payload" }],
};
const SUMMARY = {
  id: "v1", major: 1, minor: 1, label: "1.1", sequence: 2, changeKind: "MINOR", changeSummary: "More", publishedByName: "Ada", publishedAt: "2026-10-16T10:00:00.000Z",
};
const STORED = { document: { asyncapi: "3.0.0" }, json: '{"asyncapi":"3.0.0"}', yaml: "asyncapi: 3.0.0\n", diagnostics: [{ severity: "warning", code: "X", message: "m" }] };
const INPUT = { bump: "MINOR" as const, changeSummary: "More" };

const SERVICE_MOCKS = [h.previewEventPublish, h.publishEvent, h.listEventVersions, h.emitEventStoredVersion];
const ALL_ACTIONS: Array<[string, () => Promise<unknown>]> = [
  ["previewEventPublishAction", () => previewEventPublishAction("e1", "p1")],
  ["publishEventAction", () => publishEventAction("e1", "p1", INPUT)],
  ["listEventVersionsAction", () => listEventVersionsAction("e1", "p1")],
  ["readEventVersionAction", () => readEventVersionAction("e1", "p1", "1.1")],
];

beforeEach(() => {
  vi.clearAllMocks();
  h.auth.mockResolvedValue({ user: { id: "u1" } });
  h.resolveCurrentUserId.mockResolvedValue("u1");
  h.withOwnedTarget.mockImplementation(async (_target: unknown, run: () => Promise<unknown>) => run());
  h.previewEventPublish.mockResolvedValue({ success: true, data: ANALYSIS });
  h.publishEvent.mockResolvedValue({ success: true, data: SUMMARY });
  h.listEventVersions.mockResolvedValue({ success: true, data: [SUMMARY] });
  h.emitEventStoredVersion.mockResolvedValue({ success: true, data: STORED });
});

describe("event publish actions: what each one hands the service", () => {
  it("previewEventPublishAction: event id, product id and the context; the analysis comes back as is", async () => {
    expect(await previewEventPublishAction("e1", "p1")).toEqual({ success: true, data: ANALYSIS });
    expect(h.previewEventPublish).toHaveBeenCalledWith("e1", "p1", CTX);
  });

  it("publishEventAction: event id, product id, the client's input untouched and the context; the version summary comes back", async () => {
    expect(await publishEventAction("e1", "p1", INPUT)).toEqual({ success: true, data: SUMMARY });
    expect(h.publishEvent).toHaveBeenCalledWith("e1", "p1", INPUT, CTX);
  });

  it("listEventVersionsAction: event id, product id and the context", async () => {
    expect(await listEventVersionsAction("e1", "p1")).toEqual({ success: true, data: [SUMMARY] });
    expect(h.listEventVersions).toHaveBeenCalledWith("e1", "p1", CTX);
  });

  it("readEventVersionAction: reads the STORED version and returns only its YAML and JSON (no document, no diagnostics)", async () => {
    expect(await readEventVersionAction("e1", "p1", "1.1")).toEqual({ success: true, data: { yaml: STORED.yaml, json: STORED.json } });
    expect(h.emitEventStoredVersion).toHaveBeenCalledWith("e1", "p1", "1.1", CTX);
  });

  it("readEventVersionAction passes a failed read on (an unknown version is the service's NOT_FOUND)", async () => {
    h.emitEventStoredVersion.mockResolvedValue({ success: false, error: { code: "NOT_FOUND", message: 'Version 9.9 of event "e1" not found', suggestedFix: "List the published versions and pick one." } });
    expect(await readEventVersionAction("e1", "p1", "9.9")).toEqual({
      success: false, error: 'Version 9.9 of event "e1" not found', code: "NOT_FOUND", suggestedFix: "List the published versions and pick one.",
    });
  });
});

describe("event publish actions: guards", () => {
  it("check the client-supplied product against the active tenant before every service call", async () => {
    for (const [, call] of ALL_ACTIONS) {
      h.withOwnedTarget.mockClear();
      await call();
      expect(h.withOwnedTarget).toHaveBeenCalledTimes(1);
      expect(h.withOwnedTarget.mock.calls[0][0]).toEqual(OWNER);
    }
  });

  it("never reach a service when the product is not in the active tenant (the NOT_FOUND of an unknown one)", async () => {
    h.withOwnedTarget.mockResolvedValue({ success: false, error: { code: "NOT_FOUND", message: 'Product "p1" not found' } });
    for (const [, call] of ALL_ACTIONS) expect(await call()).toEqual({ success: false, error: 'Product "p1" not found', code: "NOT_FOUND" });
    for (const fn of SERVICE_MOCKS) expect(fn).not.toHaveBeenCalled();
  });

  it("answer UNAUTHORIZED without any ownership check or service call when there is no session", async () => {
    h.auth.mockResolvedValue(null);
    for (const [, call] of ALL_ACTIONS) expect(await call()).toMatchObject({ success: false, code: "UNAUTHORIZED" });
    for (const fn of [...SERVICE_MOCKS, h.withOwnedTarget]) expect(fn).not.toHaveBeenCalled();
  });

  it("revalidate /schemas on a successful publish only; the three reads never revalidate", async () => {
    await previewEventPublishAction("e1", "p1");
    await listEventVersionsAction("e1", "p1");
    await readEventVersionAction("e1", "p1", "1.1");
    expect(h.revalidatePath).not.toHaveBeenCalled();

    await publishEventAction("e1", "p1", INPUT);
    expect(h.revalidatePath).toHaveBeenCalledTimes(1);
    expect(h.revalidatePath).toHaveBeenCalledWith("/schemas", "layout");

    h.revalidatePath.mockClear();
    h.publishEvent.mockResolvedValue({ success: false, error: { code: "CONFLICT", message: "The event changed while publishing." } });
    await publishEventAction("e1", "p1", INPUT);
    expect(h.revalidatePath).not.toHaveBeenCalled();
  });
});

describe("event publish actions: failures reach the browser safely", () => {
  it("publishEventAction hands the blockers of PUBLISH_BLOCKED and a retryable CONFLICT over with their codes", async () => {
    const blockers = ANALYSIS.blockers;
    h.publishEvent.mockResolvedValue({ success: false, error: { code: "PUBLISH_BLOCKED", message: "Order has no published version pinned", details: { blockers }, suggestedFix: "Resolve every blocker, then publish again." } });
    expect(await publishEventAction("e1", "p1", INPUT)).toEqual({
      success: false, error: "Order has no published version pinned", code: "PUBLISH_BLOCKED", details: { blockers }, suggestedFix: "Resolve every blocker, then publish again.",
    });
    h.publishEvent.mockResolvedValue({ success: false, error: { code: "CONFLICT", message: "The event changed while publishing.", suggestedFix: "Reload the event and publish again." } });
    expect(await publishEventAction("e1", "p1", INPUT)).toMatchObject({ success: false, code: "CONFLICT" });
  });

  it("passes a FORBIDDEN refusal through untouched (labelled by id, never by name)", async () => {
    for (const fn of SERVICE_MOCKS) fn.mockResolvedValue({ success: false, error: { code: "FORBIDDEN", message: 'Event "e1" does not belong to this product' } });
    for (const [, call] of ALL_ACTIONS) expect(await call()).toEqual({ success: false, error: 'Event "e1" does not belong to this product', code: "FORBIDDEN" });
  });

  describe("raw database text and thrown errors never reach the browser", () => {
    const RAW = 'Invalid `prisma.eventSpecVersion.create()` invocation: relation "event_spec_versions" does not exist at 10.0.0.5:5432';
    let consoleError: ReturnType<typeof vi.spyOn>;
    beforeEach(() => { consoleError = vi.spyOn(console, "error").mockImplementation(() => undefined); });
    afterEach(() => consoleError.mockRestore());

    it("replaces a DB_ERROR message with the generic one", async () => {
      for (const fn of SERVICE_MOCKS) fn.mockResolvedValue({ success: false, error: { code: "DB_ERROR", message: RAW } });
      for (const [, call] of ALL_ACTIONS) {
        const result = await call();
        expect(result).toEqual({ success: false, error: GENERIC_ACTION_ERROR, code: "DB_ERROR" });
        expect(JSON.stringify(result)).not.toContain("10.0.0.5");
      }
    });

    it("answers a rejected service with a generic INTERNAL_ERROR", async () => {
      for (const fn of SERVICE_MOCKS) fn.mockRejectedValue(new Error(RAW));
      for (const [, call] of ALL_ACTIONS) {
        const result = await call();
        expect(result).toEqual({ success: false, error: GENERIC_ACTION_ERROR, code: "INTERNAL_ERROR" });
        expect(JSON.stringify(result)).not.toContain("10.0.0.5");
      }
    });
  });
});
