/**
 * GET /api/v1/health — Health check endpoint.
 *
 * Returns basic service status. No authentication required.
 */

import { NextResponse } from "next/server";

export async function GET() {
  return NextResponse.json({
    success: true,
    data: {
      status: "healthy",
      version: "1.0.0",
      timestamp: new Date().toISOString(),
    },
  });
}
