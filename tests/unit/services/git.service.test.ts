import { describe, it, expect, vi, beforeEach } from "vitest";

// ---------------------------------------------------------------------------
// Mock Prisma
// ---------------------------------------------------------------------------
vi.mock("@/lib/db", () => ({
  prisma: {
    gitConfig: {
      findFirst: vi.fn(),
      findUnique: vi.fn(),
      create: vi.fn(),
      update: vi.fn(),
    },
    entity: {
      findUnique: vi.fn(),
      findMany: vi.fn(),
    },
    auditLog: {
      create: vi.fn().mockResolvedValue({ id: "audit-1" }),
    },
  },
}));

import {
  buildExportFilePath,
  buildCommitMessage,
  buildBulkCommitMessage,
  slugify,
  generateExportFiles,
  configureRepository,
  testConnection,
  exportEntity,
  exportAll,
  enableExport,
  disableExport,
  getConfig,
} from "@/services/git.service";
import { prisma } from "@/lib/db";
import type { ServiceContext } from "@/types/service-context";
import type { TargetOutput } from "@/lib/emission/emission.types";
import { assign } from "../../helpers/access-mocks";

const adminCtx: ServiceContext = {
  userId: "user-admin",
  userRole: "ADMIN", assignments: [assign.global()],
  prisma: prisma as unknown as ServiceContext["prisma"],
};

const authorCtx: ServiceContext = {
  userId: "user-author",
  userRole: "AUTHOR", assignments: [assign.tenant("AUTHOR", "tenant-1")],
  prisma: prisma as unknown as ServiceContext["prisma"],
};

// ---------------------------------------------------------------------------
// Pure function tests
// ---------------------------------------------------------------------------

