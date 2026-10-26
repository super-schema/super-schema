import { describe, it, expect, vi, beforeEach } from "vitest";

vi.mock("@/lib/db", () => ({
  prisma: {
    auditLog: {
      create: vi.fn().mockResolvedValue({
        id: "ann-1",
        action: "annotation.create",
        entityType: "Annotation",
        entityId: "ent-1",
        userId: "user-1",
        timestamp: new Date("2026-04-01T10:00:00Z"),
        beforeState: null,
        afterState: {
          entityId: "ent-1",
          fieldId: null,
          content: "Test annotation",
          taggedUserIds: [],
          resolved: false,
        },
      }),
      findUnique: vi.fn(),
      findMany: vi.fn(),
    },
    entity: { findUnique: vi.fn() },
    field: { findUnique: vi.fn() },
    user: {
      findMany: vi.fn(),
    },
  },
}));

import {
  createAnnotation,
  getAnnotations,
  resolveAnnotation,
  extractMentionedUserIds,
  searchUsers,
} from "@/services/annotation.service";
import { prisma } from "@/lib/db";
import type { ServiceContext } from "@/types/service-context";
import { assign } from "../../helpers/access-mocks";

const mockCtx: ServiceContext = {
  userId: "user-1",
  userRole: "AUTHOR",
  assignments: [assign.tenant("AUTHOR", "tenant-1")],
  prisma: prisma as unknown as ServiceContext["prisma"],
};

const adminCtx: ServiceContext = {
  userId: "admin-1",
  userRole: "ADMIN",
  assignments: [assign.tenant("ADMIN", "tenant-1")],
  prisma: prisma as unknown as ServiceContext["prisma"],
};

