import { describe, it, expect, vi, beforeEach } from "vitest";
import { Prisma } from "@/generated/prisma/client";

// Mock the db module before importing audit
vi.mock("@/lib/db", () => ({
  prisma: {
    auditLog: {
      create: vi.fn().mockResolvedValue({ id: "mock-audit-id" }),
    },
    user: {
      findUnique: vi.fn().mockResolvedValue({ id: "user-1" }),
    },
  },
}));

import { AuditUserMissingError, recordAuditFailure, withAudit } from "@/lib/audit";
import { prisma } from "@/lib/db";

describe("withAudit", () => {
  beforeEach(() => {
    vi.clearAllMocks();
  });

  it("executes the wrapped function and returns its result", async () => {
    const mockResult = { id: "entity-1", name: "Customer" };

    const result = await withAudit({
      action: "CREATE",
      entityType: "Entity",
      entityId: "entity-1",
      userId: "user-1",
      fn: async () => mockResult,
    });

    expect(result).toEqual(mockResult);
  });

  it("creates an audit_log entry with correct data", async () => {
    const mockResult = { id: "entity-1", name: "Customer" };

    await withAudit({
      action: "CREATE",
      entityType: "Entity",
      entityId: "entity-1",
      userId: "user-1",
      fn: async () => mockResult,
    });

    expect(prisma.auditLog.create).toHaveBeenCalledWith({
      data: {
        action: "CREATE",
        entityType: "Entity",
        entityId: "entity-1",
        userId: "user-1",
        beforeState: Prisma.JsonNull,
        afterState: mockResult,
      },
    });
  });

  it("includes beforeState when provided", async () => {
    const beforeState = { name: "OldName" };
    const afterResult = { id: "entity-1", name: "NewName" };

    await withAudit({
      action: "UPDATE",
      entityType: "Entity",
      entityId: "entity-1",
      userId: "user-1",
      beforeState,
      fn: async () => afterResult,
    });

    expect(prisma.auditLog.create).toHaveBeenCalledWith({
      data: expect.objectContaining({
        action: "UPDATE",
        beforeState,
        afterState: afterResult,
      }),
    });
  });

  it("handles null result (e.g., DELETE operations)", async () => {
    await withAudit({
      action: "DELETE",
      entityType: "Entity",
      entityId: "entity-1",
      userId: "user-1",
      beforeState: { id: "entity-1", name: "Customer" },
      fn: async () => null,
    });

    expect(prisma.auditLog.create).toHaveBeenCalledWith({
      data: expect.objectContaining({
        action: "DELETE",
        afterState: Prisma.JsonNull,
      }),
    });
  });

  it("propagates errors from the wrapped function", async () => {
    await expect(
      withAudit({
        action: "CREATE",
        entityType: "Entity",
        entityId: "entity-1",
        userId: "user-1",
        fn: async () => {
          throw new Error("DB connection failed");
        },
      })
    ).rejects.toThrow("DB connection failed");
  });

  it("fails before the wrapped write when the audit user is missing", async () => {
    vi.mocked(prisma.user.findUnique).mockResolvedValueOnce(null);
    const fn = vi.fn().mockResolvedValue({ id: "entity-1" });

    await expect(
      withAudit({
        action: "CREATE",
        entityType: "Entity",
        entityId: "entity-1",
        userId: "missing-user",
        fn,
      })
    ).rejects.toBeInstanceOf(AuditUserMissingError);

    expect(fn).not.toHaveBeenCalled();
    expect(prisma.auditLog.create).not.toHaveBeenCalled();
  });

  describe("credentials are never written into an audit row", () => {
    const writtenData = () => vi.mocked(prisma.auditLog.create).mock.calls[0][0].data as Record<string, unknown>;

    it("replaces every credential under a credential-looking key, at any depth, and returns the caller its own value", async () => {
      const createdAt = new Date("2026-01-01T00:00:00Z");
      const row = {
        id: "git-1",
        repositoryUrl: "https://example.test/repo",
        authCredential: "ghp_top_level_token",
        nested: { apiKey: "key-value", list: [{ clientSecret: "client-value" }, { token: "token-value", label: "keep" }] },
        createdAt,
      };

      const returned = await withAudit({
        action: "CONFIGURE_GIT",
        entityType: "GitConfig",
        entityId: "git-1",
        userId: "user-1",
        fn: async () => row,
      });

      expect(returned).toBe(row);
      expect(row.authCredential).toBe("ghp_top_level_token");
      expect(JSON.stringify(writtenData())).not.toMatch(/ghp_top_level_token|key-value|client-value|token-value/);
      expect(writtenData().afterState).toEqual({
        id: "git-1",
        repositoryUrl: "https://example.test/repo",
        authCredential: "[redacted]",
        nested: { apiKey: "[redacted]", list: [{ clientSecret: "[redacted]" }, { token: "[redacted]", label: "keep" }] },
        createdAt,
      });
    });

    it("matches a key by its name, without regard to case or separators, and not by a substring", async () => {
      await withAudit({
        action: "UPDATE",
        entityType: "Entity",
        entityId: "e-1",
        userId: "user-1",
        fn: async () => ({
          tokenCount: 3,
          secretary: "Ana",
          Password: "pw",
          api_key: "k",
          "CLIENT-SECRET": "c",
          privateKey: "pk",
        }),
      });

      expect(writtenData().afterState).toEqual({
        tokenCount: 3,
        secretary: "Ana",
        Password: "[redacted]",
        api_key: "[redacted]",
        "CLIENT-SECRET": "[redacted]",
        privateKey: "[redacted]",
      });
    });

    it("keeps a flag, a number and an absent value under such a key: `secret: true` is the TypeSpec @secret decorator, `maxTokens` a setting", async () => {
      await withAudit({
        action: "UPDATE",
        entityType: "Field",
        entityId: "f-1",
        userId: "user-1",
        fn: async () => ({ typespec: { identity: { secret: true } }, password: null, maxTokens: 2048 }),
      });

      expect(writtenData().afterState).toEqual({ typespec: { identity: { secret: true } }, password: null, maxTokens: 2048 });
    });

    it("searches a value that is a class instance too, and keeps a date as a date", async () => {
      class Row {
        authCredential: string;
        createdAt: Date;
        constructor(authCredential: string, createdAt: Date) {
          this.authCredential = authCredential;
          this.createdAt = createdAt;
        }
      }

      await withAudit({
        action: "CREATE",
        entityType: "GitConfig",
        entityId: "git-2",
        userId: "user-1",
        fn: async () => new Row("ghp_class_instance_token", new Date("2026-02-01T00:00:00Z")),
      });

      expect(JSON.stringify(writtenData())).not.toContain("ghp_class_instance_token");
      expect(writtenData().afterState).toEqual({ authCredential: "[redacted]", createdAt: new Date("2026-02-01T00:00:00Z") });
    });

    it("matches the plural names of a credential too: credentials, passwords, API keys, private keys, access keys", async () => {
      await withAudit({
        action: "UPDATE",
        entityType: "GitConfig",
        entityId: "git-1",
        userId: "user-1",
        fn: async () => ({
          credentials: "c-value",
          passwords: "p-value",
          apiKeys: "k-value",
          privateKeys: "pk-value",
          secretAccessKey: "sak-value",
          accessKeys: "ak-value",
          secretKeys: "sk-value",
        }),
      });

      expect(writtenData().afterState).toEqual({
        credentials: "[redacted]",
        passwords: "[redacted]",
        apiKeys: "[redacted]",
        privateKeys: "[redacted]",
        secretAccessKey: "[redacted]",
        accessKeys: "[redacted]",
        secretKeys: "[redacted]",
      });
    });

    it("searches what a value writes as its JSON form, so a class with its own toJSON cannot carry a credential past the check", async () => {
      class Connection {
        host: string;
        token: string;
        constructor(host: string, token: string) {
          this.host = host;
          this.token = token;
        }
        toJSON() {
          return { host: this.host, token: this.token };
        }
      }

      await withAudit({
        action: "CONFIGURE_GIT",
        entityType: "GitConfig",
        entityId: "git-3",
        userId: "user-1",
        fn: async () => ({ connection: new Connection("example.test", "ghp_to_json_token"), homepage: new URL("https://example.test/docs") }),
      });

      expect(JSON.stringify(writtenData())).not.toContain("ghp_to_json_token");
      expect(writtenData().afterState).toEqual({
        connection: { host: "example.test", token: "[redacted]" },
        homepage: "https://example.test/docs",
      });
    });

    it("keeps a Prisma null sentinel as it is: it is not data, and the write needs the sentinel itself", async () => {
      await withAudit({
        action: "UPDATE",
        entityType: "Entity",
        entityId: "e-2",
        userId: "user-1",
        fn: async () => Prisma.JsonNull,
      });

      expect(writtenData().afterState).toBe(Prisma.JsonNull);
    });

    it("redacts the before state as well as the after state", async () => {
      await withAudit({
        action: "UPDATE",
        entityType: "GitConfig",
        entityId: "git-1",
        userId: "user-1",
        beforeState: { authCredential: "old-token", enabled: false },
        fn: async () => ({ authCredential: "new-token", enabled: true }),
      });

      expect(writtenData().beforeState).toEqual({ authCredential: "[redacted]", enabled: false });
      expect(writtenData().afterState).toEqual({ authCredential: "[redacted]", enabled: true });
    });

    it("redacts the details of a recorded failure too", async () => {
      await recordAuditFailure({
        action: "EMISSION_FAILED",
        entityType: "Entity",
        entityId: "e-1",
        userId: "user-1",
        details: { message: "tsp failed", password: "pw-value" },
        tenantId: null,
      });

      expect(writtenData().afterState).toEqual({ message: "tsp failed", password: "[redacted]" });
    });
  });
});