describe("Git Service — Pure Helpers", () => {
  describe("buildExportFilePath", () => {
    it("returns correct superschema path", () => {
      const path = buildExportFilePath(
        "schemas/",
        "payments",
        "transaction",
        "superschema"
      );
      expect(path).toBe("schemas/payments/transaction.superschema.json");
    });

    it("returns correct BigQuery DDL path", () => {
      const path = buildExportFilePath(
        "schemas/",
        "payments",
        "transaction",
        "bigquery"
      );
      expect(path).toBe("schemas/payments/transaction.bq.sql");
    });

    it("returns correct Avro schema path", () => {
      const path = buildExportFilePath(
        "schemas/",
        "payments",
        "transaction",
        "avro"
      );
      expect(path).toBe("schemas/payments/transaction.avro.json");
    });

    it("returns correct OpenAPI schema path", () => {
      const path = buildExportFilePath(
        "schemas/",
        "payments",
        "transaction",
        "openapi"
      );
      expect(path).toBe("schemas/payments/transaction.openapi.yaml");
    });

    it("normalizes basePath without trailing slash", () => {
      const path = buildExportFilePath(
        "schemas",
        "payments",
        "transaction",
        "superschema"
      );
      expect(path).toBe("schemas/payments/transaction.superschema.json");
    });

    it("lowercases and slugifies domain and entity names", () => {
      const path = buildExportFilePath(
        "schemas/",
        "My Domain",
        "My Entity",
        "superschema"
      );
      expect(path).toBe("schemas/my-domain/my-entity.superschema.json");
    });

    it("handles deeply nested basePath", () => {
      const path = buildExportFilePath(
        "data/schemas/v2/",
        "core",
        "user",
        "bigquery"
      );
      expect(path).toBe("data/schemas/v2/core/user.bq.sql");
    });
  });

  describe("buildCommitMessage", () => {
    it("returns correctly formatted message", () => {
      const msg = buildCommitMessage("Transaction", 3, "added amount field");
      expect(msg).toBe("Update Transaction v3 — added amount field");
    });

    it("includes entity name and version", () => {
      const msg = buildCommitMessage("User", 1, "initial schema");
      expect(msg).toContain("User");
      expect(msg).toContain("v1");
    });
  });

  describe("buildBulkCommitMessage", () => {
    it("returns correctly formatted message", () => {
      const msg = buildBulkCommitMessage(5);
      expect(msg).toBe("Bulk export — 5 entities");
    });
  });

  describe("slugify", () => {
    it("lowercases and replaces spaces with hyphens", () => {
      expect(slugify("My Entity Name")).toBe("my-entity-name");
    });

    it("removes special characters", () => {
      expect(slugify("Test@Entity#1")).toBe("test-entity-1");
    });

    it("trims leading/trailing hyphens", () => {
      expect(slugify("--test--")).toBe("test");
    });
  });

  describe("generateExportFiles", () => {
    it("always includes superschema.json", () => {
      const files = generateExportFiles(
        "schemas/",
        "Payments",
        "Transaction",
        { name: "Transaction" },
        {}
      );

      expect(files.length).toBe(1);
      expect(files[0].path).toContain(".superschema.json");
      expect(JSON.parse(files[0].content)).toEqual({ name: "Transaction" });
    });

    it("includes BigQuery output when present", () => {
      const emittedOutputs: Record<string, TargetOutput> = {
        bigquery: {
          name: "bigquery",
          targetFormat: "bigquery-ddl",
          output: "CREATE TABLE t (id INT64);",
          isValid: true,
          validationStatus: "VALID",
          warnings: [],
          errors: [],
        },
      };

      const files = generateExportFiles(
        "schemas/",
        "Payments",
        "Transaction",
        { name: "Transaction" },
        emittedOutputs
      );

      expect(files.length).toBe(2);
      const bqFile = files.find((f) => f.path.endsWith(".bq.sql"));
      expect(bqFile).toBeDefined();
      expect(bqFile!.content).toBe("CREATE TABLE t (id INT64);");
    });

    it("includes Avro output when present", () => {
      const emittedOutputs: Record<string, TargetOutput> = {
        avro: {
          name: "avro",
          targetFormat: "avro-schema",
          output: '{"type":"record","name":"Test"}',
          isValid: true,
          validationStatus: "VALID",
          warnings: [],
          errors: [],
        },
      };

      const files = generateExportFiles(
        "schemas/",
        "Core",
        "User",
        { name: "User" },
        emittedOutputs
      );

      expect(files.length).toBe(2);
      const avroFile = files.find((f) => f.path.endsWith(".avro.json"));
      expect(avroFile).toBeDefined();
    });

    it("includes OpenAPI output when present", () => {
      const emittedOutputs: Record<string, TargetOutput> = {
        openapi: {
          name: "openapi",
          targetFormat: "openapi-3.1",
          output: "openapi: 3.1.0",
          isValid: true,
          validationStatus: "VALID",
          warnings: [],
          errors: [],
        },
      };

      const files = generateExportFiles(
        "schemas/",
        "Core",
        "User",
        { name: "User" },
        emittedOutputs
      );

      expect(files.length).toBe(2);
      const oaFile = files.find((f) => f.path.endsWith(".openapi.yaml"));
      expect(oaFile).toBeDefined();
    });

    it("includes all formats when all emitters are present", () => {
      const emittedOutputs: Record<string, TargetOutput> = {
        bigquery: {
          name: "bigquery",
          targetFormat: "bigquery-ddl",
          output: "DDL",
          isValid: true,
          validationStatus: "VALID",
          warnings: [],
          errors: [],
        },
        avro: {
          name: "avro",
          targetFormat: "avro-schema",
          output: "AVRO",
          isValid: true,
          validationStatus: "VALID",
          warnings: [],
          errors: [],
        },
        openapi: {
          name: "openapi",
          targetFormat: "openapi-3.1",
          output: "OPENAPI",
          isValid: true,
          validationStatus: "VALID",
          warnings: [],
          errors: [],
        },
      };

      const files = generateExportFiles(
        "schemas/",
        "Core",
        "User",
        { name: "User" },
        emittedOutputs
      );

      // 1 superschema + 3 emitter outputs
      expect(files.length).toBe(4);
    });

    it("file structure matches architecture spec paths", () => {
      const files = generateExportFiles(
        "schemas/",
        "Payments",
        "Transaction",
        { name: "Transaction" },
        {
          bigquery: {
            name: "bigquery",
            targetFormat: "bigquery-ddl",
            output: "DDL",
            isValid: true,
            validationStatus: "VALID",
            warnings: [],
            errors: [],
          },
        }
      );

      expect(files[0].path).toBe(
        "schemas/payments/transaction.superschema.json"
      );
      expect(files[1].path).toBe("schemas/payments/transaction.bq.sql");
    });
  });
});