describe("Annotation Service", () => {
  beforeEach(() => {
    vi.clearAllMocks();
    // The entity the annotations of these tests are on, in tenant-1 (the administrator's tenant).
    vi.mocked(prisma.entity.findUnique).mockResolvedValue({ tenantId: "tenant-1", domainId: "dom-1", productId: "prod-1", product: { domainId: "dom-1" } } as never);
  });

  // ============================================================
  // extractMentionedUserIds
  // ============================================================
  describe("extractMentionedUserIds", () => {
    it("extracts user IDs from @[userId] syntax", () => {
      const ids = extractMentionedUserIds(
        "Hello @[user-1] and @[user-2], please review"
      );
      expect(ids).toEqual(["user-1", "user-2"]);
    });

    it("returns empty array when no mentions", () => {
      expect(extractMentionedUserIds("No mentions here")).toEqual([]);
    });

    it("deduplicates user IDs", () => {
      const ids = extractMentionedUserIds("@[user-1] and again @[user-1]");
      expect(ids).toEqual(["user-1"]);
    });

    it("handles mentions at start and end", () => {
      const ids = extractMentionedUserIds("@[user-1] text @[user-2]");
      expect(ids).toEqual(["user-1", "user-2"]);
    });
  });

  // ============================================================
  // createAnnotation
  // ============================================================
  describe("createAnnotation", () => {
    it("creates annotation with tagged users", async () => {
      const result = await createAnnotation(
        {
          entityId: "ent-1",
          content: "Test annotation @[user-2]",
          taggedUserIds: [],
        },
        mockCtx
      );

      expect(result.success).toBe(true);
      if (result.success) {
        expect(result.data.content).toBe("Test annotation @[user-2]");
        expect(result.data.authorId).toBe("user-1");
        expect(result.data.taggedUserIds).toContain("user-2");
      }
    });

    it("merges @-mention IDs with explicit taggedUserIds", async () => {
      const result = await createAnnotation(
        {
          entityId: "ent-1",
          content: "Hello @[user-2]",
          taggedUserIds: ["user-3"],
        },
        mockCtx
      );

      expect(result.success).toBe(true);
      if (result.success) {
        expect(result.data.taggedUserIds).toContain("user-2");
        expect(result.data.taggedUserIds).toContain("user-3");
      }
    });

    it("rejects empty content", async () => {
      const result = await createAnnotation(
        { entityId: "ent-1", content: "", taggedUserIds: [] },
        mockCtx
      );
      expect(result.success).toBe(false);
      if (!result.success) {
        expect(result.error.code).toBe("VALIDATION_ERROR");
      }
    });

    it("rejects when neither entityId nor fieldId provided", async () => {
      const result = await createAnnotation(
        { content: "Orphan annotation", taggedUserIds: [] },
        mockCtx
      );
      expect(result.success).toBe(false);
      if (!result.success) {
        expect(result.error.code).toBe("VALIDATION_ERROR");
      }
    });

    it("logs annotation creation to audit trail", async () => {
      await createAnnotation(
        { entityId: "ent-1", content: "Logged annotation", taggedUserIds: [] },
        mockCtx
      );

      // The withAudit wrapper calls prisma.auditLog.create
      expect(prisma.auditLog.create).toHaveBeenCalled();
    });
  });

  // ============================================================
  // getAnnotations
  // ============================================================
  describe("getAnnotations", () => {
    it("retrieves annotations by entity", async () => {
      vi.mocked(prisma.auditLog.findMany).mockResolvedValue([
        {
          id: "ann-1",
          action: "annotation.create",
          entityType: "Annotation",
          entityId: "ent-1",
          userId: "user-1",
          timestamp: new Date(),
          beforeState: null,
          afterState: {
            entityId: "ent-1",
            fieldId: null,
            content: "Entity annotation",
            taggedUserIds: [],
            resolved: false,
          },
          user: { id: "user-1", name: "John", image: null },
        },
      ] as never);

      const result = await getAnnotations("ent-1", undefined, mockCtx);

      expect(result.success).toBe(true);
      if (result.success) {
        expect(result.data).toHaveLength(1);
        expect(result.data[0].content).toBe("Entity annotation");
      }
    });

    it("retrieves annotations by field", async () => {
      vi.mocked(prisma.auditLog.findMany).mockResolvedValue([
        {
          id: "ann-2",
          action: "annotation.create",
          entityType: "Annotation",
          entityId: "fld-1",
          userId: "user-1",
          timestamp: new Date(),
          beforeState: null,
          afterState: {
            entityId: null,
            fieldId: "fld-1",
            content: "Field annotation",
            taggedUserIds: ["user-2"],
            resolved: false,
          },
          user: { id: "user-1", name: "Jane", image: null },
        },
      ] as never);

      const result = await getAnnotations(undefined, "fld-1", mockCtx);

      expect(result.success).toBe(true);
      if (result.success) {
        expect(result.data).toHaveLength(1);
        expect(result.data[0].fieldId).toBe("fld-1");
        expect(result.data[0].taggedUserIds).toContain("user-2");
      }
    });

    it("requires context", async () => {
      const result = await getAnnotations("ent-1");
      expect(result.success).toBe(false);
    });
  });

  // ============================================================
  // resolveAnnotation
  // ============================================================
  describe("resolveAnnotation", () => {
    it("marks annotation as resolved", async () => {
      vi.mocked(prisma.auditLog.findUnique).mockResolvedValue({
        id: "ann-1",
        action: "annotation.create",
        entityType: "Annotation",
        entityId: "ent-1",
        userId: "user-1",
        timestamp: new Date(),
        beforeState: null,
        afterState: {
          entityId: "ent-1",
          content: "Resolve me",
          taggedUserIds: [],
          resolved: false,
        },
        user: { id: "user-1", name: "John", image: null },
      } as never);

      const result = await resolveAnnotation("ann-1", mockCtx);

      expect(result.success).toBe(true);
      if (result.success) {
        expect(result.data.resolved).toBe(true);
      }
    });

    it("allows admin to resolve other users annotations", async () => {
      vi.mocked(prisma.auditLog.findUnique).mockResolvedValue({
        id: "ann-1",
        action: "annotation.create",
        entityType: "Annotation",
        entityId: "ent-1",
        userId: "other-user",
        timestamp: new Date(),
        beforeState: null,
        afterState: {
          entityId: "ent-1",
          content: "Other user annotation",
          taggedUserIds: [],
          resolved: false,
        },
        user: { id: "other-user", name: "Jane", image: null },
      } as never);

      const result = await resolveAnnotation("ann-1", adminCtx);

      expect(result.success).toBe(true);
    });

    it("moderating another user's annotation is judged over the annotated entity: an administrator of another tenant, a domain administrator of a sibling domain and a caller with no assignments are refused", async () => {
      vi.mocked(prisma.auditLog.findUnique).mockResolvedValue({
        id: "ann-1", action: "annotation.create", entityType: "Annotation", entityId: "ent-1", userId: "other-user", timestamp: new Date(), beforeState: null,
        afterState: { entityId: "ent-1", content: "x", taggedUserIds: [], resolved: false },
        user: { id: "other-user", name: "Jane", image: null },
      } as never);
      for (const assignments of [[assign.tenant("ADMIN", "tenant-9")], [assign.domain("ADMIN", "tenant-1", "dom-sibling")], [], undefined]) {
        const result = await resolveAnnotation("ann-1", { ...adminCtx, assignments });
        expect(result.success, JSON.stringify(assignments)).toBe(false);
      }
      // a domain administrator of the entity's own domain may
      expect((await resolveAnnotation("ann-1", { ...adminCtx, assignments: [assign.domain("ADMIN", "tenant-1", "dom-1")] })).success).toBe(true);
    });

    it("an annotation on a missing entity can be moderated by nobody but its author", async () => {
      vi.mocked(prisma.entity.findUnique).mockResolvedValue(null);
      vi.mocked(prisma.auditLog.findUnique).mockResolvedValue({
        id: "ann-1", action: "annotation.create", entityType: "Annotation", entityId: "ent-gone", userId: "other-user", timestamp: new Date(), beforeState: null,
        afterState: { entityId: "ent-gone", content: "x", taggedUserIds: [], resolved: false },
        user: { id: "other-user", name: "Jane", image: null },
      } as never);
      expect((await resolveAnnotation("ann-1", { ...adminCtx, assignments: [assign.global()] })).success).toBe(false);
    });

    it("rejects non-author non-admin from resolving", async () => {
      vi.mocked(prisma.auditLog.findUnique).mockResolvedValue({
        id: "ann-1",
        action: "annotation.create",
        entityType: "Annotation",
        entityId: "ent-1",
        userId: "other-user",
        timestamp: new Date(),
        beforeState: null,
        afterState: {
          entityId: "ent-1",
          content: "Other annotation",
          taggedUserIds: [],
          resolved: false,
        },
        user: { id: "other-user", name: "Jane", image: null },
      } as never);

      const result = await resolveAnnotation("ann-1", mockCtx);

      expect(result.success).toBe(false);
      if (!result.success) {
        expect(result.error.code).toBe("FORBIDDEN");
      }
    });

    it("returns error for non-existent annotation", async () => {
      vi.mocked(prisma.auditLog.findUnique).mockResolvedValue(null);

      const result = await resolveAnnotation("nonexistent", mockCtx);

      expect(result.success).toBe(false);
      if (!result.success) {
        expect(result.error.code).toBe("NOT_FOUND");
      }
    });

    it("creates audit trail entry on resolve", async () => {
      vi.mocked(prisma.auditLog.findUnique).mockResolvedValue({
        id: "ann-1",
        action: "annotation.create",
        entityType: "Annotation",
        entityId: "ent-1",
        userId: "user-1",
        timestamp: new Date(),
        beforeState: null,
        afterState: {
          entityId: "ent-1",
          content: "Audit me",
          taggedUserIds: [],
          resolved: false,
        },
        user: { id: "user-1", name: "John", image: null },
      } as never);

      await resolveAnnotation("ann-1", mockCtx);

      // withAudit creates audit entry
      expect(prisma.auditLog.create).toHaveBeenCalled();
    });
  });

  // ============================================================
  // searchUsers
  // ============================================================
  describe("searchUsers", () => {
    it("returns matching users", async () => {
      vi.mocked(prisma.user.findMany).mockResolvedValue([
        { id: "u-1", name: "John", email: "john@example.com", image: null },
      ] as never);

      const result = await searchUsers("John", mockCtx);

      expect(result.success).toBe(true);
      if (result.success) {
        expect(result.data).toHaveLength(1);
        expect(result.data[0].name).toBe("John");
      }
    });
  });
});
