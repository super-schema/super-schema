/**
 * REST Health Endpoint — GET /api/v1/health
 *
 * Unauthenticated endpoint for monitoring tools.
 * Returns health check response with appropriate HTTP status.
 */

import { NextResponse } from "next/server";
import { runHealthCheck } from "@/services/health.service";
import type { ServiceContext } from "@/types/service-context";

export async function GET() {
  // System context — no user session required
  const ctx: ServiceContext = {
    userId: "system",
    userRole: "ADMIN",
    prisma: null as unknown as ServiceContext["prisma"],
  };

  const result = await runHealthCheck(ctx);

  if (!result.success) {
    return NextResponse.json(
      { status: "unhealthy", error: result.error.message },
      {
        status: 503,
        headers: { "Cache-Control": "no-cache" },
      }
    );
  }

  const httpStatus = result.data.status === "unhealthy" ? 503 : 200;

  return NextResponse.json(result.data, {
    status: httpStatus,
    headers: { "Cache-Control": "no-cache" },
  });
}
