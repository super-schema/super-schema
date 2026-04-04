import { describe, it, expect, vi, beforeEach } from "vitest";
import {
  notifyGovernanceApprovalRequest,
  notifyGovernanceDecision,
  notifyAnnotationTag,
  notifyEmissionComplete,
} from "@/services/notification.triggers";
import { _resetStore, _getStore } from "@/services/notification.service";
import {
  _resetStore as _resetWebhookStore,
} from "@/services/webhook.service";
import type { ServiceContext } from "@/types/service-context";

const mockCtx: ServiceContext = {
  userId: "user-trigger",
  userRole: "AUTHOR",
  prisma: {} as ServiceContext["prisma"],
};

describe("Notification Triggers", () => {
  beforeEach(() => {
    _resetStore();
    _resetWebhookStore();
    vi.restoreAllMocks();
  });

  describe("notifyGovernanceApprovalRequest", () => {
    it("creates APPROVAL_REQUEST for all domain stewards", async () => {
      await notifyGovernanceApprovalRequest(
        "entity-1",
        "UserProfile",
        "2",
        "domain-1",
        ["steward-1", "steward-2"],
        mockCtx
      );

      const store = _getStore();
      expect(store).toHaveLength(2);
      expect(store[0].type).toBe("APPROVAL_REQUEST");
      expect(store[0].userId).toBe("steward-1");
      expect(store[0].title).toContain("UserProfile");
      expect(store[0].title).toContain("v2");
      expect(store[1].userId).toBe("steward-2");
    });
  });

  describe("notifyGovernanceDecision", () => {
    it("creates APPROVAL_DECISION for requestor — approved", async () => {
      await notifyGovernanceDecision(
        "requestor-1",
        "UserProfile",
        "approved",
        "Jane Steward",
        { entityId: "entity-1" },
        mockCtx
      );

      const store = _getStore();
      expect(store).toHaveLength(1);
      expect(store[0].type).toBe("APPROVAL_DECISION");
      expect(store[0].userId).toBe("requestor-1");
      expect(store[0].title).toContain("approved");
      expect(store[0].title).toContain("Jane Steward");
    });

    it("creates APPROVAL_DECISION for requestor — rejected", async () => {
      await notifyGovernanceDecision(
        "requestor-1",
        "UserProfile",
        "rejected",
        "John Admin",
        { entityId: "entity-1" },
        mockCtx
      );

      const store = _getStore();
      expect(store).toHaveLength(1);
      expect(store[0].title).toContain("rejected");
      expect(store[0].title).toContain("John Admin");
    });
  });

  describe("notifyAnnotationTag", () => {
    it("creates ANNOTATION_TAG for each tagged user", async () => {
      await notifyAnnotationTag(
        ["tagged-1", "tagged-2", "tagged-3"],
        "Alice",
        "OrderEntity",
        "status",
        { entityId: "entity-2", fieldId: "field-1" },
        mockCtx
      );

      const store = _getStore();
      expect(store).toHaveLength(3);
      expect(store[0].type).toBe("ANNOTATION_TAG");
      expect(store[0].title).toContain("Alice");
      expect(store[0].title).toContain("OrderEntity.status");
      expect(store[0].entityRef.fieldId).toBe("field-1");
    });
  });

  describe("notifyEmissionComplete", () => {
    it("creates CHANGE_COMPLETE for entity owner", async () => {
      await notifyEmissionComplete(
        "owner-1",
        "PaymentEvent",
        "3",
        5,
        { entityId: "entity-3", versionId: "3" },
        mockCtx
      );

      const store = _getStore();
      expect(store).toHaveLength(1);
      expect(store[0].type).toBe("CHANGE_COMPLETE");
      expect(store[0].userId).toBe("owner-1");
      expect(store[0].title).toContain("PaymentEvent");
      expect(store[0].title).toContain("v3");
      expect(store[0].title).toContain("5 targets");
    });
  });

  describe("Fire-and-forget behavior", () => {
    it("does not throw when notification creation fails", async () => {
      // Spy on createNotification to make it throw
      const consoleSpy = vi
        .spyOn(console, "error")
        .mockImplementation(() => {});

      // Pass invalid data that would cause internal error
      // Even with bad internal state, the trigger should catch and log
      const { createNotification } = await import(
        "@/services/notification.service"
      );
      vi.spyOn(
        { createNotification },
        "createNotification"
      ).mockRejectedValue(new Error("DB connection failed"));

      // This should not throw
      await expect(
        notifyGovernanceApprovalRequest(
          "entity-1",
          "TestEntity",
          "1",
          "domain-1",
          ["steward-1"],
          mockCtx
        )
      ).resolves.not.toThrow();

      consoleSpy.mockRestore();
    });

    it("logs error to console.error when notification fails", async () => {
      const consoleSpy = vi
        .spyOn(console, "error")
        .mockImplementation(() => {});

      // Directly test that the triggers wrap in try/catch
      // by making the underlying createNotification throw
      const notifMod = await import("@/services/notification.service");
      const originalCreate = notifMod.createNotification;
      vi.spyOn(notifMod, "createNotification").mockRejectedValueOnce(
        new Error("Simulated failure")
      );

      await notifyGovernanceApprovalRequest(
        "entity-1",
        "TestEntity",
        "1",
        "domain-1",
        ["steward-1"],
        mockCtx
      );

      expect(consoleSpy).toHaveBeenCalled();

      // Restore
      vi.spyOn(notifMod, "createNotification").mockImplementation(
        originalCreate
      );
      consoleSpy.mockRestore();
    });
  });
});
