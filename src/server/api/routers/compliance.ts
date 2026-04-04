import { z } from "zod";
import { protectedProcedure } from "../procedures";
import {
  ComplianceFilterSchema,
  PaginationSchema,
  GapFilterSchema,
  AuditTrailFilterSchema,
  AuditPaginationSchema,
} from "@/types/schemas/compliance";
import {
  queryFields,
  detectGaps,
  queryAuditTrail,
  exportAuditTrail,
} from "@/services/compliance.service";
import type { ServiceContext } from "@/types/service-context";

function toServiceCtx(ctx: { session: unknown; db: unknown }): ServiceContext {
  const session = ctx.session as { user: { id: string } };
  return {
    userId: session.user.id,
    userRole: "AUTHOR", // In production, resolve from user record
    prisma: ctx.db as ServiceContext["prisma"],
  };
}

export const complianceRouter = {
  queryFields: protectedProcedure
    .input(
      z.object({
        filters: ComplianceFilterSchema.optional(),
        pagination: PaginationSchema.optional(),
      })
    )
    .handler(async ({ input, context }) =>
      queryFields(
        input.filters || {},
        input.pagination || { page: 1, pageSize: 25, sortBy: "entityName", sortOrder: "asc" },
        toServiceCtx(context)
      )
    ),

  detectGaps: protectedProcedure
    .input(
      z.object({
        filters: GapFilterSchema.optional(),
      })
    )
    .handler(async ({ input, context }) =>
      detectGaps(input.filters || {}, toServiceCtx(context))
    ),

  exportData: protectedProcedure
    .input(
      z.object({
        filters: ComplianceFilterSchema.optional(),
        sortBy: z.string().optional(),
        sortOrder: z.enum(["asc", "desc"]).optional(),
      })
    )
    .handler(async ({ input, context }) =>
      queryFields(
        input.filters || {},
        {
          page: 1,
          pageSize: 10000,
          sortBy: input.sortBy || "entityName",
          sortOrder: input.sortOrder || "asc",
        },
        toServiceCtx(context)
      )
    ),

  queryAuditTrail: protectedProcedure
    .input(
      z.object({
        filters: AuditTrailFilterSchema.optional(),
        pagination: AuditPaginationSchema.optional(),
      })
    )
    .handler(async ({ input, context }) =>
      queryAuditTrail(
        input.filters || {},
        input.pagination || { page: 1, pageSize: 50 },
        toServiceCtx(context)
      )
    ),

  exportAuditTrail: protectedProcedure
    .input(
      z.object({
        filters: AuditTrailFilterSchema.optional(),
      })
    )
    .handler(async ({ input, context }) =>
      exportAuditTrail(input.filters || {}, toServiceCtx(context))
    ),
};
