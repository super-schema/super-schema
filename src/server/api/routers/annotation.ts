import { z } from "zod";
import { protectedProcedure } from "../procedures";
import { CreateAnnotationInputSchema } from "@/types/schemas/compliance";
import {
  createAnnotation,
  getAnnotations,
  resolveAnnotation,
  getAnnotationCounts,
  searchUsers,
} from "@/services/annotation.service";
import type { ServiceContext } from "@/types/service-context";

function toServiceCtx(ctx: { session: unknown; db: unknown }): ServiceContext {
  const session = ctx.session as { user: { id: string } };
  return {
    userId: session.user.id,
    userRole: "AUTHOR",
    prisma: ctx.db as ServiceContext["prisma"],
  };
}

export const annotationRouter = {
  create: protectedProcedure
    .input(CreateAnnotationInputSchema)
    .handler(async ({ input, context }) =>
      createAnnotation(input, toServiceCtx(context))
    ),

  getByEntity: protectedProcedure
    .input(z.object({ entityId: z.string() }))
    .handler(async ({ input, context }) => {
      const ctx = toServiceCtx(context);
      return getAnnotations(input.entityId, undefined, ctx);
    }),

  getByField: protectedProcedure
    .input(z.object({ fieldId: z.string() }))
    .handler(async ({ input, context }) => {
      const ctx = toServiceCtx(context);
      return getAnnotations(undefined, input.fieldId, ctx);
    }),

  resolve: protectedProcedure
    .input(z.object({ id: z.string() }))
    .handler(async ({ input, context }) =>
      resolveAnnotation(input.id, toServiceCtx(context))
    ),

  getCounts: protectedProcedure
    .input(z.object({ entityId: z.string() }))
    .handler(async ({ input, context }) =>
      getAnnotationCounts(input.entityId, toServiceCtx(context))
    ),

  searchUsers: protectedProcedure
    .input(z.object({ query: z.string() }))
    .handler(async ({ input, context }) =>
      searchUsers(input.query, toServiceCtx(context))
    ),
};
