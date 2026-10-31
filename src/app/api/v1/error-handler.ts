/**
 * Standardized error handling for API v1 endpoints.
 *
 * Maps service-layer Result errors to HTTP status codes
 * and a consistent JSON error shape.
 */

import { NextResponse } from "next/server";
import type { ServiceError } from "@/types/result";

// ---------------------------------------------------------------------------
// Standardized API response helpers
// ---------------------------------------------------------------------------

export interface ApiSuccessResponse<T = unknown> {
  success: true;
  data: T;
  summary?: string;
}

export interface ApiErrorResponse {
  success: false;
  error: {
    code: string;
    message: string;
    details?: object;
    suggestedFix?: string;
  };
}

export type ApiResponse<T = unknown> = ApiSuccessResponse<T> | ApiErrorResponse;

/**
 * Map a service error code to an HTTP status code.
 */
function mapErrorCodeToStatus(code: string): number {
  switch (code) {
    case "VALIDATION_ERROR":
    case "INVALID_TRANSITION":
      return 400;
    case "UNAUTHORIZED":
      return 401;
    case "FORBIDDEN":
    // The caller reaches the entity asked for but none of their roles covers an entity its schema refers to (KD-045): the same 403 as a role that is
    // too low, with a message that names nothing of the other entity.
    case "REFERENCE_NOT_READABLE":
      return 403;
    case "NOT_FOUND":
      return 404;
    case "DUPLICATE":
      return 409;
    case "ENTITY_READ_ONLY":
    // A reference closure that cannot be built: the request is understood but the entity's references must be fixed first.
    case "AMBIGUOUS_REFERENCE":
    case "PIN_NOT_FOUND":
    case "PIN_CONFLICT":
    case "NEVER_PUBLISHED":
    case "AMBIGUOUS_BASE":
    case "INHERITANCE_CYCLE":
    case "CLOSURE_TOO_LARGE":
      return 422;
    default:
      return 500;
  }
}

/**
 * Return a success JSON response.
 */
export function apiSuccess<T>(data: T, summary?: string, status = 200): NextResponse {
  const body: ApiSuccessResponse<T> = { success: true, data };
  if (summary) body.summary = summary;
  return NextResponse.json(body, { status });
}

/**
 * Return an error JSON response from a ServiceError.
 */
export function apiError(error: ServiceError): NextResponse {
  const status = mapErrorCodeToStatus(error.code);
  const body: ApiErrorResponse = {
    success: false,
    error: {
      code: error.code,
      message: error.message,
      details: error.details,
      suggestedFix: error.suggestedFix,
    },
  };
  return NextResponse.json(body, { status });
}

/**
 * Return a 401 Unauthorized response.
 */
export function apiUnauthorized(message = "Authentication required"): NextResponse {
  return NextResponse.json(
    {
      success: false,
      error: {
        code: "UNAUTHORIZED",
        message,
        suggestedFix:
          "Provide a valid API key via the Authorization: Bearer <key> header, or use session authentication.",
      },
    } satisfies ApiErrorResponse,
    { status: 401 }
  );
}

/**
 * Return a 500 Internal Server Error response.
 */
export function apiServerError(message = "Internal server error"): NextResponse {
  return NextResponse.json(
    {
      success: false,
      error: { code: "INTERNAL_ERROR", message },
    } satisfies ApiErrorResponse,
    { status: 500 }
  );
}
