/**
 * Admin Classifications oRPC Router — classification taxonomy management.
 * getAll is accessible to all authenticated users (needed for dropdowns).
 * CRUD operations require Admin role via adminProcedure.
 */

import { z } from "zod";
import { protectedProcedure, adminProcedure } from "../../procedures";
import {
  CreateClassificationInputSchema,
  UpdateClassificationInputSchema,
} from "@/types/schemas/classification-taxonomy";
import * as classificationService from "@/services/classification-taxonomy.service";
import type { ServiceContext } from "@/types/service-context";

function toServiceCtx(ctx: { session: unknown; db: unknown }, role = "ADMIN"): ServiceContext {
  const session = ctx.session as { user: { id: string } };
  return {
    userId: session.user.id,
    userRole: role,
    prisma: ctx.db as ServiceContext["prisma"],
  };
}

export const adminClassificationsRouter = {
  // Accessible to all authenticated users
  getAll: protectedProcedure.handler(async ({ context }) =>
    classificationService.getClassificationLevels(toServiceCtx(context, "VIEWER"))
  ),

  create: adminProcedure
    .input(CreateClassificationInputSchema)
    .handler(async ({ input, context }) =>
      classificationService.createClassification(input, toServiceCtx(context))
    ),

  update: adminProcedure
    .input(UpdateClassificationInputSchema)
    .handler(async ({ input, context }) =>
      classificationService.updateClassification(input, toServiceCtx(context))
    ),

  delete: adminProcedure
    .input(z.object({ id: z.string() }))
    .handler(async ({ input, context }) =>
      classificationService.deleteClassification(input.id, toServiceCtx(context))
    ),
};
