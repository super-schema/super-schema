/**
 * Admin Health oRPC Router — health checks and metrics.
 * All routes require Admin role via adminProcedure.
 */

import { z } from "zod";
import { adminProcedure } from "../../procedures";
import * as healthService from "@/services/health.service";
import type { ServiceContext } from "@/types/service-context";

function toServiceCtx(ctx: { session: unknown; db: unknown }): ServiceContext {
  const session = ctx.session as { user: { id: string } };
  return {
    userId: session.user.id,
    userRole: "ADMIN",
    prisma: ctx.db as ServiceContext["prisma"],
  };
}

export const adminHealthRouter = {
  runCheck: adminProcedure.handler(async ({ context }) =>
    healthService.runHealthCheck(toServiceCtx(context), { detail: "admin" })
  ),

  usageMetrics: adminProcedure.handler(async ({ context }) =>
    healthService.getUsageMetrics(toServiceCtx(context))
  ),

  activityMetrics: adminProcedure.handler(async ({ context }) =>
    healthService.getActivityMetrics(toServiceCtx(context))
  ),

  errorSummary: adminProcedure.handler(async ({ context }) =>
    healthService.getErrorSummary(toServiceCtx(context))
  ),

  errorDetails: adminProcedure
    .input(z.object({ errorType: z.string() }))
    .handler(async ({ input, context }) =>
      healthService.getErrorDetails(input.errorType, toServiceCtx(context))
    ),
};
