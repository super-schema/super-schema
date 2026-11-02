import { describe, it, expect, vi, beforeEach, afterEach } from "vitest";

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

const TEST_SECRETS_KEY = Buffer.alloc(32, 7).toString("base64");

/** The last audit_log row the service wrote: its action and the state it recorded. */
function lastAuditEntry(): { action: string; afterState: unknown; beforeState: unknown } {
  const calls = vi.mocked(prisma.auditLog.create).mock.calls;
  return (calls[calls.length - 1][0] as unknown as { data: { action: string; afterState: unknown; beforeState: unknown } }).data;
}

describe("Git Service — Service Functions", () => {
  beforeEach(() => {
    vi.clearAllMocks();
    // The credential is sealed on the way in: a key is needed (SECRETS_ENCRYPTION_KEY, or the session secret).
    vi.stubEnv("SECRETS_ENCRYPTION_KEY", TEST_SECRETS_KEY);
  });

  afterEach(() => {
    vi.unstubAllEnvs();
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

    it("stores the credential sealed, never as it was typed", async () => {
      vi.mocked(prisma.gitConfig.findFirst).mockResolvedValue(null);
      vi.mocked(prisma.gitConfig.create).mockImplementationOnce((async ({ data }: { data: Record<string, unknown> }) => ({
        id: "gc-1",
        ...data,
        lastSyncAt: null,
        lastSyncStatus: null,
        createdAt: new Date(),
        updatedAt: new Date(),
      })) as never);

      await configureRepository(
        {
          repositoryUrl: "https://github.com/org/repo",
          authMethod: "PERSONAL_ACCESS_TOKEN",
          authCredential: "ghp_typed_token_for_storage_test",
          branch: "main",
          basePath: "schemas/",
          prReviewMode: "BREAKING_ONLY",
        },
        adminCtx
      );

      const stored = vi.mocked(prisma.gitConfig.create).mock.calls[0][0].data.authCredential;
      expect(stored).toMatch(/^enc:v1:/);
      expect(stored).not.toContain("ghp_typed_token_for_storage_test");
    });

    it("the audit entry of a configuration holds no credential, sealed or plain", async () => {
      vi.mocked(prisma.gitConfig.findFirst).mockResolvedValue(null);
      vi.mocked(prisma.gitConfig.create).mockImplementationOnce((async ({ data }: { data: Record<string, unknown> }) => ({
        id: "gc-1",
        ...data,
        lastSyncAt: null,
        lastSyncStatus: null,
        createdAt: new Date(),
        updatedAt: new Date(),
      })) as never);

      const result = await configureRepository(
        {
          repositoryUrl: "https://github.com/org/repo",
          authMethod: "PERSONAL_ACCESS_TOKEN",
          authCredential: "ghp_plain_token_for_audit_test",
          branch: "main",
          basePath: "schemas/",
          prReviewMode: "BREAKING_ONLY",
        },
        adminCtx
      );

      expect(result.success).toBe(true);
      const sealed = vi.mocked(prisma.gitConfig.create).mock.calls[0][0].data.authCredential;
      const entry = lastAuditEntry();
      expect(entry.action).toBe("CONFIGURE_GIT");
      expect(entry.afterState).toMatchObject({ id: "gc-1", repositoryUrl: "https://github.com/org/repo" });
      expect(entry.afterState).not.toHaveProperty("authCredential");
      expect(JSON.stringify(entry)).not.toContain("ghp_plain_token_for_audit_test");
      expect(JSON.stringify(entry)).not.toContain(sealed);
    });

    it("the audit entry of an update holds no credential either", async () => {
      vi.mocked(prisma.gitConfig.findFirst).mockResolvedValue({ id: "gc-existing" } as never);
      vi.mocked(prisma.gitConfig.update).mockImplementationOnce((async ({ data }: { data: Record<string, unknown> }) => ({
        id: "gc-existing",
        repositoryUrl: "https://github.com/org/new-repo",
        branch: "develop",
        basePath: "schemas/",
        authMethod: "SSH_KEY",
        prReviewMode: "ALWAYS",
        enabled: false,
        lastSyncAt: null,
        lastSyncStatus: null,
        createdBy: "user-admin",
        createdAt: new Date(),
        updatedAt: new Date(),
        ...data,
      })) as never);

      await configureRepository(
        {
          repositoryUrl: "https://github.com/org/new-repo",
          authMethod: "SSH_KEY",
          authCredential: "-----BEGIN OPENSSH PRIVATE KEY----- plain-key-for-update-test",
          branch: "develop",
          basePath: "schemas/",
          prReviewMode: "ALWAYS",
        },
        adminCtx
      );

      const entry = lastAuditEntry();
      expect(entry.action).toBe("CONFIGURE_GIT");
      expect(entry.afterState).not.toHaveProperty("authCredential");
      expect(JSON.stringify(entry)).not.toContain("plain-key-for-update-test");
    });

    it("refuses a repository URL that carries a token, in any scheme, and names the credential field: nothing is stored or audited", async () => {
      for (const repositoryUrl of [
        "https://x-access-token:ghp_in_the_url_only@github.com/org/repo",
        "https://ghp_in_the_url_only@github.com/org/repo",
        "git+https://ghp_in_the_url_only@github.com/org/repo.git",
        "ssh://git:ghp_in_the_url_only@github.com/org/repo.git",
      ]) {
        const result = await configureRepository(
          {
            repositoryUrl,
            authMethod: "PERSONAL_ACCESS_TOKEN",
            authCredential: "ghp_in_the_url_only",
            branch: "main",
            basePath: "schemas/",
            prReviewMode: "BREAKING_ONLY",
          },
          adminCtx
        );

        expect(result.success, repositoryUrl).toBe(false);
        if (!result.success) {
          expect(result.error.code).toBe("VALIDATION_ERROR");
          expect(result.error.message).toContain("credential field");
          expect(JSON.stringify(result.error)).not.toContain("ghp_in_the_url_only");
        }
      }
      expect(vi.mocked(prisma.gitConfig.create)).not.toHaveBeenCalled();
      expect(vi.mocked(prisma.gitConfig.update)).not.toHaveBeenCalled();
      expect(vi.mocked(prisma.auditLog.create)).not.toHaveBeenCalled();
    });

    it("accepts a repository address without a token: https without user information, an ssh account, the scp form", async () => {
      for (const repositoryUrl of [
        "https://github.com/org/repo",
        "ssh://git@github.com/org/repo.git",
        "git+ssh://git@github.com/org/repo.git",
        "git@github.com:org/repo.git",
      ]) {
        vi.mocked(prisma.gitConfig.findFirst).mockResolvedValueOnce(null);
        vi.mocked(prisma.gitConfig.create).mockResolvedValueOnce({
          id: "gc-1",
          repositoryUrl,
          branch: "main",
          basePath: "schemas/",
          authMethod: "PERSONAL_ACCESS_TOKEN",
          authCredential: "enc:v1:stored",
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
            repositoryUrl,
            authMethod: "PERSONAL_ACCESS_TOKEN",
            authCredential: "ghp_plain_for_address_test",
            branch: "main",
            basePath: "schemas/",
            prReviewMode: "BREAKING_ONLY",
          },
          adminCtx
        );

        expect(result.success, repositoryUrl).toBe(true);
      }
    });

    it("with no key at all, saving the configuration is refused with the reason, and nothing is stored or audited", async () => {
      vi.stubEnv("SECRETS_ENCRYPTION_KEY", "");
      vi.stubEnv("AUTH_SECRET", "");
      vi.stubEnv("NEXTAUTH_SECRET", "");

      const result = await configureRepository(
        {
          repositoryUrl: "https://github.com/org/repo",
          authMethod: "PERSONAL_ACCESS_TOKEN",
          authCredential: "ghp_no_key_for_save_test",
          branch: "main",
          basePath: "schemas/",
          prReviewMode: "BREAKING_ONLY",
        },
        adminCtx
      );

      expect(result.success).toBe(false);
      if (!result.success) {
        expect(result.error.code).toBe("INTERNAL_ERROR");
        expect(result.error.message).toContain("SECRETS_ENCRYPTION_KEY");
      }
      expect(vi.mocked(prisma.gitConfig.create)).not.toHaveBeenCalled();
      expect(vi.mocked(prisma.gitConfig.update)).not.toHaveBeenCalled();
      expect(vi.mocked(prisma.auditLog.create)).not.toHaveBeenCalled();
    });
  });

  describe("testConnection", () => {
    it("does not report a connection it did not make: the answer is not verified, and no sync status is written", async () => {
      vi.mocked(prisma.gitConfig.findUnique).mockResolvedValue({
        id: "gc-1",
        repositoryUrl: "https://github.com/org/repo",
        authCredential: "enc:v1:stored",
      } as never);

      const result = await testConnection("gc-1", adminCtx);

      expect(result.success).toBe(true);
      if (result.success) {
        expect(result.data.connected).toBe(false);
        expect(result.data.verified).toBe(false);
        expect(result.data.error).toMatch(/^Not verified/);
      }
      expect(vi.mocked(prisma.gitConfig.update)).not.toHaveBeenCalled();
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

    it("the audit entry holds no credential, even when the row still holds a plain one", async () => {
      vi.mocked(prisma.gitConfig.findUnique).mockResolvedValue({ id: "gc-1" } as never);
      vi.mocked(prisma.gitConfig.update).mockResolvedValue({
        id: "gc-1",
        repositoryUrl: "https://github.com/org/repo",
        branch: "main",
        basePath: "schemas/",
        authMethod: "PERSONAL_ACCESS_TOKEN",
        authCredential: "ghp_plain_row_for_enable_test",
        prReviewMode: "BREAKING_ONLY",
        enabled: true,
        lastSyncAt: null,
        lastSyncStatus: null,
        createdAt: new Date(),
        updatedAt: new Date(),
      } as never);

      await enableExport("gc-1", adminCtx);

      const entry = lastAuditEntry();
      expect(entry.action).toBe("ENABLE_GIT_EXPORT");
      expect(entry.afterState).toMatchObject({ id: "gc-1", enabled: true });
      expect(entry.afterState).not.toHaveProperty("authCredential");
      expect(JSON.stringify(entry)).not.toContain("ghp_plain_row_for_enable_test");
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

    it("the audit entry holds no credential", async () => {
      vi.mocked(prisma.gitConfig.findUnique).mockResolvedValue({ id: "gc-1" } as never);
      vi.mocked(prisma.gitConfig.update).mockResolvedValue({
        id: "gc-1",
        repositoryUrl: "https://github.com/org/repo",
        branch: "main",
        basePath: "schemas/",
        authMethod: "PERSONAL_ACCESS_TOKEN",
        authCredential: "enc:v1:sealed-row-for-disable-test",
        prReviewMode: "BREAKING_ONLY",
        enabled: false,
        lastSyncAt: null,
        lastSyncStatus: null,
        createdAt: new Date(),
        updatedAt: new Date(),
      } as never);

      await disableExport("gc-1", adminCtx);

      const entry = lastAuditEntry();
      expect(entry.action).toBe("DISABLE_GIT_EXPORT");
      expect(entry.afterState).not.toHaveProperty("authCredential");
      expect(JSON.stringify(entry)).not.toContain("enc:v1:sealed-row-for-disable-test");
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
