import { describe, it, expect, vi, beforeEach } from "vitest";

// ---------------------------------------------------------------------------
// Mock Prisma
// ---------------------------------------------------------------------------
vi.mock("@/lib/db", () => ({
  prisma: {
    gitConfig: {
      findFirst: vi.fn(),
      findUnique: vi.fn(),
      update: vi.fn(),
    },
    gitPullRequest: {
      create: vi.fn(),
      findUnique: vi.fn(),
      findFirst: vi.fn(),
      findMany: vi.fn(),
    },
    entity: {
      findUnique: vi.fn(),
    },
    auditLog: {
      create: vi.fn().mockResolvedValue({ id: "audit-1" }),
    },
  },
}));

import {
  buildPrBranchName,
  buildPrTitle,
  shouldCreatePr,
  buildPrBody,
  exportWithReview,
  syncPrStatus,
  getPrHistory,
  getLatestPr,
  type PrBodyInput,
  type ChangeRecordWithClassification,
} from "@/services/git-pr.service";
import { prisma } from "@/lib/db";
import type { ServiceContext } from "@/types/service-context";
import type { TargetOutput } from "@/lib/emission/emission.types";
import type { MigrationArtifacts } from "@/lib/migration/migration.types";
import { assign } from "../../helpers/access-mocks";

const authorCtx: ServiceContext = {
  userId: "user-author",
  userRole: "AUTHOR", assignments: [assign.tenant("AUTHOR", "tenant-1")],
  prisma: prisma as unknown as ServiceContext["prisma"],
};

// ---------------------------------------------------------------------------
// Pure function tests
// ---------------------------------------------------------------------------