// ---------------------------------------------------------------------------
// Service function tests (mocked Prisma)
// ---------------------------------------------------------------------------

describe("Git Service — Service Functions", () => {
  beforeEach(() => {
    vi.clearAllMocks();
  });

  describe("configureRepository", () => {
    it("creates git_config record on valid input", async () => {
      vi.mocked(prisma.gitConfig.findFirst).mockResolvedValue(null);
      vi.mocked(prisma.gitConfig.create).mockResolvedValue({
        id: "gc-1",
        repositoryUrl: "https://github.com/org/repo",
        branch: "main",
        basePath: "schemas/",
        authMethod: "PERSONAL_ACCESS_TOKEN",
        authCredential: "encrypted-token",
        prReviewMode: "BREAKING_ONLY",
        enabled: false,
        lastSyncAt: null,
        lastSyncStatus: null,
        createdBy: "user-admin",
        createdAt: new Date(),
        updatedAt: new Date(),
      } as never);

      const result = await configureRepository(
        {
          repositoryUrl: "https://github.com/org/repo",
          branch: "main",
          basePath: "schemas/",
          authMethod: "PERSONAL_ACCESS_TOKEN",
          authCredential: "my-token",
          prReviewMode: "BREAKING_ONLY",
        },
        adminCtx
      );

      expect(result.success).toBe(true);
      if (result.success) {
        expect(result.data.repositoryUrl).toBe("https://github.com/org/repo");
        expect(result.data.enabled).toBe(false);
      }
    });

    it("rejects non-Admin users", async () => {
      const result = await configureRepository(
        {
          repositoryUrl: "https://github.com/org/repo",
          authMethod: "PERSONAL_ACCESS_TOKEN",
          authCredential: "token",
          branch: "main",
          basePath: "schemas/",
          prReviewMode: "BREAKING_ONLY",
        },
        authorCtx
      );

      expect(result.success).toBe(false);
      if (!result.success) {
        expect(result.error.code).toBe("FORBIDDEN");
      }
    });

    it("returns validation error for empty repo URL", async () => {
      const result = await configureRepository(
        {
          repositoryUrl: "",
          authMethod: "PERSONAL_ACCESS_TOKEN",
          authCredential: "token",
          branch: "main",
          basePath: "schemas/",
          prReviewMode: "BREAKING_ONLY",
        },
        adminCtx
      );

      expect(result.success).toBe(false);
      if (!result.success) {
        expect(result.error.code).toBe("VALIDATION_ERROR");
      }
    });

    it("upserts when config already exists", async () => {
      vi.mocked(prisma.gitConfig.findFirst).mockResolvedValue({
        id: "gc-existing",
      } as never);
      vi.mocked(prisma.gitConfig.update).mockResolvedValue({
        id: "gc-existing",
        repositoryUrl: "https://github.com/org/new-repo",
        branch: "develop",
        basePath: "schemas/",
        authMethod: "SSH_KEY",
        authCredential: "encrypted",
        prReviewMode: "ALWAYS",
        enabled: false,
        lastSyncAt: null,
        lastSyncStatus: null,
        createdBy: "user-admin",
        createdAt: new Date(),
        updatedAt: new Date(),
      } as never);

      const result = await configureRepository(
        {
          repositoryUrl: "https://github.com/org/new-repo",
          branch: "develop",
          basePath: "schemas/",
          authMethod: "SSH_KEY",
          authCredential: "ssh-key",
          prReviewMode: "ALWAYS",
        },
        adminCtx
      );

      expect(result.success).toBe(true);
      expect(vi.mocked(prisma.gitConfig.update)).toHaveBeenCalled();
    });

    it("logs operation via withAudit", async () => {
      vi.mocked(prisma.gitConfig.findFirst).mockResolvedValue(null);
      vi.mocked(prisma.gitConfig.create).mockResolvedValue({
        id: "gc-1",
        repositoryUrl: "https://github.com/org/repo",
        branch: "main",
        basePath: "schemas/",
        authMethod: "PERSONAL_ACCESS_TOKEN",
        authCredential: "encrypted",
        prReviewMode: "BREAKING_ONLY",
        enabled: false,
        lastSyncAt: null,
        lastSyncStatus: null,
        createdBy: "user-admin",
        createdAt: new Date(),
        updatedAt: new Date(),
      } as never);

      await configureRepository(
        {
          repositoryUrl: "https://github.com/org/repo",
          authMethod: "PERSONAL_ACCESS_TOKEN",
          authCredential: "token",
          branch: "main",
          basePath: "schemas/",
          prReviewMode: "BREAKING_ONLY",
        },
        adminCtx
      );

      // withAudit creates an audit log entry
      expect(vi.mocked(prisma.auditLog.create)).toHaveBeenCalled();
    });
  });

  describe("testConnection", () => {
    it("returns connected: true for valid config", async () => {
      vi.mocked(prisma.gitConfig.findUnique).mockResolvedValue({
        id: "gc-1",
        repositoryUrl: "https://github.com/org/repo",
        authCredential: "token",
      } as never);
      vi.mocked(prisma.gitConfig.update).mockResolvedValue({} as never);

      const result = await testConnection("gc-1", adminCtx);

      expect(result.success).toBe(true);
      if (result.success) {
        expect(result.data.connected).toBe(true);
      }
    });

    it("returns connected: false for missing credentials", async () => {
      vi.mocked(prisma.gitConfig.findUnique).mockResolvedValue({
        id: "gc-1",
        repositoryUrl: "",
        authCredential: "",
      } as never);

      const result = await testConnection("gc-1", adminCtx);

      expect(result.success).toBe(true);
      if (result.success) {
        expect(result.data.connected).toBe(false);
        expect(result.data.error).toBeDefined();
      }
    });

    it("returns NOT_FOUND for missing config", async () => {
      vi.mocked(prisma.gitConfig.findUnique).mockResolvedValue(null);

      const result = await testConnection("gc-missing", adminCtx);

      expect(result.success).toBe(false);
      if (!result.success) {
        expect(result.error.code).toBe("NOT_FOUND");
      }
    });

    it("rejects non-Admin users", async () => {
      const result = await testConnection("gc-1", authorCtx);

      expect(result.success).toBe(false);
      if (!result.success) {
        expect(result.error.code).toBe("FORBIDDEN");
      }
    });
  });

  describe("exportEntity", () => {
    const mockEntity = {
      id: "entity-1",
      name: "Transaction",
      description: "A transaction",
      status: "ACTIVE",
      metadata: { currentVersion: 2, emittedOutputs: {} },
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

    it("generates correct file count for entity with no emitters", async () => {
      vi.mocked(prisma.gitConfig.findFirst).mockResolvedValue({
        id: "gc-1",
        basePath: "schemas/",
        enabled: true,
      } as never);
      vi.mocked(prisma.entity.findUnique).mockResolvedValue(
        mockEntity as never
      );
      vi.mocked(prisma.gitConfig.update).mockResolvedValue({} as never);

      const result = await exportEntity("entity-1", authorCtx);

      expect(result.success).toBe(true);
      if (result.success) {
        expect(result.data.success).toBe(true);
        expect(result.data.filesExported).toBe(1); // superschema only
      }
    });

    it("returns NOT_CONFIGURED when Git is not enabled", async () => {
      vi.mocked(prisma.gitConfig.findFirst).mockResolvedValue(null);

      const result = await exportEntity("entity-1", authorCtx);

      expect(result.success).toBe(false);
      if (!result.success) {
        expect(result.error.code).toBe("NOT_CONFIGURED");
      }
    });

    it("returns NOT_FOUND for missing entity", async () => {
      vi.mocked(prisma.gitConfig.findFirst).mockResolvedValue({
        id: "gc-1",
        enabled: true,
      } as never);
      vi.mocked(prisma.entity.findUnique).mockResolvedValue(null);

      const result = await exportEntity("entity-missing", authorCtx);

      expect(result.success).toBe(false);
      if (!result.success) {
        expect(result.error.code).toBe("NOT_FOUND");
      }
    });

    it("updates lastSyncAt and lastSyncStatus on success", async () => {
      vi.mocked(prisma.gitConfig.findFirst).mockResolvedValue({
        id: "gc-1",
        basePath: "schemas/",
        enabled: true,
      } as never);
      vi.mocked(prisma.entity.findUnique).mockResolvedValue(
        mockEntity as never
      );
      vi.mocked(prisma.gitConfig.update).mockResolvedValue({} as never);

      await exportEntity("entity-1", authorCtx);

      expect(vi.mocked(prisma.gitConfig.update)).toHaveBeenCalledWith(
        expect.objectContaining({
          where: { id: "gc-1" },
          data: expect.objectContaining({
            lastSyncStatus: "SUCCESS",
          }),
        })
      );
    });

    it("does NOT roll back emission on Git failure", async () => {
      vi.mocked(prisma.gitConfig.findFirst).mockResolvedValue({
        id: "gc-1",
        basePath: "schemas/",
        enabled: true,
      } as never);
      // Simulate entity fetch succeeding but gitConfig.update throwing
      vi.mocked(prisma.entity.findUnique).mockResolvedValue(
        mockEntity as never
      );
      // First call in withAudit will throw
      vi.mocked(prisma.auditLog.create).mockRejectedValueOnce(
        new Error("Git push failed")
      );
      // The catch block updates lastSyncStatus to FAILED
      vi.mocked(prisma.gitConfig.update).mockResolvedValue({} as never);

      const result = await exportEntity("entity-1", authorCtx);

      // It should return a result (not throw) even on failure
      expect(result).toBeDefined();
    });

    it("logs export via withAudit", async () => {
      vi.mocked(prisma.gitConfig.findFirst).mockResolvedValue({
        id: "gc-1",
        basePath: "schemas/",
        enabled: true,
      } as never);
      vi.mocked(prisma.entity.findUnique).mockResolvedValue(
        mockEntity as never
      );
      vi.mocked(prisma.gitConfig.update).mockResolvedValue({} as never);

      await exportEntity("entity-1", authorCtx);

      expect(vi.mocked(prisma.auditLog.create)).toHaveBeenCalled();
    });
  });

  describe("exportAll", () => {
    it("exports multiple entities in a single commit", async () => {
      vi.mocked(prisma.gitConfig.findFirst).mockResolvedValue({
        id: "gc-1",
        basePath: "schemas/",
        enabled: true,
      } as never);
      vi.mocked(prisma.entity.findMany).mockResolvedValue([
        {
          id: "e1",
          name: "User",
          description: "User entity",
          status: "ACTIVE",
          metadata: {},
          domain: { name: "Core" },
          fields: [],
        },
        {
          id: "e2",
          name: "Order",
          description: "Order entity",
          status: "ACTIVE",
          metadata: {},
          domain: { name: "Commerce" },
          fields: [],
        },
      ] as never);
      vi.mocked(prisma.gitConfig.update).mockResolvedValue({} as never);

      const result = await exportAll(adminCtx);

      expect(result.success).toBe(true);
      if (result.success) {
        expect(result.data.success).toBe(true);
        expect(result.data.filesExported).toBe(2); // 1 superschema each
      }
    });

    it("rejects non-Admin users", async () => {
      const result = await exportAll(authorCtx);

      expect(result.success).toBe(false);
      if (!result.success) {
        expect(result.error.code).toBe("FORBIDDEN");
      }
    });
  });

  describe("enableExport", () => {
    it("sets enabled to true", async () => {
      vi.mocked(prisma.gitConfig.findUnique).mockResolvedValue({
        id: "gc-1",
      } as never);
      vi.mocked(prisma.gitConfig.update).mockResolvedValue({
        id: "gc-1",
        repositoryUrl: "https://github.com/org/repo",
        branch: "main",
        basePath: "schemas/",
        authMethod: "PERSONAL_ACCESS_TOKEN",
        prReviewMode: "BREAKING_ONLY",
        enabled: true,
        lastSyncAt: null,
        lastSyncStatus: null,
        createdAt: new Date(),
        updatedAt: new Date(),
      } as never);

      const result = await enableExport("gc-1", adminCtx);

      expect(result.success).toBe(true);
      if (result.success) {
        expect(result.data.enabled).toBe(true);
      }
    });

    it("rejects non-Admin users", async () => {
      const result = await enableExport("gc-1", authorCtx);

      expect(result.success).toBe(false);
      if (!result.success) {
        expect(result.error.code).toBe("FORBIDDEN");
      }
    });
  });

  describe("disableExport", () => {
    it("sets enabled to false", async () => {
      vi.mocked(prisma.gitConfig.findUnique).mockResolvedValue({
        id: "gc-1",
      } as never);
      vi.mocked(prisma.gitConfig.update).mockResolvedValue({
        id: "gc-1",
        repositoryUrl: "https://github.com/org/repo",
        branch: "main",
        basePath: "schemas/",
        authMethod: "PERSONAL_ACCESS_TOKEN",
        prReviewMode: "BREAKING_ONLY",
        enabled: false,
        lastSyncAt: null,
        lastSyncStatus: null,
        createdAt: new Date(),
        updatedAt: new Date(),
      } as never);

      const result = await disableExport("gc-1", adminCtx);

      expect(result.success).toBe(true);
      if (result.success) {
        expect(result.data.enabled).toBe(false);
      }
    });
  });

  describe("getConfig", () => {
    it("returns config with credential redacted", async () => {
      vi.mocked(prisma.gitConfig.findFirst).mockResolvedValue({
        id: "gc-1",
        repositoryUrl: "https://github.com/org/repo",
        branch: "main",
        basePath: "schemas/",
        authMethod: "PERSONAL_ACCESS_TOKEN",
        authCredential: "secret-token",
        prReviewMode: "BREAKING_ONLY",
        enabled: true,
        lastSyncAt: new Date(),
        lastSyncStatus: "SUCCESS",
        createdAt: new Date(),
        updatedAt: new Date(),
      } as never);

      const result = await getConfig(adminCtx);

      expect(result.success).toBe(true);
      if (result.success && result.data) {
        // authCredential should NOT be in the response
        expect("authCredential" in result.data).toBe(false);
        expect(result.data.repositoryUrl).toBe("https://github.com/org/repo");
      }
    });

    it("returns null when no config exists", async () => {
      vi.mocked(prisma.gitConfig.findFirst).mockResolvedValue(null);

      const result = await getConfig(adminCtx);

      expect(result.success).toBe(true);
      if (result.success) {
        expect(result.data).toBeNull();
      }
    });

    it("rejects non-Admin users", async () => {
      const result = await getConfig(authorCtx);

      expect(result.success).toBe(false);
      if (!result.success) {
        expect(result.error.code).toBe("FORBIDDEN");
      }
    });
  });
});
