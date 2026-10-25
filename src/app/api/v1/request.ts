/**
 * What the API v1 routes ask of a request before they act on it: a body that is JSON, and an id that can be a row's.
 *
 * Both used to reach the database or the service as they came: a body that was not JSON threw out of `request.json()` into the route's
 * catch-all (a 500, "Internal server error", for what is the caller's mistake), and an id with a NUL byte in it made PostgreSQL refuse the
 * lookup (`invalid byte sequence for encoding "UTF8": 0x00`), which was a 500 as well.
 */

import type { NextResponse } from "next/server";
import { apiError } from "@/app/api/v1/error-handler";

export type JsonBody = { ok: true; body: unknown } | { ok: false; response: NextResponse };

/**
 * The request's body parsed as JSON. A body that is empty or is not JSON is a 400 `VALIDATION_ERROR` (returned as `response`, for the route
 * to hand back as it is), never a thrown error. What the JSON holds is the caller's to validate.
 */
export async function readJsonBody(request: Request): Promise<JsonBody> {
  try {
    return { ok: true, body: await request.json() };
  } catch {
    return {
      ok: false,
      response: apiError({
        code: "VALIDATION_ERROR",
        message: "The request body must be valid JSON",
        suggestedFix: "Send a JSON document as the body, with Content-Type: application/json.",
      }),
    };
  }
}

/**
 * Whether `id` can be the id of a row. One with a NUL byte cannot (PostgreSQL text holds none), and an id that is empty names nothing:
 * the route answers it as it answers an id that does not exist (404), without asking the database.
 */
export function isUsableId(id: string): boolean {
  return id.length > 0 && !id.includes("\u0000");
}

/** The 404 of an id that cannot be a row's, in the words the service gives for an id that is merely unknown (so the two cannot be told apart). */
export function unusableIdNotFound(kind: "entity" | "webhook" | "notification" | "event-spec", id: string): NextResponse {
  switch (kind) {
    case "entity":
      return apiError({ code: "NOT_FOUND", message: `Entity with ID "${id}" not found`, suggestedFix: "Verify the entity ID and try again." });
    case "webhook":
      return apiError({ code: "NOT_FOUND", message: `Webhook endpoint "${id}" not found` });
    case "notification":
      return apiError({ code: "NOT_FOUND", message: `Notification "${id}" not found` });
    case "event-spec":
      return apiError({ code: "NOT_FOUND", message: "Event spec not found", suggestedFix: "Check the event spec id." });
  }
}
