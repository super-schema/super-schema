/**
 * Unit tests for API v1 endpoints.
 *
 * Tests the route handlers with mocked services and auth.
 * Validates response shapes, status codes, and CI-friendly output.
 */

import { describe, it, expect, vi, beforeEach } from "vitest";

// ---------------------------------------------------------------------------
// Mock modules before imports
// ---------------------------------------------------------------------------

// Mock auth module
vi.mock("@/lib/auth", () => ({
  auth: vi.fn(),
}));

// Mock prisma
vi.mock("@/lib/db", () => ({
  prisma: {
    field: {
      findMany: vi.fn(),
      count: vi.fn().mockResolvedValue(0),
    },
    entity: {
      findMany: vi.fn(),
      findUnique: vi.fn(),
      count: vi.fn().mockResolvedValue(0),
    },
    domain: { count: vi.fn().mockResolvedValue(0) },
    user: { count: vi.fn().mockResolvedValue(0) },
    emissionTargetStatus: { count: vi.fn().mockResolvedValue(0) },
    auditLog: { findMany: vi.fn().mockResolvedValue([]), count: vi.fn().mockResolvedValue(0) },
    governanceRequest: { count: vi.fn().mockResolvedValue(0) },
    $queryRaw: vi.fn().mockResolvedValue([{ result: 1 }]),
  },
}));

// Mock entity service
vi.mock("@/services/entity.service", () => ({
  getEntities: vi.fn(),
  getEntityById: vi.fn(),
}));

// Mock emission
vi.mock("@/lib/emission/emit-from-data", () => ({
  emitFromData: vi.fn(),
}));

// ---------------------------------------------------------------------------
// Imports
// ---------------------------------------------------------------------------

import { GET as healthGet } from "@/app/api/v1/health/route";
import { GET as schemasListGet } from "@/app/api/v1/schemas/route";
import { GET as schemaDetailGet } from "@/app/api/v1/schemas/[id]/route";
import { POST as emitPost } from "@/app/api/v1/schemas/[id]/emit/route";
import { POST as validatePost } from "@/app/api/v1/schemas/[id]/validate/route";
import { GET as docsGet } from "@/app/api/v1/docs/route";
import { getEntities, getEntityById } from "@/services/entity.service";
import { emitFromData } from "@/lib/emission/emit-from-data";
import { prisma } from "@/lib/db";

// ---------------------------------------------------------------------------
// Helpers
// ---------------------------------------------------------------------------

function makeRequest(
  url: string,
  options: { method?: string; headers?: Record<string, string> } = {}
): Request {
  return new Request(url, {
    method: options.method ?? "GET",
    headers: {
      ...(options.headers ?? {}),
    },
  });
}

function makeAuthenticatedRequest(
  url: string,
  options: { method?: string } = {}
): Request {
  return makeRequest(url, {
    ...options,
    headers: { authorization: "Bearer test-api-key" },
  });
}

const mockEntity = {
  id: "entity-1",
  name: "Customer",
  description: "A customer entity",
  status: "ACTIVE",
  version: 1,
  domainId: "domain-1",
  createdAt: new Date("2024-01-01"),
  updatedAt: new Date("2024-01-02"),
  metadata: {},
  ownerId: "user-1",
  domain: { id: "domain-1", name: "Sales", slug: "sales" },
  fields: [
    {
      id: "field-1",
      name: "id",
      type: "string",
      nullable: false,
      isKey: true,
      sortOrder: 0,
      description: "Primary key",
      classification: null,
      aliases: [],
      decorators: {},
      precision: null,
      scale: null,
      fieldNumber: null,
    },
  ],
};

const mockEmissionResult = {
  typespec: "model Customer { id: string; }",
  targets: {
    bigquery: {
      name: "bigquery",
      targetFormat: "bigquery-ddl",
      output: "CREATE TABLE customer (id STRING NOT NULL)",
      isValid: true,
      validationStatus: "VALID" as const,
      warnings: [],
      errors: [],
    },
    avro: {
      name: "avro",
      targetFormat: "avro-schema",
      output: '{"type":"record","name":"Customer","fields":[]}',
      isValid: true,
      validationStatus: "VALID" as const,
      warnings: [],
      errors: [],
    },
    openapi: {
      name: "openapi",
      targetFormat: "openapi-3.1",
      output: "openapi: 3.1.0",
      isValid: true,
      validationStatus: "VALID" as const,
      warnings: [],
      errors: [],
    },
    spanner: {
      name: "spanner",
      targetFormat: "spanner-ddl",
      output: "CREATE TABLE customer (id STRING(MAX) NOT NULL) PRIMARY KEY (id);",
      isValid: true,
      validationStatus: "VALID" as const,
      warnings: [],
      errors: [],
    },
    postgresql: {
      name: "postgresql",
      targetFormat: "postgresql-ddl",
      output: "CREATE TABLE customer (id TEXT NOT NULL PRIMARY KEY);",
      isValid: true,
      validationStatus: "VALID" as const,
      warnings: [],
      errors: [],
    },
  },
  success: true,
  summary: {
    totalTargets: 5,
    validCount: 5,
    warningCount: 0,
    invalidCount: 0,
  },
};

