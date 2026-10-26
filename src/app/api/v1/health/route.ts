/**
 * REST Health Endpoint — GET /api/v1/health
 *
 * Unauthenticated endpoint for monitoring tools.
 * Returns health check response with appropriate HTTP status.
 */

import { NextResponse } from "next/server";
import { runHealthCheck } from "@/services/health.service";

/** What an unauthenticated caller is told when the check itself could not run: nothing of the cause (it is logged). */
function unavailable() {
  return NextResponse.json({ status: "unhealthy", error: "Health check unavailable" }, { status: 503, headers: { "Cache-Control": "no-cache" } });
}

export async function GET() {
  // The probe is public on purpose and has no caller: it runs with no context at all (no pretended administrator), and the default
  // `detail: "public"` keeps every package name and version out of the answer.
  let result: Awaited<ReturnType<typeof runHealthCheck>>;
  try {
    result = await runHealthCheck({});
  } catch (error) {
    console.error("[health] the health check could not run", error);
    return unavailable();
  }

  if (!result.success) {
    console.error("[health] the health check failed", result.error);
    return unavailable();
  }

  const httpStatus = result.data.status === "unhealthy" ? 503 : 200;

  return NextResponse.json(result.data, {
    status: httpStatus,
    headers: { "Cache-Control": "no-cache" },
  });
}