describe("Git PR Service — Pure Helpers", () => {
  describe("buildPrBranchName", () => {
    it("creates correct branch name format", () => {
      expect(buildPrBranchName("Transaction", 3)).toBe(
        "schema/transaction/v3"
      );
    });

    it("slugifies entity name", () => {
      expect(buildPrBranchName("My Entity", 1)).toBe("schema/my-entity/v1");
    });

    it("handles special characters", () => {
      expect(buildPrBranchName("User@Profile", 2)).toBe(
        "schema/user-profile/v2"
      );
    });
  });

  describe("buildPrTitle", () => {
    it("returns correct title format", () => {
      expect(buildPrTitle("Transaction", 3, "breaking")).toBe(
        "Schema: Transaction v3 — breaking"
      );
    });

    it("includes entity name, version, and change type", () => {
      const title = buildPrTitle("User", 1, "non-breaking");
      expect(title).toContain("User");
      expect(title).toContain("v1");
      expect(title).toContain("non-breaking");
    });
  });

  describe("shouldCreatePr", () => {
    it("returns true for ALWAYS mode regardless of breaking status", () => {
      expect(shouldCreatePr("ALWAYS", true)).toBe(true);
      expect(shouldCreatePr("ALWAYS", false)).toBe(true);
    });

    it("returns false for NEVER mode regardless of breaking status", () => {
      expect(shouldCreatePr("NEVER", true)).toBe(false);
      expect(shouldCreatePr("NEVER", false)).toBe(false);
    });

    it("returns true for BREAKING_ONLY when change is breaking", () => {
      expect(shouldCreatePr("BREAKING_ONLY", true)).toBe(true);
    });

    it("returns false for BREAKING_ONLY when change is non-breaking", () => {
      expect(shouldCreatePr("BREAKING_ONLY", false)).toBe(false);
    });

    it("defaults to BREAKING_ONLY behavior for unknown modes", () => {
      expect(shouldCreatePr("UNKNOWN", true)).toBe(true);
      expect(shouldCreatePr("UNKNOWN", false)).toBe(false);
    });
  });

  describe("buildPrBody", () => {
    const baseInput: PrBodyInput = {
      entity: {
        id: "entity-1",
        name: "Transaction",
        description: "Payment transaction entity",
        domain: { name: "Payments" },
      },
      version: { id: "v-1", version: 3 },
      changeInfo: {
        isBreaking: true,
        changeType: "breaking",
        summary: "Removed currency field, changed amount type",
        changeRecord: {
          previousVersion: 2,
          changes: [
            {
              type: "removed",
              fieldName: "currency",
              details: {
                before: {
                  id: "f-1",
                  name: "currency",
                  type: "STRING",
                  precision: null,
                  scale: null,
                  nullable: false,
                  isKey: false,
                  fieldNumber: null,
                  description: "Currency code",
                  classification: null,
                  aliases: [],
                  decorators: {},
                  sortOrder: 1,
                },
                changedProperties: [],
              },
            },
            {
              type: "modified",
              fieldName: "amount",
              details: {
                before: {
                  id: "f-2",
                  name: "amount",
                  type: "INT32",
                  precision: null,
                  scale: null,
                  nullable: false,
                  isKey: false,
                  fieldNumber: null,
                  description: "Amount in cents",
                  classification: null,
                  aliases: [],
                  decorators: {},
                  sortOrder: 2,
                },
                after: {
                  id: "f-2",
                  name: "amount",
                  type: "DECIMAL",
                  precision: 10,
                  scale: 2,
                  nullable: false,
                  isKey: false,
                  fieldNumber: null,
                  description: "Amount in dollars",
                  classification: null,
                  aliases: [],
                  decorators: {},
                  sortOrder: 2,
                },
                changedProperties: ["type", "precision", "scale", "description"],
              },
            },
          ],
        },
      },
      emittedOutputs: {
        bigquery: {
          name: "bigquery",
          targetFormat: "bigquery-ddl",
          output: "CREATE TABLE ...",
          isValid: true,
          validationStatus: "VALID",
          warnings: [],
          errors: [],
        },
        avro: {
          name: "avro",
          targetFormat: "avro-schema",
          output: '{"type":"record"}',
          isValid: true,
          validationStatus: "WARNING",
          warnings: [
            {
              message: "Decimal mapped to bytes",
              fieldName: "amount",
            },
          ],
          errors: [],
        },
      },
      governanceStatus: "Approved by data-governance-team",
      appUrl: "https://superschema.example.com",
    };

    it("includes change summary section", () => {
      const body = buildPrBody(baseInput);
      expect(body).toContain("## Change Summary");
      expect(body).toContain(
        "Removed currency field, changed amount type"
      );
    });

    it("includes change classification — breaking", () => {
      const body = buildPrBody(baseInput);
      expect(body).toContain("## Change Classification");
      expect(body).toContain("BREAKING CHANGE");
    });

    it("includes change classification — non-breaking", () => {
      const nonBreakingInput: PrBodyInput = {
        ...baseInput,
        changeInfo: {
          isBreaking: false,
          changeType: "non-breaking",
          summary: "Added new optional field",
          changeRecord: null,
        },
      };
      const body = buildPrBody(nonBreakingInput);
      expect(body).toContain("Non-breaking change");
    });

    it("includes per-target compatibility report", () => {
      const body = buildPrBody(baseInput);
      expect(body).toContain("## Compatibility Report");
      expect(body).toContain("| bigquery |");
      expect(body).toContain("| avro |");
      expect(body).toContain("1 warning(s)");
    });

    it("includes collapsible migration artifacts section with <details>", () => {
      const inputWithMigration: PrBodyInput = {
        ...baseInput,
        migrationArtifacts: {
          targets: [
            {
              targetFormat: "bigquery",
              artifacts: [
                {
                  type: "ddl",
                  content: "ALTER TABLE ... DROP COLUMN currency;",
                  warnings: ["Destructive operation: column drop"],
                },
              ],
            },
          ],
        },
      };
      const body = buildPrBody(inputWithMigration);
      expect(body).toContain("<details>");
      expect(body).toContain("<summary>bigquery — ddl</summary>");
      expect(body).toContain("ALTER TABLE");
      expect(body).toContain("Destructive operation: column drop");
      expect(body).toContain("</details>");
    });

    it("includes governance approval status", () => {
      const body = buildPrBody(baseInput);
      expect(body).toContain("## Governance Status");
      expect(body).toContain("Approved by data-governance-team");
    });

    it("includes link back to Super Schema UI", () => {
      const body = buildPrBody(baseInput);
      expect(body).toContain("## Super Schema");
      expect(body).toContain(
        "[View in Super Schema](https://superschema.example.com/entities/entity-1)"
      );
    });

    it("shows entity ID when appUrl is not configured", () => {
      const inputNoUrl: PrBodyInput = {
        ...baseInput,
        appUrl: undefined,
      };
      const body = buildPrBody(inputNoUrl);
      expect(body).toContain("Entity ID: entity-1");
    });

    it("includes detailed field changes in collapsible section", () => {
      const body = buildPrBody(baseInput);
      expect(body).toContain("Detailed Field Changes");
      expect(body).toContain("### Removed Fields");
      expect(body).toContain("**currency**");
      expect(body).toContain("### Modified Fields");
      expect(body).toContain("**amount**");
      expect(body).toContain("type, precision, scale, description");
    });

    it("handles empty emitted outputs", () => {
      const inputNoOutputs: PrBodyInput = {
        ...baseInput,
        emittedOutputs: {},
      };
      const body = buildPrBody(inputNoOutputs);
      expect(body).toContain("No emission targets configured.");
    });

    describe("exported targets (schemaVersions)", () => {
      const exportedTargets: PrBodyInput["exportedTargets"] = [
        { target: "avro", displayName: "Avro Schema", version: 2, status: "published", fileCount: 3 },
        { target: "json-schema", displayName: "JSON Schema (TypeSpec)", version: 4, status: "draft", fileCount: 2 },
        { target: "protobuf", displayName: "Protobuf (TypeSpec)", version: 1, status: "draft", fileCount: 1, preview: true },
        { target: "openapi3", displayName: "OpenAPI 3 (TypeSpec)", version: 5, status: "deployed", fileCount: 4, preview: true },
      ];

      it("lists the targets the PR adds with version, status, file count and a note for a draft or a preview", () => {
        const body = buildPrBody({ ...baseInput, emittedOutputs: {}, exportedTargets });
        expect(body).toContain("| Target | Version | Status | Files | Details |");
        expect(body).toContain("| Avro Schema | v2 | published | 3 | - |");
        expect(body).toContain("| JSON Schema (TypeSpec) | v4 | draft | 2 | draft |");
        expect(body).toContain("| Protobuf (TypeSpec) | v1 | draft | 1 | draft, preview |");
        expect(body).toContain("| OpenAPI 3 (TypeSpec) | v5 | deployed | 4 | preview |");
        expect(body).not.toContain("No emission targets configured.");
      });

      it("does not print a valid/invalid verdict: a stored version has none", () => {
        const body = buildPrBody({ ...baseInput, emittedOutputs: {}, exportedTargets });
        expect(body).not.toMatch(/\bValid\b|\bInvalid\b/);
      });

      it("keeps the legacy table when exportedTargets is absent or empty", () => {
        const legacy = buildPrBody(baseInput);
        expect(legacy).toContain("| Target | Status | Details |");
        expect(legacy).toContain("| bigquery | Valid | No issues |");
        expect(buildPrBody({ ...baseInput, exportedTargets: [] })).toBe(legacy);
        expect(buildPrBody({ ...baseInput, emittedOutputs: {}, exportedTargets: [] })).toContain("No emission targets configured.");
      });
    });

    it("handles no governance status", () => {
      const inputNoGov: PrBodyInput = {
        ...baseInput,
        governanceStatus: undefined,
      };
      const body = buildPrBody(inputNoGov);
      expect(body).toContain("No governance review required.");
    });

    it("uses <details> tags for collapsible sections", () => {
      const inputWithMigration: PrBodyInput = {
        ...baseInput,
        migrationArtifacts: {
          targets: [
            {
              targetFormat: "avro",
              artifacts: [
                {
                  type: "compatibility-report",
                  content: "BACKWARD compatible",
                  warnings: [],
                },
              ],
            },
          ],
        },
      };
      const body = buildPrBody(inputWithMigration);
      // Confirm <details>/<summary> structure
      const detailsCount = (body.match(/<details>/g) || []).length;
      const summaryCount = (body.match(/<summary>/g) || []).length;
      expect(detailsCount).toBeGreaterThanOrEqual(1);
      expect(summaryCount).toBeGreaterThanOrEqual(1);
    });
  });
});