// ---------------------------------------------------------------------------
// Tests
// ---------------------------------------------------------------------------

describe("API v1", () => {
  beforeEach(() => {
    vi.clearAllMocks();
    // Set API_KEY for auth
    process.env.API_KEY = "test-api-key";
  });

  // -------------------------------------------------------------------------
  // Health endpoint
  // -------------------------------------------------------------------------

  describe("GET /api/v1/health", () => {
    it("returns healthy status", async () => {
      const response = await healthGet();
      const body = await response.json();

      expect(response.status).toBe(200);
      expect(body.status).toBe("healthy");
      expect(body.components).toBeTruthy();
      expect(body.timestamp).toBeTruthy();
    });
  });

  // -------------------------------------------------------------------------
  // Docs endpoint
  // -------------------------------------------------------------------------

  describe("GET /api/v1/docs", () => {
    it("returns valid OpenAPI spec", async () => {
      const response = await docsGet();
      const body = await response.json();

      expect(response.status).toBe(200);
      expect(body.openapi).toBe("3.0.3");
      expect(body.info.title).toBe("Super Schema API");
      expect(body.paths).toBeTruthy();
    });

    it("includes all endpoint paths", async () => {
      const response = await docsGet();
      const body = await response.json();

      expect(body.paths["/health"]).toBeTruthy();
      expect(body.paths["/schemas"]).toBeTruthy();
      expect(body.paths["/schemas/{id}"]).toBeTruthy();
      expect(body.paths["/schemas/{id}/emit"]).toBeTruthy();
      expect(body.paths["/schemas/{id}/validate"]).toBeTruthy();
    });

    it("includes security scheme", async () => {
      const response = await docsGet();
      const body = await response.json();

      expect(body.components.securitySchemes.BearerAuth).toBeTruthy();
      expect(body.components.securitySchemes.BearerAuth.type).toBe("http");
      expect(body.components.securitySchemes.BearerAuth.scheme).toBe("bearer");
    });
  });

  // -------------------------------------------------------------------------
  // Auth
  // -------------------------------------------------------------------------

  describe("Authentication", () => {
    it("returns 401 without auth header", async () => {
      const request = makeRequest("http://localhost/api/v1/schemas");
      const response = await schemasListGet(request as never);
      const body = await response.json();

      expect(response.status).toBe(401);
      expect(body.success).toBe(false);
      expect(body.error.code).toBe("UNAUTHORIZED");
    });

    it("returns 401 with invalid API key", async () => {
      const request = makeRequest("http://localhost/api/v1/schemas", {
        headers: { authorization: "Bearer wrong-key" },
      });
      const response = await schemasListGet(request as never);
      const body = await response.json();

      expect(response.status).toBe(401);
      expect(body.success).toBe(false);
    });

    it("succeeds with valid API key", async () => {
      vi.mocked(getEntities).mockResolvedValue({
        success: true,
        data: [],
      });

      const request = makeAuthenticatedRequest(
        "http://localhost/api/v1/schemas"
      );
      const response = await schemasListGet(request as never);
      const body = await response.json();

      expect(response.status).toBe(200);
      expect(body.success).toBe(true);
    });
  });

  // -------------------------------------------------------------------------
  // GET /api/v1/schemas
  // -------------------------------------------------------------------------

  describe("GET /api/v1/schemas", () => {
    it("returns list of entities", async () => {
      vi.mocked(getEntities).mockResolvedValue({
        success: true,
        data: [mockEntity as never],
      });

      const request = makeAuthenticatedRequest(
        "http://localhost/api/v1/schemas"
      );
      const response = await schemasListGet(request as never);
      const body = await response.json();

      expect(response.status).toBe(200);
      expect(body.success).toBe(true);
      expect(body.data).toHaveLength(1);
      expect(body.data[0].id).toBe("entity-1");
      expect(body.data[0].name).toBe("Customer");
      expect(body.summary).toContain("1 entities");
    });

    it("returns empty list when no entities", async () => {
      vi.mocked(getEntities).mockResolvedValue({
        success: true,
        data: [],
      });

      const request = makeAuthenticatedRequest(
        "http://localhost/api/v1/schemas"
      );
      const response = await schemasListGet(request as never);
      const body = await response.json();

      expect(response.status).toBe(200);
      expect(body.data).toHaveLength(0);
    });

    it("passes query filters to service", async () => {
      vi.mocked(getEntities).mockResolvedValue({
        success: true,
        data: [],
      });

      const request = makeAuthenticatedRequest(
        "http://localhost/api/v1/schemas?domain=d1&status=ACTIVE&search=cust"
      );
      await schemasListGet(request as never);

      expect(getEntities).toHaveBeenCalledWith(
        {
          domainId: "d1",
          status: "ACTIVE",
          search: "cust",
        },
        expect.any(Object)
      );
    });
  });

  // -------------------------------------------------------------------------
  // GET /api/v1/schemas/:id
  // -------------------------------------------------------------------------

  describe("GET /api/v1/schemas/:id", () => {
    it("returns entity with fields", async () => {
      vi.mocked(getEntityById).mockResolvedValue({
        success: true,
        data: mockEntity as never,
      });

      const request = makeAuthenticatedRequest(
        "http://localhost/api/v1/schemas/entity-1"
      );
      const response = await schemaDetailGet(request as never, {
        params: Promise.resolve({ id: "entity-1" }),
      });
      const body = await response.json();

      expect(response.status).toBe(200);
      expect(body.success).toBe(true);
      expect(body.data.id).toBe("entity-1");
      expect(body.data.name).toBe("Customer");
    });

    it("returns 404 for non-existent entity", async () => {
      vi.mocked(getEntityById).mockResolvedValue({
        success: false,
        error: {
          code: "NOT_FOUND",
          message: 'Entity with ID "missing" not found',
          suggestedFix: "Verify the entity ID and try again.",
        },
      });

      const request = makeAuthenticatedRequest(
        "http://localhost/api/v1/schemas/missing"
      );
      const response = await schemaDetailGet(request as never, {
        params: Promise.resolve({ id: "missing" }),
      });
      const body = await response.json();

      expect(response.status).toBe(404);
      expect(body.success).toBe(false);
      expect(body.error.code).toBe("NOT_FOUND");
    });
  });

  // -------------------------------------------------------------------------
  // POST /api/v1/schemas/:id/emit
  // -------------------------------------------------------------------------

  describe("POST /api/v1/schemas/:id/emit", () => {
    it("emits entity to all targets", async () => {
      vi.mocked(getEntityById).mockResolvedValue({
        success: true,
        data: mockEntity as never,
      });
      vi.mocked(prisma.field.findMany).mockResolvedValue(
        mockEntity.fields as never
      );
      vi.mocked(emitFromData).mockReturnValue(mockEmissionResult);

      const request = makeAuthenticatedRequest(
        "http://localhost/api/v1/schemas/entity-1",
        { method: "POST" }
      );
      const response = await emitPost(request as never, {
        params: Promise.resolve({ id: "entity-1" }),
      });
      const body = await response.json();

      expect(response.status).toBe(200);
      expect(body.success).toBe(true);
      expect(body.data.entityId).toBe("entity-1");
      expect(body.data.targets).toHaveLength(5);
      expect(body.data.typespec).toContain("model Customer");
      expect(body.summary).toContain("5 targets");
    });

    it("returns 404 for non-existent entity", async () => {
      vi.mocked(getEntityById).mockResolvedValue({
        success: false,
        error: {
          code: "NOT_FOUND",
          message: 'Entity not found',
        },
      });

      const request = makeAuthenticatedRequest(
        "http://localhost/api/v1/schemas/missing",
        { method: "POST" }
      );
      const response = await emitPost(request as never, {
        params: Promise.resolve({ id: "missing" }),
      });

      expect(response.status).toBe(404);
    });

    it("returns per-target output and status", async () => {
      vi.mocked(getEntityById).mockResolvedValue({
        success: true,
        data: mockEntity as never,
      });
      vi.mocked(prisma.field.findMany).mockResolvedValue([] as never);
      vi.mocked(emitFromData).mockReturnValue(mockEmissionResult);

      const request = makeAuthenticatedRequest(
        "http://localhost/api/v1/schemas/entity-1",
        { method: "POST" }
      );
      const response = await emitPost(request as never, {
        params: Promise.resolve({ id: "entity-1" }),
      });
      const body = await response.json();

      for (const target of body.data.targets) {
        expect(target.target).toBeTruthy();
        expect(target.output).toBeTruthy();
        expect(["VALID", "INVALID", "WARNING"]).toContain(
          target.validationStatus
        );
      }
    });
  });

  // -------------------------------------------------------------------------
  // POST /api/v1/schemas/:id/validate
  // -------------------------------------------------------------------------

  describe("POST /api/v1/schemas/:id/validate", () => {
    it("returns per-target validation status", async () => {
      vi.mocked(getEntityById).mockResolvedValue({
        success: true,
        data: mockEntity as never,
      });
      vi.mocked(prisma.field.findMany).mockResolvedValue([] as never);
      vi.mocked(emitFromData).mockReturnValue(mockEmissionResult);

      const request = makeAuthenticatedRequest(
        "http://localhost/api/v1/schemas/entity-1",
        { method: "POST" }
      );
      const response = await validatePost(request as never, {
        params: Promise.resolve({ id: "entity-1" }),
      });
      const body = await response.json();

      expect(response.status).toBe(200);
      expect(body.success).toBe(true);
      expect(body.data.valid).toBe(true);
      expect(body.data.entityId).toBe("entity-1");
      expect(body.data.targets).toHaveLength(5);
    });

    it("returns ci.pass true when all targets valid", async () => {
      vi.mocked(getEntityById).mockResolvedValue({
        success: true,
        data: mockEntity as never,
      });
      vi.mocked(prisma.field.findMany).mockResolvedValue([] as never);
      vi.mocked(emitFromData).mockReturnValue(mockEmissionResult);

      const request = makeAuthenticatedRequest(
        "http://localhost/api/v1/schemas/entity-1",
        { method: "POST" }
      );
      const response = await validatePost(request as never, {
        params: Promise.resolve({ id: "entity-1" }),
      });
      const body = await response.json();

      expect(body.data.ci.pass).toBe(true);
      expect(body.data.ci.summary).toContain("All 5 targets valid");
    });

    it("returns ci.pass false when a target is invalid", async () => {
      const invalidResult = {
        ...mockEmissionResult,
        success: false,
        summary: {
          totalTargets: 5,
          validCount: 3,
          warningCount: 0,
          invalidCount: 1,
        },
      };

      vi.mocked(getEntityById).mockResolvedValue({
        success: true,
        data: mockEntity as never,
      });
      vi.mocked(prisma.field.findMany).mockResolvedValue([] as never);
      vi.mocked(emitFromData).mockReturnValue(invalidResult);

      const request = makeAuthenticatedRequest(
        "http://localhost/api/v1/schemas/entity-1",
        { method: "POST" }
      );
      const response = await validatePost(request as never, {
        params: Promise.resolve({ id: "entity-1" }),
      });
      const body = await response.json();

      expect(body.data.ci.pass).toBe(false);
      expect(body.data.ci.summary).toContain("1 of 5 targets invalid");
    });

    it("returns 404 for non-existent entity", async () => {
      vi.mocked(getEntityById).mockResolvedValue({
        success: false,
        error: {
          code: "NOT_FOUND",
          message: 'Entity not found',
        },
      });

      const request = makeAuthenticatedRequest(
        "http://localhost/api/v1/schemas/missing",
        { method: "POST" }
      );
      const response = await validatePost(request as never, {
        params: Promise.resolve({ id: "missing" }),
      });

      expect(response.status).toBe(404);
    });
  });

  // -------------------------------------------------------------------------
  // Error handler
  // -------------------------------------------------------------------------

  describe("Error handler", () => {
    it("maps NOT_FOUND to 404", async () => {
      vi.mocked(getEntityById).mockResolvedValue({
        success: false,
        error: {
          code: "NOT_FOUND",
          message: "Not found",
        },
      });

      const request = makeAuthenticatedRequest(
        "http://localhost/api/v1/schemas/x"
      );
      const response = await schemaDetailGet(request as never, {
        params: Promise.resolve({ id: "x" }),
      });

      expect(response.status).toBe(404);
    });

    it("returns standardized error shape", async () => {
      vi.mocked(getEntityById).mockResolvedValue({
        success: false,
        error: {
          code: "NOT_FOUND",
          message: "Entity not found",
          suggestedFix: "Check the ID",
        },
      });

      const request = makeAuthenticatedRequest(
        "http://localhost/api/v1/schemas/x"
      );
      const response = await schemaDetailGet(request as never, {
        params: Promise.resolve({ id: "x" }),
      });
      const body = await response.json();

      expect(body).toEqual({
        success: false,
        error: {
          code: "NOT_FOUND",
          message: "Entity not found",
          suggestedFix: "Check the ID",
        },
      });
    });
  });

  // -------------------------------------------------------------------------
  // Response shape consistency
  // -------------------------------------------------------------------------

  describe("Response shape", () => {
    it("all success responses have { success: true, data }", async () => {
      vi.mocked(getEntities).mockResolvedValue({
        success: true,
        data: [],
      });

      const request = makeAuthenticatedRequest(
        "http://localhost/api/v1/schemas"
      );
      const response = await schemasListGet(request as never);
      const body = await response.json();

      expect(body).toHaveProperty("success", true);
      expect(body).toHaveProperty("data");
    });

    it("all error responses have { success: false, error: { code, message } }", async () => {
      const request = makeRequest("http://localhost/api/v1/schemas");
      const response = await schemasListGet(request as never);
      const body = await response.json();

      expect(body).toHaveProperty("success", false);
      expect(body.error).toHaveProperty("code");
      expect(body.error).toHaveProperty("message");
    });
  });
});
