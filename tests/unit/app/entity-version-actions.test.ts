import { describe, it, expect, vi, beforeEach } from "vitest";
import { assign, principalOf } from "../../helpers/access-mocks";

const h = vi.hoisted(() => ({
  auth: vi.fn(),
  previewPublish: vi.fn(),
  publishEntity: vi.fn(),
  listEntityVersions: vi.fn(),
  revalidatePath: vi.fn(),
  guardSubject: vi.fn(),
}));

vi.mock("@/lib/db", () => ({ prisma: { tag: "prisma" } }));
// The guard in front of every action (the real one is tested in tests/unit/app/entity-area-access.test.ts): here it lets a global administrator through.
vi.mock("@/lib/action-context", async (importOriginal) => ({
  ...(await importOriginal<typeof import("@/lib/action-context")>()),
  guardSubject: h.guardSubject,
}));
vi.mock("@/lib/access/principal", async () => (await import("../../helpers/access-mocks")).sessionPrincipalModule);
vi.mock("@/lib/auth", () => ({ auth: h.auth }));
vi.mock("next/cache", () => ({ revalidatePath: h.revalidatePath }));
vi.mock("@/services/entity-version.service", () => ({
  previewPublish: h.previewPublish,
  publishEntity: h.publishEntity,
  listEntityVersions: h.listEntityVersions,
}));

import {
  getPublishPreviewAction,
  publishEntityAction,
  listEntityVersionsAction,
} from "@/app/(dashboard)/schemas/[domainSlug]/[productSlug]/[entityId]/version-actions";

const SUMMARY = {
  id: "v1", entityId: "e1", major: 1, minor: 0, label: "1.0", sequence: 1, changeKind: "INITIAL",
  changeSummary: null, publishedById: "user-1", publishedByName: "Ada", publishedAt: "2026-10-14T00:00:00.000Z",
};

const ADMIN = principalOf([assign.global()], { userId: "user-1" });
const ALLOWED = { allowed: true as const, principal: ADMIN, resource: { tenantId: "t1" } };

beforeEach(() => {
  vi.clearAllMocks();
  h.auth.mockResolvedValue({ user: { id: "user-1" } });
  h.guardSubject.mockResolvedValue(ALLOWED);
});

describe("entity version actions", () => {
  it("rejects unauthenticated calls without touching the service", async () => {
    h.guardSubject.mockResolvedValue({ allowed: false, refusal: { error: "Not authenticated", code: "UNAUTHORIZED" } });
    expect(await publishEntityAction("e1", {})).toEqual({ error: "Not authenticated", code: "UNAUTHORIZED" });
    expect(await getPublishPreviewAction("e1")).toEqual({ error: "Not authenticated", code: "UNAUTHORIZED" });
    expect(await listEntityVersionsAction("e1")).toEqual({ error: "Not authenticated", code: "UNAUTHORIZED" });
    expect(h.publishEntity).not.toHaveBeenCalled();
  });

  it("rejects a bump other than MAJOR or MINOR", async () => {
    expect(await publishEntityAction("e1", { bump: "PATCH" as never })).toEqual({
      error: "bump must be MAJOR or MINOR",
      code: "VALIDATION_ERROR",
    });
    expect(h.publishEntity).not.toHaveBeenCalled();
  });

  it("publishes with the caller's context and revalidates", async () => {
    h.publishEntity.mockResolvedValue({ success: true, data: SUMMARY });
    expect(await publishEntityAction("e1", { bump: "MAJOR", changeSummary: "x" })).toEqual({ success: true, version: SUMMARY });
    expect(h.publishEntity).toHaveBeenCalledWith(
      "e1",
      { bump: "MAJOR", changeSummary: "x" },
      { userId: "user-1", userRole: "ADMIN", assignments: ADMIN.assignments, prisma: { tag: "prisma" } }
    );
    // The action asked for the right power over the right entity: publishing is `entity.publish`.
    expect(h.guardSubject).toHaveBeenCalledWith("entity.publish", { kind: "entity", id: "e1" }, { label: "Entity" });
    expect(h.revalidatePath).toHaveBeenCalledWith("/schemas");
  });

  it("returns the service error with its code", async () => {
    h.publishEntity.mockResolvedValue({ success: false, error: { code: "PUBLISH_BLOCKED", message: "Publish Customer first" } });
    expect(await publishEntityAction("e1", {})).toEqual({ error: "Publish Customer first", code: "PUBLISH_BLOCKED" });
    expect(h.revalidatePath).not.toHaveBeenCalled();
  });

  it("answers an ambiguous reference with the pick the UI needs (needsReference, generateSchemaAction's shape) beside the error", async () => {
    const pick = {
      field: "addr",
      name: "Address",
      candidates: [
        { entityId: "x1", domain: "d1", product: "p1", entity: "Address" },
        { entityId: "x2", domain: "d2", product: "p2", entity: "Address" },
      ],
      entityId: "e1",
      fieldId: "e1.addr",
    };
    h.publishEntity.mockResolvedValue({
      success: false,
      error: {
        code: "PUBLISH_BLOCKED",
        message: 'Field "addr" refers to "Address", which matches 2 entities',
        details: { blockers: [{ kind: "CLOSURE_BLOCKED", code: "AMBIGUOUS_REFERENCE", message: "m", details: pick }] },
      },
    });
    expect(await publishEntityAction("e1", {})).toEqual({
      error: 'Field "addr" refers to "Address", which matches 2 entities',
      code: "PUBLISH_BLOCKED",
      needsReference: pick,
    });
  });

  it("a blocked publish without an ambiguous reference carries no needsReference", async () => {
    h.publishEntity.mockResolvedValue({
      success: false,
      error: { code: "PUBLISH_BLOCKED", message: "Publish Customer first", details: { blockers: [{ kind: "UNPUBLISHED_REFERENCE", entityId: "c", entityName: "Customer", message: "Publish Customer first" }] } },
    });
    const result = await publishEntityAction("e1", {});
    expect(result).toEqual({ error: "Publish Customer first", code: "PUBLISH_BLOCKED" });
    expect(result).not.toHaveProperty("needsReference");
  });

  it("passes preview and version list through", async () => {
    h.previewPublish.mockResolvedValue({ success: true, data: { isFirstPublish: true } });
    h.listEntityVersions.mockResolvedValue({ success: true, data: [SUMMARY] });
    expect(await getPublishPreviewAction("e1")).toEqual({ success: true, preview: { isFirstPublish: true } });
    expect(await listEntityVersionsAction("e1")).toEqual({ success: true, versions: [SUMMARY] });
    expect(h.guardSubject).toHaveBeenCalledWith("entity.read", { kind: "entity", id: "e1" }, { label: "Entity" });
  });
});
