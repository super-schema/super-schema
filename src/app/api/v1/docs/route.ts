/**
 * GET /api/v1/docs — Serves an OpenAPI 3.0 specification
 * describing all API v1 endpoints.
 */

import { NextResponse } from "next/server";

const openApiSpec = {
  openapi: "3.0.3",
  info: {
    title: "Super Schema API",
    description:
      "External REST API for accessing schemas, validation, and emission. " +
      "Designed for CI/CD pipeline integration and programmatic access.",
    version: "1.0.0",
    contact: {
      name: "Super Schema",
    },
  },
  servers: [
    {
      url: "/api/v1",
      description: "API v1",
    },
  ],
  security: [{ BearerAuth: [] }],
  paths: {
    "/health": {
      get: {
        summary: "Health check",
        description: "Returns service health status. No authentication required.",
        tags: ["System"],
        security: [],
        responses: {
          "200": {
            description: "Service is healthy",
            content: {
              "application/json": {
                schema: {
                  type: "object",
                  properties: {
                    success: { type: "boolean", example: true },
                    data: {
                      type: "object",
                      properties: {
                        status: { type: "string", example: "healthy" },
                        version: { type: "string", example: "1.0.0" },
                        timestamp: { type: "string", format: "date-time" },
                      },
                    },
                  },
                },
              },
            },
          },
        },
      },
    },
    "/schemas": {
      get: {
        summary: "List all entities",
        description: "Returns all schema entities with basic metadata.",
        tags: ["Schemas"],
        parameters: [
          {
            name: "domain",
            in: "query",
            description: "Filter by domain ID",
            schema: { type: "string" },
          },
          {
            name: "status",
            in: "query",
            description: "Filter by status (DRAFT, ACTIVE, DEPRECATED, RETIRED)",
            schema: { type: "string", enum: ["DRAFT", "ACTIVE", "DEPRECATED", "RETIRED"] },
          },
          {
            name: "search",
            in: "query",
            description: "Search by entity name (case-insensitive contains)",
            schema: { type: "string" },
          },
        ],
        responses: {
          "200": {
            description: "List of entities",
            content: {
              "application/json": {
                schema: {
                  $ref: "#/components/schemas/ApiSuccessResponse",
                },
              },
            },
          },
          "401": { $ref: "#/components/responses/Unauthorized" },
        },
      },
    },
    "/schemas/{id}": {
      get: {
        summary: "Get entity by ID",
        description: "Returns a single entity with all fields and decorators.",
        tags: ["Schemas"],
        parameters: [
          {
            name: "id",
            in: "path",
            required: true,
            description: "Entity ID",
            schema: { type: "string" },
          },
        ],
        responses: {
          "200": {
            description: "Entity details",
            content: {
              "application/json": {
                schema: {
                  $ref: "#/components/schemas/ApiSuccessResponse",
                },
              },
            },
          },
          "401": { $ref: "#/components/responses/Unauthorized" },
          "404": { $ref: "#/components/responses/NotFound" },
        },
      },
    },
    "/schemas/{id}/emit": {
      post: {
        summary: "Emit entity to all targets",
        description:
          "Runs the emission pipeline for every enabled target and returns per-target results. JSON Schema, OpenAPI 3, Protobuf, Avro and Java " +
          "are emitted for the entity together with every entity it references, one file per entity (`files`, tagged by target; `output` is " +
          "their bundled string); `resolution` says which version of each entity was used (`preview: true` when drafts were). " +
          "A bare-name reference that matches several entities fails with 422 AMBIGUOUS_REFERENCE and the candidates in `error.details`.",
        tags: ["Emission"],
        parameters: [
          {
            name: "id",
            in: "path",
            required: true,
            description: "Entity ID",
            schema: { type: "string" },
          },
        ],
        responses: {
          "200": {
            description: "Emission results",
            content: {
              "application/json": {
                schema: {
                  $ref: "#/components/schemas/ApiSuccessResponse",
                },
              },
            },
          },
          "401": { $ref: "#/components/responses/Unauthorized" },
          "404": { $ref: "#/components/responses/NotFound" },
          "422": { description: "A reference of the entity cannot be resolved (AMBIGUOUS_REFERENCE, PIN_NOT_FOUND, NEVER_PUBLISHED, CLOSURE_TOO_LARGE)" },
        },
      },
    },
    "/schemas/{id}/validate": {
      post: {
        summary: "Validate entity completeness",
        description:
          "Validates entity against all enabled targets and returns per-target status. " +
          "Includes a ci field for CI/CD pipeline integration.",
        tags: ["Validation"],
        parameters: [
          {
            name: "id",
            in: "path",
            required: true,
            description: "Entity ID",
            schema: { type: "string" },
          },
        ],
        responses: {
          "200": {
            description: "Validation results with CI-friendly summary",
            content: {
              "application/json": {
                schema: {
                  type: "object",
                  properties: {
                    success: { type: "boolean" },
                    data: {
                      type: "object",
                      properties: {
                        valid: { type: "boolean" },
                        entityId: { type: "string" },
                        entityName: { type: "string" },
                        targets: {
                          type: "array",
                          items: {
                            type: "object",
                            properties: {
                              target: { type: "string" },
                              status: {
                                type: "string",
                                enum: ["VALID", "INVALID", "WARNING"],
                              },
                              errors: {
                                type: "array",
                                items: { type: "string" },
                              },
                              warnings: {
                                type: "array",
                                items: { type: "string" },
                              },
                            },
                          },
                        },
                        ci: {
                          type: "object",
                          properties: {
                            pass: { type: "boolean" },
                            summary: { type: "string" },
                          },
                        },
                      },
                    },
                  },
                },
              },
            },
          },
          "401": { $ref: "#/components/responses/Unauthorized" },
          "404": { $ref: "#/components/responses/NotFound" },
        },
      },
    },
  },
  components: {
    securitySchemes: {
      BearerAuth: {
        type: "http",
        scheme: "bearer",
        description:
          "API key authentication. Pass your API key as a Bearer token.",
      },
    },
    schemas: {
      ApiSuccessResponse: {
        type: "object",
        properties: {
          success: { type: "boolean", example: true },
          data: { type: "object" },
          summary: { type: "string" },
        },
      },
      ApiErrorResponse: {
        type: "object",
        properties: {
          success: { type: "boolean", example: false },
          error: {
            type: "object",
            properties: {
              code: { type: "string" },
              message: { type: "string" },
              details: { type: "object" },
              suggestedFix: { type: "string" },
            },
          },
        },
      },
    },
    responses: {
      Unauthorized: {
        description: "Authentication required",
        content: {
          "application/json": {
            schema: { $ref: "#/components/schemas/ApiErrorResponse" },
          },
        },
      },
      NotFound: {
        description: "Resource not found",
        content: {
          "application/json": {
            schema: { $ref: "#/components/schemas/ApiErrorResponse" },
          },
        },
      },
    },
  },
};

export async function GET() {
  return NextResponse.json(openApiSpec);
}
