import { z } from "zod";
import { protectedProcedure } from "../procedures";
import {
  CreateEntityInputSchema,
  UpdateEntityInputSchema,
  EntityFiltersSchema,
} from "@/types/schemas/entity.schema";
import {
  createEntity,
  getEntities,
  getEntityById,
  updateEntity,
  deleteEntity,
} from "@/services/entity.service";
import type { ServiceContext } from "@/types/service-context";

function toServiceCtx(ctx: { session: unknown; db: unknown }): ServiceContext {
  const session = ctx.session as { user: { id: string } };
  return {
    userId: session.user.id,
    userRole: "AUTHOR", // TODO: resolve from RBAC in Story 8.1
    prisma: ctx.db as ServiceContext["prisma"],
  };
}

export const entityRouter = {
  create: protectedProcedure
    .input(CreateEntityInputSchema)
    .handler(async ({ input, context }) =>
      createEntity(input, toServiceCtx(context))
    ),

  list: protectedProcedure
    .input(EntityFiltersSchema)
    .handler(async ({ input, context }) =>
      getEntities(input, toServiceCtx(context))
    ),

  getById: protectedProcedure
    .input(z.object({ id: z.string() }))
    .handler(async ({ input, context }) =>
      getEntityById(input.id, toServiceCtx(context))
    ),

  update: protectedProcedure
    .input(z.object({ id: z.string(), data: UpdateEntityInputSchema }))
    .handler(async ({ input, context }) =>
      updateEntity(input.id, input.data, toServiceCtx(context))
    ),

  delete: protectedProcedure
    .input(z.object({ id: z.string() }))
    .handler(async ({ input, context }) =>
      deleteEntity(input.id, toServiceCtx(context))
    ),
};
