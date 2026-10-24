/**
 * REST Health Endpoint — GET /api/v1/health
 *
 * Unauthenticated endpoint for monitoring tools.
 * Returns health check response with appropriate HTTP status.
 */

import { NextResponse } from "next/server";
import { runHealthCheck } from "@/services/health.service";
import type { ServiceContext } from "@/types/service-context";
import { prisma } from "@/lib/db";

/** What an unauthenticated caller is told when the check itself could not run: nothing of the cause (it is logged). */
function unavailable() {
  return NextResponse.json({ status: "unhealthy", error: "Health check unavailable" }, { status: 503, headers: { "Cache-Control": "no-cache" } });
}

export async function GET() {
  // System context — no user session required
  const ctx: ServiceContext = {
    userId: "system",
    userRole: "ADMIN",
    prisma,
  };

  let result: Awaited<ReturnType<typeof runHealthCheck>>;
  try {
    result = await runHealthCheck(ctx);
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
