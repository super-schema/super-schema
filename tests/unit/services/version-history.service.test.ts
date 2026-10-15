import { describe, it, expect, vi, beforeEach } from "vitest";

vi.mock("@/lib/db", () => ({
  prisma: {
    entity: {
      findUnique: vi.fn(),
      update: vi.fn(),
    },
    auditLog: {
      create: vi.fn().mockResolvedValue({ id: "audit-1" }),
    },
  },
}));

import {
  getVersionHistory,
  getVersion,
  compareVersions,
  compareVersionsStructured,
} from "@/services/version-history/version.service";
import { prisma } from "@/lib/db";
import type { ServiceContext } from "@/types/service-context";

const mockCtx: ServiceContext = {
  userId: "user-1",
  userRole: "AUTHOR",
  prisma: prisma as unknown as ServiceContext["prisma"],
};

function makeMockEntity(overrides: Record<string, unknown> = {}) {
  return {
    id: "ent-1",
    name: "Customer",
    description: "Customer entity",
    status: "DRAFT",
    version: 1,
    domainId: "dom-1",
    ownerId: "user-1",
    metadata: null,
    fields: [],
    createdAt: new Date(),
    updatedAt: new Date(),
    ...overrides,
  };
}

describe("Version History Service", () => {
  beforeEach(() => {
    vi.clearAllMocks();
  });

  describe("getVersionHistory", () => {
    it("returns empty array when no history exists", async () => {
      const entity = makeMockEntity();
      vi.mocked(prisma.entity.findUnique).mockResolvedValue(entity as never);

      const result = await getVersionHistory("ent-1", mockCtx);

      expect(result.success).toBe(true);
      if (result.success) {
        expect(result.data).toEqual([]);
      }
    });

    it("returns versions in reverse chronological order", async () => {
      const entity = makeMockEntity({
        metadata: {
          versionHistory: [
            { version: 1, timestamp: "2024-01-01T00:00:00Z", createdBy: "user-1", snapshot: { entity: {}, fields: [] }, changeRecord: null },
            { version: 3, timestamp: "2024-03-01T00:00:00Z", createdBy: "user-1", snapshot: { entity: {}, fields: [] }, changeRecord: null },
            { version: 2, timestamp: "2024-02-01T00:00:00Z", createdBy: "user-1", snapshot: { entity: {}, fields: [] }, changeRecord: null },
          ],
        },
      });
      vi.mocked(prisma.entity.findUnique).mockResolvedValue(entity as never);

      const result = await getVersionHistory("ent-1", mockCtx);

      expect(result.success).toBe(true);
      if (result.success) {
        expect(result.data).toHaveLength(3);
        expect(result.data[0].version).toBe(3);
        expect(result.data[1].version).toBe(2);
        expect(result.data[2].version).toBe(1);
      }
    });

    it("returns NOT_FOUND for non-existent entity", async () => {
      vi.mocked(prisma.entity.findUnique).mockResolvedValue(null as never);

      const result = await getVersionHistory("nonexistent", mockCtx);

      expect(result.success).toBe(false);
      if (!result.success) {
        expect(result.error.code).toBe("NOT_FOUND");
      }
    });
  });

  describe("getVersion", () => {
    it("returns a specific version by number", async () => {
      const entity = makeMockEntity({
        metadata: {
          versionHistory: [
            { version: 1, timestamp: "2024-01-01T00:00:00Z", createdBy: "user-1", snapshot: { entity: {}, fields: [] }, changeRecord: null },
            { version: 2, timestamp: "2024-02-01T00:00:00Z", createdBy: "user-1", snapshot: { entity: {}, fields: [{ name: "email" }] }, changeRecord: null },
          ],
        },
      });
      vi.mocked(prisma.entity.findUnique).mockResolvedValue(entity as never);

      const result = await getVersion("ent-1", 2, mockCtx);

      expect(result.success).toBe(true);
      if (result.success) {
        expect(result.data.version).toBe(2);
      }
    });

    it("returns NOT_FOUND for non-existent version", async () => {
      const entity = makeMockEntity({
        metadata: { versionHistory: [] },
      });
      vi.mocked(prisma.entity.findUnique).mockResolvedValue(entity as never);

      const result = await getVersion("ent-1", 99, mockCtx);

      expect(result.success).toBe(false);
      if (!result.success) {
        expect(result.error.code).toBe("NOT_FOUND");
      }
    });
  });

  describe("compareVersions", () => {
    it("computes diff between two versions", async () => {
      const entity = makeMockEntity({
        metadata: {
          versionHistory: [
            {
              version: 1,
              timestamp: "2024-01-01T00:00:00Z",
              createdBy: "user-1",
              snapshot: {
                entity: {},
                fields: [
                  {
                    id: "f1", name: "customer_id", type: "string", precision: null, scale: null,
                    nullable: false, isKey: true, fieldNumber: 1, description: "",
                    classification: null, aliases: [], decorators: {}, sortOrder: 0,
                  },
                ],
              },
              changeRecord: null,
            },
            {
              version: 2,
              timestamp: "2024-02-01T00:00:00Z",
              createdBy: "user-1",
              snapshot: {
                entity: {},
                fields: [
                  {
                    id: "f1", name: "customer_id", type: "integer", precision: null, scale: null,
                    nullable: false, isKey: true, fieldNumber: 1, description: "",
                    classification: null, aliases: [], decorators: {}, sortOrder: 0,
                  },
                  {
                    id: "f2", name: "email", type: "string", precision: null, scale: null,
                    nullable: true, isKey: false, fieldNumber: 2, description: "",
                    classification: null, aliases: [], decorators: {}, sortOrder: 1,
                  },
                ],
              },
              changeRecord: null,
            },
          ],
        },
      });
      vi.mocked(prisma.entity.findUnique).mockResolvedValue(entity as never);

      const result = await compareVersions("ent-1", 1, 2, mockCtx);

      expect(result.success).toBe(true);
      if (result.success) {
        expect(result.data.fromVersion).toBe(1);
        expect(result.data.toVersion).toBe(2);
        expect(result.data.summary.added).toBe(1);
        expect(result.data.summary.modified).toBe(1);
        expect(result.data.summary.removed).toBe(0);
      }
    });

    it("returns NOT_FOUND when a version does not exist", async () => {
      const entity = makeMockEntity({
        metadata: {
          versionHistory: [
            { version: 1, timestamp: "2024-01-01T00:00:00Z", createdBy: "user-1", snapshot: { entity: {}, fields: [] }, changeRecord: null },
          ],
        },
      });
      vi.mocked(prisma.entity.findUnique).mockResolvedValue(entity as never);

      const result = await compareVersions("ent-1", 1, 5, mockCtx);

      expect(result.success).toBe(false);
      if (!result.success) {
        expect(result.error.code).toBe("NOT_FOUND");
      }
    });
  });

  describe("compareVersionsStructured", () => {
    it("returns structured diff with unchanged fields and property changes", async () => {
      const entity = makeMockEntity({
        metadata: {
          versionHistory: [
            {
              version: 1,
              timestamp: "2024-01-01T00:00:00Z",
              createdBy: "user-1",
              snapshot: {
                entity: {},
                fields: [
                  {
                    id: "f1", name: "customer_id", type: "string", precision: null, scale: null,
                    nullable: false, isKey: true, fieldNumber: 1, description: "",
                    classification: "PUBLIC", aliases: [], decorators: {}, sortOrder: 0,
                  },
                  {
                    id: "f2", name: "email", type: "string", precision: null, scale: null,
                    nullable: true, isKey: false, fieldNumber: 2, description: "",
                    classification: null, aliases: [], decorators: {}, sortOrder: 1,
                  },
                ],
              },
              changeRecord: null,
            },
            {
              version: 2,
              timestamp: "2024-02-01T00:00:00Z",
              createdBy: "user-1",
              snapshot: {
                entity: {},
                fields: [
                  {
                    id: "f1", name: "customer_id", type: "integer", precision: null, scale: null,
                    nullable: false, isKey: true, fieldNumber: 1, description: "",
                    classification: "PII", aliases: [], decorators: {}, sortOrder: 0,
                  },
                  {
                    id: "f3", name: "status", type: "string", precision: null, scale: null,
                    nullable: false, isKey: false, fieldNumber: 3, description: "",
                    classification: null, aliases: [], decorators: {}, sortOrder: 2,
                  },
                ],
              },
              changeRecord: null,
            },
          ],
        },
      });
      vi.mocked(prisma.entity.findUnique).mockResolvedValue(entity as never);

      const result = await compareVersionsStructured("ent-1", 1, 2, mockCtx);

      expect(result.success).toBe(true);
      if (result.success) {
        expect(result.data.fromVersion).toBe(1);
        expect(result.data.toVersion).toBe(2);
        expect(result.data.summary.added).toBe(1);       // status
        expect(result.data.summary.removed).toBe(1);      // email
        expect(result.data.summary.modified).toBe(1);     // customer_id
        expect(result.data.summary.unchanged).toBe(0);

        // Check property-level changes on customer_id
        const modifiedField = result.data.fields.find(
          (f) => f.fieldName === "customer_id"
        );
        expect(modifiedField).toBeDefined();
        expect(modifiedField!.changedProperties).toBeDefined();
        const typeChange = modifiedField!.changedProperties!.find(
          (p) => p.property === "type"
        );
        expect(typeChange).toBeDefined();
        expect(typeChange!.before).toBe("string");
        expect(typeChange!.after).toBe("integer");

        const classChange = modifiedField!.changedProperties!.find(
          (p) => p.property === "classification"
        );
        expect(classChange).toBeDefined();
        expect(classChange!.before).toBe("PUBLIC");
        expect(classChange!.after).toBe("PII");
      }
    });

    it("returns NOT_FOUND for non-existent entity", async () => {
      vi.mocked(prisma.entity.findUnique).mockResolvedValue(null as never);

      const result = await compareVersionsStructured("nonexistent", 1, 2, mockCtx);

      expect(result.success).toBe(false);
      if (!result.success) {
        expect(result.error.code).toBe("NOT_FOUND");
      }
    });

    it("returns NOT_FOUND for non-existent version", async () => {
      const entity = makeMockEntity({
        metadata: {
          versionHistory: [
            { version: 1, timestamp: "2024-01-01T00:00:00Z", createdBy: "user-1", snapshot: { entity: {}, fields: [] }, changeRecord: null },
          ],
        },
      });
      vi.mocked(prisma.entity.findUnique).mockResolvedValue(entity as never);

      const result = await compareVersionsStructured("ent-1", 1, 99, mockCtx);

      expect(result.success).toBe(false);
      if (!result.success) {
        expect(result.error.code).toBe("NOT_FOUND");
      }
    });
  });
});
