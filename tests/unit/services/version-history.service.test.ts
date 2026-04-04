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
  createSnapshot,
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

function makeMockField(overrides: Record<string, unknown> = {}) {
  return {
    id: "field-1",
    entityId: "ent-1",
    name: "customer_id",
    type: "string",
    precision: null,
    scale: null,
    nullable: false,
    isKey: true,
    fieldNumber: 1,
    description: "Customer ID",
    classification: "PII",
    aliases: [],
    decorators: {},
    sortOrder: 0,
    createdAt: new Date(),
    updatedAt: new Date(),
    ...overrides,
  };
}

describe("Version History Service", () => {
  beforeEach(() => {
    vi.clearAllMocks();
  });

  describe("createSnapshot", () => {
    it("creates a first version snapshot for an entity with no history", async () => {
      const entity = makeMockEntity({
        fields: [makeMockField()],
      });
      vi.mocked(prisma.entity.findUnique).mockResolvedValue(entity as never);
      vi.mocked(prisma.entity.update).mockResolvedValue(entity as never);

      const result = await createSnapshot("ent-1", mockCtx);

      expect(result.success).toBe(true);
      if (result.success) {
        expect(result.data.version).toBe(1);
        expect(result.data.snapshot.entity.name).toBe("Customer");
        expect(result.data.snapshot.fields).toHaveLength(1);
        expect(result.data.snapshot.fields[0].name).toBe("customer_id");
        expect(result.data.changeRecord).toBeNull(); // first version has no changes
        expect(result.data.createdBy).toBe("user-1");
      }
    });

    it("increments version number when previous versions exist", async () => {
      const existingHistory = [
        {
          version: 1,
          timestamp: "2024-01-01T00:00:00Z",
          createdBy: "user-1",
          snapshot: {
            entity: { id: "ent-1", name: "Customer", description: "", status: "DRAFT", version: 1, domainId: "dom-1", metadata: null },
            fields: [],
          },
          changeRecord: null,
        },
      ];
      const entity = makeMockEntity({
        metadata: { versionHistory: existingHistory },
        fields: [makeMockField()],
      });
      vi.mocked(prisma.entity.findUnique).mockResolvedValue(entity as never);
      vi.mocked(prisma.entity.update).mockResolvedValue(entity as never);

      const result = await createSnapshot("ent-1", mockCtx);

      expect(result.success).toBe(true);
      if (result.success) {
        expect(result.data.version).toBe(2);
      }
    });

    it("generates change record by diffing against previous version", async () => {
      const existingHistory = [
        {
          version: 1,
          timestamp: "2024-01-01T00:00:00Z",
          createdBy: "user-1",
          snapshot: {
            entity: { id: "ent-1", name: "Customer", description: "", status: "DRAFT", version: 1, domainId: "dom-1", metadata: null },
            fields: [
              {
                id: "f1", name: "old_field", type: "string", precision: null, scale: null,
                nullable: true, isKey: false, fieldNumber: null, description: "",
                classification: null, aliases: [], decorators: {}, sortOrder: 0,
              },
            ],
          },
          changeRecord: null,
        },
      ];

      // Current entity has a new field instead
      const entity = makeMockEntity({
        metadata: { versionHistory: existingHistory },
        fields: [
          makeMockField({ id: "f2", name: "new_field", type: "integer" }),
        ],
      });
      vi.mocked(prisma.entity.findUnique).mockResolvedValue(entity as never);
      vi.mocked(prisma.entity.update).mockResolvedValue(entity as never);

      const result = await createSnapshot("ent-1", mockCtx);

      expect(result.success).toBe(true);
      if (result.success) {
        expect(result.data.changeRecord).not.toBeNull();
        expect(result.data.changeRecord!.previousVersion).toBe(1);
        const changes = result.data.changeRecord!.changes;
        const added = changes.filter((c) => c.type === "added");
        const removed = changes.filter((c) => c.type === "removed");
        expect(added).toHaveLength(1);
        expect(added[0].fieldName).toBe("new_field");
        expect(removed).toHaveLength(1);
        expect(removed[0].fieldName).toBe("old_field");
      }
    });

    it("returns NOT_FOUND error for non-existent entity", async () => {
      vi.mocked(prisma.entity.findUnique).mockResolvedValue(null as never);

      const result = await createSnapshot("nonexistent", mockCtx);

      expect(result.success).toBe(false);
      if (!result.success) {
        expect(result.error.code).toBe("NOT_FOUND");
      }
    });

    it("calls withAudit on version creation", async () => {
      const entity = makeMockEntity({ fields: [] });
      vi.mocked(prisma.entity.findUnique).mockResolvedValue(entity as never);
      vi.mocked(prisma.entity.update).mockResolvedValue(entity as never);

      await createSnapshot("ent-1", mockCtx);

      // withAudit calls prisma.auditLog.create
      expect(prisma.auditLog.create).toHaveBeenCalled();
    });

    it("stores snapshot in entity metadata under versionHistory key", async () => {
      const entity = makeMockEntity({ fields: [makeMockField()] });
      vi.mocked(prisma.entity.findUnique).mockResolvedValue(entity as never);
      vi.mocked(prisma.entity.update).mockResolvedValue(entity as never);

      await createSnapshot("ent-1", mockCtx);

      expect(prisma.entity.update).toHaveBeenCalledWith(
        expect.objectContaining({
          where: { id: "ent-1" },
          data: expect.objectContaining({
            version: 1,
            metadata: expect.objectContaining({
              versionHistory: expect.arrayContaining([
                expect.objectContaining({ version: 1 }),
              ]),
            }),
          }),
        })
      );
    });

    it("creates multiple versions for the same entity", async () => {
      // First version
      const entity1 = makeMockEntity({ fields: [] });
      vi.mocked(prisma.entity.findUnique).mockResolvedValue(entity1 as never);
      vi.mocked(prisma.entity.update).mockResolvedValue(entity1 as never);

      const result1 = await createSnapshot("ent-1", mockCtx);
      expect(result1.success).toBe(true);
      if (result1.success) expect(result1.data.version).toBe(1);

      // Second version — entity now has version history from first
      const entity2 = makeMockEntity({
        metadata: {
          versionHistory: [
            {
              version: 1,
              timestamp: "2024-01-01T00:00:00Z",
              createdBy: "user-1",
              snapshot: { entity: {}, fields: [] },
              changeRecord: null,
            },
          ],
        },
        fields: [makeMockField()],
      });
      vi.mocked(prisma.entity.findUnique).mockResolvedValue(entity2 as never);

      const result2 = await createSnapshot("ent-1", mockCtx);
      expect(result2.success).toBe(true);
      if (result2.success) expect(result2.data.version).toBe(2);
    });
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
