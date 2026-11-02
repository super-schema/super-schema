import { describe, it, expect, vi, beforeEach } from "vitest";

vi.mock("@/lib/db", () => ({
  prisma: {
    entity: {
      findUnique: vi.fn(),
    },
    auditLog: {
      findMany: vi.fn(),
    },
  },
}));

import { getChangeHistory } from "@/services/change-history.service";
import {
  applyFilters,
  sortByTimestampDesc,
  paginate,
} from "@/services/change-history.service";
import { prisma } from "@/lib/db";
import type { ServiceContext } from "@/types/service-context";
import type { TimelineEntry, ChangeType } from "@/types/schemas/change-history";

const mockCtx: ServiceContext = {
  userId: "user-1",
  userRole: "AUTHOR",
  prisma: prisma as unknown as ServiceContext["prisma"],
};

function makeVersionSnapshot(version: number, timestamp: string, fields: { name: string; type: string }[] = []) {
  return {
    version,
    timestamp,
    createdBy: "user-1",
    snapshot: {
      entity: {
        id: "ent-1",
        name: "Customer",
        description: "",
        status: "DRAFT",
        version,
        domainId: "dom-1",
        metadata: null,
      },
      fields: fields.map((f, i) => ({
        id: `f-${i}`,
        name: f.name,
        type: f.type,
        precision: null,
        scale: null,
        nullable: false,
        isKey: false,
        fieldNumber: null,
        description: "",
        classification: null,
        aliases: [],
        decorators: {},
        sortOrder: i,
      })),
    },
    changeRecord: version > 1
      ? {
          previousVersion: version - 1,
          changes: [
            {
              type: "added" as const,
              fieldName: `field_v${version}`,
              details: { changedProperties: [] },
            },
          ],
        }
      : null,
  };
}

function makeAuditRecord(overrides: Record<string, unknown> = {}) {
  return {
    id: `audit-${Math.random().toString(36).slice(2, 8)}`,
    action: "UPDATE",
    entityType: "Field",
    entityId: "ent-1",
    userId: "user-1",
    timestamp: new Date("2024-02-15T10:00:00Z"),
    beforeState: null,
    afterState: null,
    ...overrides,
  };
}

