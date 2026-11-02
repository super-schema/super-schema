/**
 * GET /api/v1/docs — Serves an OpenAPI 3.0 specification
 * describing all API v1 endpoints.
 */

import { NextResponse } from "next/server";
import { WEBHOOK_EVENT_TYPES } from "@/types/schemas/webhook";

const WEBHOOK_EVENTS = [...WEBHOOK_EVENT_TYPES];

const componentStatus = {
  type: "object",
  properties: {
    name: { type: "string" },
    status: { type: "string", enum: ["healthy", "degraded", "unhealthy"] },
    message: { type: "string" },
    latencyMs: { type: "number" },
  },
};

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
                // The report itself, not the `{ success, data }` envelope of the other endpoints.
                schema: { $ref: "#/components/schemas/HealthReport" },
              },
            },
          },
          "503": {
            description: "The system is unhealthy, or the check could not run (the body names no cause)",
            content: { "application/json": { schema: { $ref: "#/components/schemas/HealthReport" } } },
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
          "403": { description: "The entity refers to an entity that none of the caller's roles covers (REFERENCE_NOT_READABLE): nothing is emitted, and the message names the field, never the other entity" },
          "404": { $ref: "#/components/responses/NotFound" },
          "422": { description: "A reference of the entity cannot be resolved (AMBIGUOUS_REFERENCE, PIN_NOT_FOUND, PIN_CONFLICT, NEVER_PUBLISHED, CLOSURE_TOO_LARGE)" },
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
    "/webhooks": {
      get: {
        summary: "List webhook endpoints",
        description: "Platform administrators only: the session of a platform administrator, or the API key when its role is ADMIN. The list never carries a signing secret: the answer of the creation shows it, once.",
        tags: ["Webhooks"],
        responses: {
          "200": { description: "The endpoints", content: { "application/json": { schema: { $ref: "#/components/schemas/ApiSuccessResponse" } } } },
          "401": { $ref: "#/components/responses/Unauthorized" },
          "403": { $ref: "#/components/responses/Forbidden" },
        },
      },
      post: {
        summary: "Create a webhook endpoint",
        description: "Platform administrators only. The body is `{ url, events, active? }`; the signing secret is made up by the server and is in the answer of this call only. An endpoint made by the API key has no creator (`createdBy` is null). An endpoint belongs to the tenant the request acts in (the API key's tenant, or the signed-in session's active tenant); it receives that tenant's events only, and another tenant's endpoint is a 404. A URL is refused at creation and at update unless it is an `https` URL whose name resolves to public addresses only (no loopback, private, link-local or other reserved address, IPv4 or IPv6); the delivery checks the address again when it connects, and a redirect is not followed, so a 3xx answer is a failed delivery. Each payload carries `data.tenantId`. `emission.completed` carries `data.run` (`preview`: nothing stored; `stored`: a schema version was stored). `governance.request.created`, `drift.detected` and `compliance.gap.detected` can be subscribed to, but no part of the platform sends them yet.",
        tags: ["Webhooks"],
        requestBody: {
          required: true,
          content: {
            "application/json": {
              schema: {
                type: "object",
                required: ["url", "events"],
                properties: {
                  url: { type: "string", format: "uri" },
                  events: { type: "array", minItems: 1, items: { type: "string", enum: WEBHOOK_EVENTS } },
                  active: { type: "boolean", default: true },
                },
              },
            },
          },
        },
        responses: {
          "201": { description: "The endpoint created", content: { "application/json": { schema: { $ref: "#/components/schemas/ApiSuccessResponse" } } } },
          "400": { $ref: "#/components/responses/BadRequest" },
          "401": { $ref: "#/components/responses/Unauthorized" },
          "403": { $ref: "#/components/responses/Forbidden" },
        },
      },
    },
    "/webhooks/{id}": {
      put: {
        summary: "Update a webhook endpoint",
        description: "Platform administrators only. Any of `url`, `events`, `active`; nothing else of the endpoint can be changed. The answer carries no signing secret.",
        tags: ["Webhooks"],
        parameters: [{ name: "id", in: "path", required: true, description: "Webhook endpoint ID", schema: { type: "string" } }],
        requestBody: {
          required: true,
          content: {
            "application/json": {
              schema: {
                type: "object",
                properties: {
                  url: { type: "string", format: "uri" },
                  events: { type: "array", minItems: 1, items: { type: "string", enum: WEBHOOK_EVENTS } },
                  active: { type: "boolean" },
                },
              },
            },
          },
        },
        responses: {
          "200": { description: "The endpoint as updated", content: { "application/json": { schema: { $ref: "#/components/schemas/ApiSuccessResponse" } } } },
          "400": { $ref: "#/components/responses/BadRequest" },
          "401": { $ref: "#/components/responses/Unauthorized" },
          "403": { $ref: "#/components/responses/Forbidden" },
          "404": { $ref: "#/components/responses/NotFound" },
        },
      },
      delete: {
        summary: "Delete a webhook endpoint",
        description: "Platform administrators only. The endpoint's deliveries are deleted with it.",
        tags: ["Webhooks"],
        parameters: [{ name: "id", in: "path", required: true, description: "Webhook endpoint ID", schema: { type: "string" } }],
        responses: {
          "200": { description: "`{ deleted: true }`", content: { "application/json": { schema: { $ref: "#/components/schemas/ApiSuccessResponse" } } } },
          "401": { $ref: "#/components/responses/Unauthorized" },
          "403": { $ref: "#/components/responses/Forbidden" },
          "404": { $ref: "#/components/responses/NotFound" },
        },
      },
    },
    "/webhooks/{id}/deliveries": {
      get: {
        summary: "List the deliveries of a webhook endpoint",
        description: "Platform administrators only. Newest first, with the status code or the error of each attempt.",
        tags: ["Webhooks"],
        parameters: [{ name: "id", in: "path", required: true, description: "Webhook endpoint ID", schema: { type: "string" } }],
        responses: {
          "200": { description: "The deliveries", content: { "application/json": { schema: { $ref: "#/components/schemas/ApiSuccessResponse" } } } },
          "401": { $ref: "#/components/responses/Unauthorized" },
          "403": { $ref: "#/components/responses/Forbidden" },
          "404": { $ref: "#/components/responses/NotFound" },
        },
      },
    },
    "/notifications": {
      get: {
        summary: "List the notifications of the caller",
        description:
          "The signed-in user's own notifications, newest first, with their unread count. `countOnly=true` answers just `{ unreadCount }` " +
          "(and 0, not a 401, to a caller without a credential: it is what the bell polls).",
        tags: ["Notifications"],
        parameters: [
          { name: "types", in: "query", description: "Comma-separated notification types", schema: { type: "string" } },
          { name: "read", in: "query", description: "Only read (true) or unread (false) notifications", schema: { type: "boolean" } },
          { name: "page", in: "query", description: "Page, from 1", schema: { type: "integer", minimum: 1, default: 1 } },
          { name: "pageSize", in: "query", description: "Page size, 1 to 100", schema: { type: "integer", minimum: 1, maximum: 100, default: 25 } },
          { name: "countOnly", in: "query", description: "Answer only the unread count", schema: { type: "boolean" } },
        ],
        responses: {
          "200": { description: "The notifications and the unread count", content: { "application/json": { schema: { $ref: "#/components/schemas/ApiSuccessResponse" } } } },
          "400": { $ref: "#/components/responses/BadRequest" },
          "401": { $ref: "#/components/responses/Unauthorized" },
        },
      },
      post: {
        summary: "Mark notifications as read",
        description: "`action=mark-read&id=<id>` marks one of the caller's own notifications, `action=mark-all-read` all of them.",
        tags: ["Notifications"],
        parameters: [
          { name: "action", in: "query", required: true, description: "mark-read or mark-all-read", schema: { type: "string", enum: ["mark-read", "mark-all-read"] } },
          { name: "id", in: "query", description: "The notification, for mark-read", schema: { type: "string" } },
        ],
        responses: {
          "200": { description: "`{ marked: true }`", content: { "application/json": { schema: { $ref: "#/components/schemas/ApiSuccessResponse" } } } },
          "400": { $ref: "#/components/responses/BadRequest" },
          "401": { $ref: "#/components/responses/Unauthorized" },
          "403": { $ref: "#/components/responses/Forbidden" },
          "404": { $ref: "#/components/responses/NotFound" },
        },
      },
    },
    "/event-specs/{id}": {
      get: {
        summary: "Get the AsyncAPI document of an event",
        description:
          "The raw AsyncAPI document (not the JSON envelope): the latest published version, a published `version=MAJOR.MINOR`, or `version=draft`. " +
          "An event of another tenant and one that does not exist give the same 404.",
        tags: ["Events"],
        parameters: [
          { name: "id", in: "path", required: true, description: "Event spec ID", schema: { type: "string" } },
          { name: "version", in: "query", description: "`draft`, or MAJOR.MINOR; omitted: the latest published version", schema: { type: "string" } },
          { name: "format", in: "query", description: "yaml (default) or json", schema: { type: "string", enum: ["yaml", "json"], default: "yaml" } },
        ],
        responses: {
          "200": {
            description: "The AsyncAPI document",
            content: { "application/yaml": { schema: { type: "string" } }, "application/json": { schema: { type: "object" } } },
          },
          "400": { $ref: "#/components/responses/BadRequest" },
          "401": { $ref: "#/components/responses/Unauthorized" },
          "404": { $ref: "#/components/responses/NotFound" },
          "429": { description: "More than 100 requests a minute from one client address (the proxy's X-Forwarded-For when the server trusts one, else one client for every caller). The body is the error envelope, code RATE_LIMITED, with the wait in details.retryAfter and the Retry-After header." },
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
          "API key authentication. Pass your API key as a Bearer token. The key is a service principal bound to ONE tenant and ONE role (API_KEY_TENANT_ID, API_KEY_ROLE; by default the default tenant and ADMIN): the schema routes answer for that tenant only. Without a key, a signed-in session is accepted and carries the user's own roles.",
      },
    },
    schemas: {
      HealthReport: {
        type: "object",
        properties: {
          status: { type: "string", enum: ["healthy", "degraded", "unhealthy"], description: "200 for healthy and degraded, 503 for unhealthy" },
          components: {
            type: "object",
            properties: { database: componentStatus, compiler: componentStatus, emitters: componentStatus },
          },
          timestamp: { type: "string", format: "date-time" },
        },
      },
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
      BadRequest: {
        description: "The request is invalid (VALIDATION_ERROR): a body that is not JSON, a value that is not allowed",
        content: {
          "application/json": {
            schema: { $ref: "#/components/schemas/ApiErrorResponse" },
          },
        },
      },
      Forbidden: {
        description: "The caller's role may not do this (FORBIDDEN)",
        content: {
          "application/json": {
            schema: { $ref: "#/components/schemas/ApiErrorResponse" },
          },
        },
      },
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