// ---------------------------------------------------------------------------
// Service function tests (mocked Prisma)
// ---------------------------------------------------------------------------

describe("Git PR Service — Service Functions", () => {
  beforeEach(() => {
    vi.clearAllMocks();
  });

  const mockEntity = {
    id: "entity-1",
    name: "Transaction",
    description: "A transaction",
    status: "ACTIVE",
    metadata: { currentVersion: 3, emittedOutputs: {} },
    domain: { id: "dom-1", name: "Payments" },
    fields: [
      {
        id: "f-1",
        name: "id",
        type: "STRING",
        nullable: false,
        isKey: true,
        description: "Primary key",
        classification: null,
        decorators: {},
        sortOrder: 0,
      },
    ],
  };

  const breakingChange: ChangeRecordWithClassification = {
    isBreaking: true,
    changeType: "breaking",
    summary: "Removed field",
    changeRecord: null,
  };

  const nonBreakingChange: ChangeRecordWithClassification = {
    isBreaking: false,
    changeType: "non-breaking",
    summary: "Added optional field",
    changeRecord: null,
  };

  describe("exportWithReview", () => {
    it("creates PR for breaking change when prReviewMode is BREAKING_ONLY", async () => {
      vi.mocked(prisma.gitConfig.findFirst).mockResolvedValue({
        id: "gc-1",
        basePath: "schemas/",
        enabled: true,
        prReviewMode: "BREAKING_ONLY",
        repositoryUrl: "https://github.com/org/repo",
      } as never);
      vi.mocked(prisma.entity.findUnique).mockResolvedValue(
        mockEntity as never
      );
      vi.mocked(prisma.gitPullRequest.create).mockResolvedValue({
        id: "pr-1",
        entityId: "entity-1",
        versionId: "v-1",
        prUrl: "https://github.com/org/repo/pull/42",
        prNumber: 42,
        branchName: "schema/transaction/v3",
        status: "OPEN",
        createdAt: new Date(),
        updatedAt: new Date(),
      } as never);
      vi.mocked(prisma.gitConfig.update).mockResolvedValue({} as never);

      const result = await exportWithReview(
        "entity-1",
        "v-1",
        breakingChange,
        authorCtx
      );

      expect(result.success).toBe(true);
      if (result.success) {
        expect(result.data.success).toBe(true);
        expect(result.data.pr).toBeDefined();
        expect(result.data.pr!.branchName).toBe("schema/transaction/v3");
      }
    });

    it("pushes directly for non-breaking change when prReviewMode is BREAKING_ONLY", async () => {
      vi.mocked(prisma.gitConfig.findFirst).mockResolvedValue({
        id: "gc-1",
        basePath: "schemas/",
        enabled: true,
        prReviewMode: "BREAKING_ONLY",
        repositoryUrl: "https://github.com/org/repo",
      } as never);
      vi.mocked(prisma.entity.findUnique).mockResolvedValue(
        mockEntity as never
      );
      vi.mocked(prisma.gitConfig.update).mockResolvedValue({} as never);

      const result = await exportWithReview(
        "entity-1",
        "v-1",
        nonBreakingChange,
        authorCtx
      );

      expect(result.success).toBe(true);
      if (result.success) {
        expect(result.data.success).toBe(true);
        expect(result.data.pr).toBeUndefined();
      }
      // Should NOT create a PR
      expect(vi.mocked(prisma.gitPullRequest.create)).not.toHaveBeenCalled();
    });

    it("always creates PR when prReviewMode is ALWAYS", async () => {
      vi.mocked(prisma.gitConfig.findFirst).mockResolvedValue({
        id: "gc-1",
        basePath: "schemas/",
        enabled: true,
        prReviewMode: "ALWAYS",
        repositoryUrl: "https://github.com/org/repo",
      } as never);
      vi.mocked(prisma.entity.findUnique).mockResolvedValue(
        mockEntity as never
      );
      vi.mocked(prisma.gitPullRequest.create).mockResolvedValue({
        id: "pr-1",
        entityId: "entity-1",
        versionId: "v-1",
        prUrl: "https://github.com/org/repo/pull/10",
        prNumber: 10,
        branchName: "schema/transaction/v3",
        status: "OPEN",
        createdAt: new Date(),
        updatedAt: new Date(),
      } as never);
      vi.mocked(prisma.gitConfig.update).mockResolvedValue({} as never);

      const result = await exportWithReview(
        "entity-1",
        "v-1",
        nonBreakingChange,
        authorCtx
      );

      expect(result.success).toBe(true);
      if (result.success) {
        expect(result.data.pr).toBeDefined();
      }
      expect(vi.mocked(prisma.gitPullRequest.create)).toHaveBeenCalled();
    });

    it("never creates PR when prReviewMode is NEVER", async () => {
      vi.mocked(prisma.gitConfig.findFirst).mockResolvedValue({
        id: "gc-1",
        basePath: "schemas/",
        enabled: true,
        prReviewMode: "NEVER",
        repositoryUrl: "https://github.com/org/repo",
      } as never);
      vi.mocked(prisma.entity.findUnique).mockResolvedValue(
        mockEntity as never
      );
      vi.mocked(prisma.gitConfig.update).mockResolvedValue({} as never);

      const result = await exportWithReview(
        "entity-1",
        "v-1",
        breakingChange,
        authorCtx
      );

      expect(result.success).toBe(true);
      if (result.success) {
        expect(result.data.pr).toBeUndefined();
      }
      expect(vi.mocked(prisma.gitPullRequest.create)).not.toHaveBeenCalled();
    });

    it("stores PR record in git_pull_requests table", async () => {
      vi.mocked(prisma.gitConfig.findFirst).mockResolvedValue({
        id: "gc-1",
        basePath: "schemas/",
        enabled: true,
        prReviewMode: "ALWAYS",
        repositoryUrl: "https://github.com/org/repo",
      } as never);
      vi.mocked(prisma.entity.findUnique).mockResolvedValue(
        mockEntity as never
      );
      vi.mocked(prisma.gitPullRequest.create).mockResolvedValue({
        id: "pr-1",
        entityId: "entity-1",
        versionId: "v-1",
        prUrl: "https://github.com/org/repo/pull/99",
        prNumber: 99,
        branchName: "schema/transaction/v3",
        status: "OPEN",
        createdAt: new Date(),
        updatedAt: new Date(),
      } as never);
      vi.mocked(prisma.gitConfig.update).mockResolvedValue({} as never);

      await exportWithReview("entity-1", "v-1", breakingChange, authorCtx);

      expect(vi.mocked(prisma.gitPullRequest.create)).toHaveBeenCalledWith(
        expect.objectContaining({
          data: expect.objectContaining({
            entityId: "entity-1",
            versionId: "v-1",
            status: "OPEN",
          }),
        })
      );
    });

    it("returns NOT_CONFIGURED when Git is not enabled", async () => {
      vi.mocked(prisma.gitConfig.findFirst).mockResolvedValue(null);

      const result = await exportWithReview(
        "entity-1",
        "v-1",
        breakingChange,
        authorCtx
      );

      expect(result.success).toBe(false);
      if (!result.success) {
        expect(result.error.code).toBe("NOT_CONFIGURED");
      }
    });

    it("logs PR creation via withAudit", async () => {
      vi.mocked(prisma.gitConfig.findFirst).mockResolvedValue({
        id: "gc-1",
        basePath: "schemas/",
        enabled: true,
        prReviewMode: "ALWAYS",
        repositoryUrl: "https://github.com/org/repo",
      } as never);
      vi.mocked(prisma.entity.findUnique).mockResolvedValue(
        mockEntity as never
      );
      vi.mocked(prisma.gitPullRequest.create).mockResolvedValue({
        id: "pr-1",
        entityId: "entity-1",
        versionId: "v-1",
        prUrl: "https://github.com/org/repo/pull/1",
        prNumber: 1,
        branchName: "schema/transaction/v3",
        status: "OPEN",
        createdAt: new Date(),
        updatedAt: new Date(),
      } as never);
      vi.mocked(prisma.gitConfig.update).mockResolvedValue({} as never);

      await exportWithReview("entity-1", "v-1", breakingChange, authorCtx);

      expect(vi.mocked(prisma.auditLog.create)).toHaveBeenCalled();
    });
  });

  describe("syncPrStatus", () => {
    it("returns current PR status", async () => {
      vi.mocked(prisma.gitPullRequest.findUnique).mockResolvedValue({
        id: "pr-1",
        entityId: "entity-1",
        versionId: "v-1",
        prUrl: "https://github.com/org/repo/pull/42",
        prNumber: 42,
        branchName: "schema/transaction/v3",
        status: "OPEN",
        createdAt: new Date(),
        updatedAt: new Date(),
      } as never);

      const result = await syncPrStatus("pr-1", authorCtx);

      expect(result.success).toBe(true);
      if (result.success) {
        expect(result.data.status).toBe("OPEN");
      }
    });

    it("returns NOT_FOUND for missing PR", async () => {
      vi.mocked(prisma.gitPullRequest.findUnique).mockResolvedValue(null);

      const result = await syncPrStatus("pr-missing", authorCtx);

      expect(result.success).toBe(false);
      if (!result.success) {
        expect(result.error.code).toBe("NOT_FOUND");
      }
    });
  });

  describe("getPrHistory", () => {
    it("returns PRs ordered by createdAt desc", async () => {
      const prs = [
        {
          id: "pr-2",
          entityId: "entity-1",
          prNumber: 43,
          status: "OPEN",
          createdAt: new Date("2024-02-01"),
        },
        {
          id: "pr-1",
          entityId: "entity-1",
          prNumber: 42,
          status: "MERGED",
          createdAt: new Date("2024-01-01"),
        },
      ];
      vi.mocked(prisma.gitPullRequest.findMany).mockResolvedValue(
        prs as never
      );

      const result = await getPrHistory("entity-1", authorCtx);

      expect(result.success).toBe(true);
      if (result.success) {
        expect(result.data).toHaveLength(2);
        expect(result.data[0].id).toBe("pr-2"); // newer first
      }

      expect(vi.mocked(prisma.gitPullRequest.findMany)).toHaveBeenCalledWith({
        where: { entityId: "entity-1" },
        orderBy: { createdAt: "desc" },
      });
    });
  });

  describe("getLatestPr", () => {
    it("returns most recent PR", async () => {
      vi.mocked(prisma.gitPullRequest.findFirst).mockResolvedValue({
        id: "pr-latest",
        entityId: "entity-1",
        prNumber: 50,
        status: "OPEN",
        createdAt: new Date(),
      } as never);

      const result = await getLatestPr("entity-1", authorCtx);

      expect(result.success).toBe(true);
      if (result.success) {
        expect(result.data).not.toBeNull();
        expect(result.data!.id).toBe("pr-latest");
      }
    });

    it("returns null when no PRs exist", async () => {
      vi.mocked(prisma.gitPullRequest.findFirst).mockResolvedValue(null);

      const result = await getLatestPr("entity-1", authorCtx);

      expect(result.success).toBe(true);
      if (result.success) {
        expect(result.data).toBeNull();
      }
    });
  });
});