describe("Change History Service", () => {
  beforeEach(() => {
    vi.clearAllMocks();
  });

  describe("getChangeHistory", () => {
    it("returns NOT_FOUND for non-existent entity", async () => {
      vi.mocked(prisma.entity.findUnique).mockResolvedValue(null as never);

      const result = await getChangeHistory("nonexistent", mockCtx);

      expect(result.success).toBe(false);
      if (!result.success) {
        expect(result.error.code).toBe("NOT_FOUND");
      }
    });

    it("returns empty timeline when no versions or audit entries exist", async () => {
      vi.mocked(prisma.entity.findUnique).mockResolvedValue({
        metadata: null,
      } as never);
      vi.mocked(prisma.auditLog.findMany).mockResolvedValue([] as never);

      const result = await getChangeHistory("ent-1", mockCtx);

      expect(result.success).toBe(true);
      if (result.success) {
        expect(result.data.entries).toHaveLength(0);
        expect(result.data.hasMore).toBe(false);
      }
    });

    it("merges version snapshots and audit entries into unified timeline", async () => {
      const versions = [
        makeVersionSnapshot(1, "2024-01-01T00:00:00Z"),
        makeVersionSnapshot(2, "2024-02-01T00:00:00Z"),
      ];

      vi.mocked(prisma.entity.findUnique).mockResolvedValue({
        metadata: { versionHistory: versions },
      } as never);

      vi.mocked(prisma.auditLog.findMany).mockResolvedValue([
        makeAuditRecord({
          id: "a1",
          action: "UPDATE",
          entityType: "Field",
          timestamp: new Date("2024-01-15T10:00:00Z"),
        }),
      ] as never);

      const result = await getChangeHistory("ent-1", mockCtx);

      expect(result.success).toBe(true);
      if (result.success) {
        // 2 versions + 1 audit = 3 entries
        expect(result.data.entries).toHaveLength(3);
        // Should be sorted by timestamp desc
        expect(result.data.entries[0].entryType).toBe("version"); // v2 - Feb 1
        expect(result.data.entries[1].entryType).toBe("audit"); // Jan 15
        expect(result.data.entries[2].entryType).toBe("version"); // v1 - Jan 1
      }
    });

    it("deduplicates CREATE_VERSION audit entries when version entries exist", async () => {
      const versions = [
        makeVersionSnapshot(1, "2024-01-01T00:00:00Z"),
      ];

      vi.mocked(prisma.entity.findUnique).mockResolvedValue({
        metadata: { versionHistory: versions },
      } as never);

      vi.mocked(prisma.auditLog.findMany).mockResolvedValue([
        makeAuditRecord({
          id: "a1",
          action: "CREATE_VERSION",
          entityType: "Entity",
          timestamp: new Date("2024-01-01T00:00:00Z"),
        }),
        makeAuditRecord({
          id: "a2",
          action: "UPDATE",
          entityType: "Field",
          timestamp: new Date("2024-01-02T00:00:00Z"),
        }),
      ] as never);

      const result = await getChangeHistory("ent-1", mockCtx);

      expect(result.success).toBe(true);
      if (result.success) {
        // 1 version + 1 audit (CREATE_VERSION is filtered out) = 2
        expect(result.data.entries).toHaveLength(2);
        const auditEntries = result.data.entries.filter(
          (e) => e.entryType === "audit"
        );
        expect(auditEntries).toHaveLength(1);
        expect(auditEntries[0].action).toBe("UPDATE");
      }
    });

    it("gracefully handles audit_log query failure", async () => {
      const versions = [
        makeVersionSnapshot(1, "2024-01-01T00:00:00Z"),
      ];

      vi.mocked(prisma.entity.findUnique).mockResolvedValue({
        metadata: { versionHistory: versions },
      } as never);

      vi.mocked(prisma.auditLog.findMany).mockRejectedValue(
        new Error("Table does not exist") as never
      );

      const result = await getChangeHistory("ent-1", mockCtx);

      expect(result.success).toBe(true);
      if (result.success) {
        // Falls back to version history only
        expect(result.data.entries).toHaveLength(1);
        expect(result.data.entries[0].entryType).toBe("version");
      }
    });

    it("applies changeType filter", async () => {
      const versions = [
        makeVersionSnapshot(1, "2024-01-01T00:00:00Z"),
      ];

      vi.mocked(prisma.entity.findUnique).mockResolvedValue({
        metadata: { versionHistory: versions },
      } as never);

      vi.mocked(prisma.auditLog.findMany).mockResolvedValue([
        makeAuditRecord({
          id: "a1",
          action: "UPDATE",
          entityType: "Field",
          timestamp: new Date("2024-01-15T10:00:00Z"),
        }),
      ] as never);

      const result = await getChangeHistory("ent-1", mockCtx, {
        changeTypes: ["version"],
      });

      expect(result.success).toBe(true);
      if (result.success) {
        expect(result.data.entries).toHaveLength(1);
        expect(result.data.entries[0].changeType).toBe("version");
      }
    });

    it("applies date range filter", async () => {
      const versions = [
        makeVersionSnapshot(1, "2024-01-01T00:00:00Z"),
        makeVersionSnapshot(2, "2024-03-01T00:00:00Z"),
      ];

      vi.mocked(prisma.entity.findUnique).mockResolvedValue({
        metadata: { versionHistory: versions },
      } as never);

      vi.mocked(prisma.auditLog.findMany).mockResolvedValue([] as never);

      const result = await getChangeHistory("ent-1", mockCtx, {
        dateFrom: new Date("2024-02-01T00:00:00Z"),
      });

      expect(result.success).toBe(true);
      if (result.success) {
        expect(result.data.entries).toHaveLength(1);
        expect(result.data.entries[0].versionNumber).toBe(2);
      }
    });

    it("applies userId filter", async () => {
      const versions = [
        makeVersionSnapshot(1, "2024-01-01T00:00:00Z"),
      ];
      // Override createdBy to be different
      versions[0].createdBy = "user-2";

      vi.mocked(prisma.entity.findUnique).mockResolvedValue({
        metadata: { versionHistory: versions },
      } as never);

      vi.mocked(prisma.auditLog.findMany).mockResolvedValue([
        makeAuditRecord({
          id: "a1",
          action: "UPDATE",
          entityType: "Field",
          userId: "user-1",
          timestamp: new Date("2024-01-15T10:00:00Z"),
        }),
      ] as never);

      const result = await getChangeHistory("ent-1", mockCtx, {
        userId: "user-1",
      });

      expect(result.success).toBe(true);
      if (result.success) {
        expect(result.data.entries).toHaveLength(1);
        expect(result.data.entries[0].userId).toBe("user-1");
      }
    });

    it("reads every audit row about the entity: its own, its fields' (the entity is in their state) and its creation, of its tenant", async () => {
      vi.mocked(prisma.entity.findUnique).mockResolvedValue({
        metadata: null,
        tenantId: "tenant-1",
      } as never);
      vi.mocked(prisma.auditLog.findMany).mockResolvedValue([] as never);

      await getChangeHistory("ent-1", mockCtx);

      const query = vi.mocked(prisma.auditLog.findMany).mock.calls[0][0] as unknown as { where: unknown; orderBy: unknown };
      expect(query.where).toEqual({
        AND: [
          { OR: [{ tenantId: "tenant-1" }, { tenantId: null }] },
          {
            OR: [
              { entityId: "ent-1" },
              { entityType: "Field", beforeState: { path: ["entityId"], equals: "ent-1" } },
              { entityType: "Field", afterState: { path: ["entityId"], equals: "ent-1" } },
              { entityType: "Entity", entityId: "pending", afterState: { path: ["id"], equals: "ent-1" } },
            ],
          },
        ],
      });
      // Rows written in the same millisecond keep a stable order (the id decides), so a page never repeats or skips one.
      expect(query.orderBy).toEqual([{ timestamp: "desc" }, { id: "desc" }]);
    });
  });

  describe("sortByTimestampDesc", () => {
    it("sorts entries by timestamp descending", () => {
      const entries: TimelineEntry[] = [
        {
          id: "1",
          timestamp: "2024-01-01T00:00:00Z",
          entryType: "version",
          changeType: "version",
          summary: "v1",
          userId: "u1",
        },
        {
          id: "3",
          timestamp: "2024-03-01T00:00:00Z",
          entryType: "version",
          changeType: "version",
          summary: "v3",
          userId: "u1",
        },
        {
          id: "2",
          timestamp: "2024-02-01T00:00:00Z",
          entryType: "audit",
          changeType: "field_edit",
          summary: "edit",
          userId: "u1",
        },
      ];

      const sorted = sortByTimestampDesc(entries);

      expect(sorted[0].id).toBe("3");
      expect(sorted[1].id).toBe("2");
      expect(sorted[2].id).toBe("1");
    });
  });

  describe("applyFilters", () => {
    const entries: TimelineEntry[] = [
      {
        id: "1",
        timestamp: "2024-01-01T00:00:00Z",
        entryType: "version",
        changeType: "version",
        summary: "v1",
        userId: "user-1",
      },
      {
        id: "2",
        timestamp: "2024-02-01T00:00:00Z",
        entryType: "audit",
        changeType: "field_edit",
        summary: "edit",
        userId: "user-2",
      },
      {
        id: "3",
        timestamp: "2024-03-01T00:00:00Z",
        entryType: "audit",
        changeType: "status_change",
        summary: "status",
        userId: "user-1",
      },
    ];

    it("returns all entries when no filters applied", () => {
      expect(applyFilters(entries)).toHaveLength(3);
      expect(applyFilters(entries, {})).toHaveLength(3);
    });

    it("filters by changeType", () => {
      const result = applyFilters(entries, { changeTypes: ["version"] });
      expect(result).toHaveLength(1);
      expect(result[0].changeType).toBe("version");
    });

    it("filters by multiple changeTypes", () => {
      const result = applyFilters(entries, {
        changeTypes: ["version", "field_edit"],
      });
      expect(result).toHaveLength(2);
    });

    it("filters by userId", () => {
      const result = applyFilters(entries, { userId: "user-2" });
      expect(result).toHaveLength(1);
      expect(result[0].userId).toBe("user-2");
    });

    it("filters by dateFrom", () => {
      const result = applyFilters(entries, {
        dateFrom: new Date("2024-02-01T00:00:00Z"),
      });
      expect(result).toHaveLength(2);
    });

    it("filters by dateTo", () => {
      const result = applyFilters(entries, {
        dateTo: new Date("2024-01-31T23:59:59Z"),
      });
      expect(result).toHaveLength(1);
    });

    it("filters by date range", () => {
      const result = applyFilters(entries, {
        dateFrom: new Date("2024-01-15T00:00:00Z"),
        dateTo: new Date("2024-02-15T00:00:00Z"),
      });
      expect(result).toHaveLength(1);
      expect(result[0].id).toBe("2");
    });

    it("combines multiple filters", () => {
      const result = applyFilters(entries, {
        changeTypes: ["field_edit", "status_change"],
        userId: "user-1",
      });
      expect(result).toHaveLength(1);
      expect(result[0].changeType).toBe("status_change");
    });
  });

  describe("paginate", () => {
    function makeEntries(count: number): TimelineEntry[] {
      return Array.from({ length: count }, (_, i) => ({
        id: `entry-${i}`,
        timestamp: new Date(2024, 0, count - i).toISOString(),
        entryType: "audit" as const,
        changeType: "field_edit" as ChangeType,
        summary: `Entry ${i}`,
        userId: "user-1",
      }));
    }

    it("returns first page with correct size", () => {
      const entries = makeEntries(100);
      const page = paginate(entries, undefined, 50);

      expect(page.entries).toHaveLength(50);
      expect(page.hasMore).toBe(true);
      expect(page.nextCursor).toBe("entry-49");
      expect(page.totalCount).toBe(100);
    });

    it("returns second page starting from cursor", () => {
      const entries = makeEntries(100);
      const page = paginate(entries, "entry-49", 50);

      expect(page.entries).toHaveLength(50);
      expect(page.entries[0].id).toBe("entry-50");
      expect(page.hasMore).toBe(false);
    });

    it("returns hasMore=false when all entries fit in one page", () => {
      const entries = makeEntries(10);
      const page = paginate(entries, undefined, 50);

      expect(page.entries).toHaveLength(10);
      expect(page.hasMore).toBe(false);
      expect(page.nextCursor).toBeUndefined();
    });

    it("returns empty page when cursor is at the end", () => {
      const entries = makeEntries(3);
      const page = paginate(entries, "entry-2", 50);

      expect(page.entries).toHaveLength(0);
      expect(page.hasMore).toBe(false);
    });

    it("defaults to page size 50", () => {
      const entries = makeEntries(60);
      const page = paginate(entries);

      expect(page.entries).toHaveLength(50);
      expect(page.hasMore).toBe(true);
    });
  });
});
