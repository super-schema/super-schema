import { describe, it, expect, beforeEach } from "vitest";
import {
  getClassificationLevels,
  createClassification,
  updateClassification,
  deleteClassification,
  _resetClassificationStore,
  _setFieldUsage,
  _getClassificationStore,
} from "@/services/classification-taxonomy.service";
import type { ServiceContext } from "@/types/service-context";

const adminCtx: ServiceContext = {
  userId: "admin-1",
  userRole: "ADMIN",
  prisma: null as unknown as ServiceContext["prisma"],
};

const viewerCtx: ServiceContext = {
  userId: "viewer-1",
  userRole: "VIEWER",
  prisma: null as unknown as ServiceContext["prisma"],
};

describe("Classification Taxonomy Service", () => {
  beforeEach(() => {
    _resetClassificationStore();
  });

  describe("getClassificationLevels", () => {
    it("returns all levels ordered by sortOrder (seeded with system defaults)", async () => {
      const result = await getClassificationLevels(viewerCtx);
      expect(result.success).toBe(true);
      if (result.success) {
        expect(result.data.length).toBeGreaterThanOrEqual(4);
        expect(result.data[0].name).toBe("PII");
        expect(result.data[1].name).toBe("SENSITIVE");
        expect(result.data[2].name).toBe("INTERNAL");
        expect(result.data[3].name).toBe("PUBLIC");
        // Verify sorting
        for (let i = 1; i < result.data.length; i++) {
          expect(result.data[i].sortOrder).toBeGreaterThanOrEqual(result.data[i - 1].sortOrder);
        }
      }
    });

    it("is accessible to all authenticated users (no Admin required)", async () => {
      const result = await getClassificationLevels(viewerCtx);
      expect(result.success).toBe(true);
    });
  });

  describe("createClassification", () => {
    it("creates a new custom classification level", async () => {
      const result = await createClassification(
        {
          name: "confidential",
          displayColor: "#8B5CF6",
          bgColor: "#8B5CF620",
          textColor: "#8B5CF6",
          description: "Confidential data",
          sortOrder: 5,
        },
        adminCtx
      );
      expect(result.success).toBe(true);
      if (result.success) {
        expect(result.data.name).toBe("CONFIDENTIAL"); // auto-uppercased
        expect(result.data.isSystem).toBe(false);
        expect(result.data.displayColor).toBe("#8B5CF6");
        expect(result.data.sortOrder).toBe(5);
      }
    });

    it("auto-uppercases name", async () => {
      const result = await createClassification(
        {
          name: "restricted",
          displayColor: "#DC2626",
          bgColor: "#DC262620",
          textColor: "#DC2626",
          sortOrder: 6,
        },
        adminCtx
      );
      expect(result.success).toBe(true);
      if (result.success) {
        expect(result.data.name).toBe("RESTRICTED");
      }
    });

    it("rejects duplicate name (case-insensitive)", async () => {
      // "PII" is a system default that gets seeded
      await getClassificationLevels(adminCtx); // trigger seeding
      const result = await createClassification(
        {
          name: "pii",
          displayColor: "#FF0000",
          bgColor: "#FF000020",
          textColor: "#FF0000",
          sortOrder: 10,
        },
        adminCtx
      );
      expect(result.success).toBe(false);
      if (!result.success) {
        expect(result.error.code).toBe("DUPLICATE");
      }
    });

    it("rejects non-Admin users", async () => {
      const result = await createClassification(
        {
          name: "custom",
          displayColor: "#000000",
          bgColor: "#00000020",
          textColor: "#000000",
          sortOrder: 10,
        },
        viewerCtx
      );
      expect(result.success).toBe(false);
      if (!result.success) {
        expect(result.error.code).toBe("FORBIDDEN");
      }
    });

    it("validates hex color format", async () => {
      const result = await createClassification(
        {
          name: "invalid",
          displayColor: "not-a-color",
          bgColor: "#00000020",
          textColor: "#000000",
          sortOrder: 10,
        },
        adminCtx
      );
      expect(result.success).toBe(false);
      if (!result.success) {
        expect(result.error.code).toBe("VALIDATION_ERROR");
      }
    });
  });

  describe("updateClassification", () => {
    it("updates colors and description", async () => {
      // Seed defaults, then get one ID
      await getClassificationLevels(adminCtx);
      const store = _getClassificationStore();
      const pii = store.find((c) => c.name === "PII");
      expect(pii).toBeDefined();

      const result = await updateClassification(
        {
          id: pii!.id,
          displayColor: "#FF5555",
          description: "Updated description",
        },
        adminCtx
      );
      expect(result.success).toBe(true);
      if (result.success) {
        expect(result.data.displayColor).toBe("#FF5555");
        expect(result.data.description).toBe("Updated description");
      }
    });

    it("allows color update on system defaults", async () => {
      await getClassificationLevels(adminCtx);
      const store = _getClassificationStore();
      const internal = store.find((c) => c.name === "INTERNAL");

      const result = await updateClassification(
        {
          id: internal!.id,
          displayColor: "#1E40AF",
        },
        adminCtx
      );
      expect(result.success).toBe(true);
      if (result.success) {
        expect(result.data.displayColor).toBe("#1E40AF");
        expect(result.data.isSystem).toBe(true); // still system
      }
    });

    it("updates sortOrder", async () => {
      const created = await createClassification(
        {
          name: "test",
          displayColor: "#000000",
          bgColor: "#00000020",
          textColor: "#000000",
          sortOrder: 10,
        },
        adminCtx
      );
      expect(created.success).toBe(true);
      if (!created.success) return;

      const result = await updateClassification(
        { id: created.data.id, sortOrder: 2 },
        adminCtx
      );
      expect(result.success).toBe(true);
      if (result.success) {
        expect(result.data.sortOrder).toBe(2);
      }
    });
  });

  describe("deleteClassification", () => {
    it("deletes a custom classification not in use", async () => {
      const created = await createClassification(
        {
          name: "temporary",
          displayColor: "#000000",
          bgColor: "#00000020",
          textColor: "#000000",
          sortOrder: 99,
        },
        adminCtx
      );
      expect(created.success).toBe(true);
      if (!created.success) return;

      const result = await deleteClassification(created.data.id, adminCtx);
      expect(result.success).toBe(true);
    });

    it("blocks deletion of system default (isSystem=true)", async () => {
      await getClassificationLevels(adminCtx);
      const store = _getClassificationStore();
      const pii = store.find((c) => c.name === "PII");

      const result = await deleteClassification(pii!.id, adminCtx);
      expect(result.success).toBe(false);
      if (!result.success) {
        expect(result.error.code).toBe("FORBIDDEN");
        expect(result.error.message).toContain("system default");
      }
    });

    it("blocks deletion when fields use the classification", async () => {
      const created = await createClassification(
        {
          name: "inuse",
          displayColor: "#000000",
          bgColor: "#00000020",
          textColor: "#000000",
          sortOrder: 99,
        },
        adminCtx
      );
      expect(created.success).toBe(true);
      if (!created.success) return;

      _setFieldUsage("INUSE", 3);

      const result = await deleteClassification(created.data.id, adminCtx);
      expect(result.success).toBe(false);
      if (!result.success) {
        expect(result.error.code).toBe("CONFLICT");
        expect(result.error.message).toContain("3 fields");
      }
    });

    it("rejects non-Admin users", async () => {
      const result = await deleteClassification("some-id", viewerCtx);
      expect(result.success).toBe(false);
      if (!result.success) {
        expect(result.error.code).toBe("FORBIDDEN");
      }
    });
  });

  describe("Sort order determines dropdown position", () => {
    it("custom classification with low sortOrder appears before system defaults", async () => {
      const created = await createClassification(
        {
          name: "topSecret",
          displayColor: "#FF0000",
          bgColor: "#FF000020",
          textColor: "#FF0000",
          sortOrder: 0, // lower than PII (1)
        },
        adminCtx
      );
      expect(created.success).toBe(true);

      const result = await getClassificationLevels(adminCtx);
      expect(result.success).toBe(true);
      if (result.success) {
        expect(result.data[0].name).toBe("TOPSECRET");
        expect(result.data[0].sortOrder).toBe(0);
      }
    });
  });
});
