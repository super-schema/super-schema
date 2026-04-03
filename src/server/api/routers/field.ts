import { z } from "zod";
import { protectedProcedure } from "../procedures";
import {
  CreateFieldInputSchema,
  UpdateFieldInputSchema,
} from "@/types/schemas/field.schema";
import {
  createField,
  updateField,
  deleteField,
  reorderFields,
} from "@/services/field.service";
import type { ServiceContext } from "@/types/service-context";

function toServiceCtx(ctx: { session: unknown; db: unknown }): ServiceContext {
  const session = ctx.session as { user: { id: string } };
  return {
    userId: session.user.id,
    userRole: "AUTHOR",
    prisma: ctx.db as ServiceContext["prisma"],
  };
}

export const fieldRouter = {
  create: protectedProcedure
    .input(z.object({ entityId: z.string(), data: CreateFieldInputSchema }))
    .handler(async ({ input, context }) =>
      createField(input.entityId, input.data, toServiceCtx(context))
    ),

  update: protectedProcedure
    .input(z.object({ id: z.string(), data: UpdateFieldInputSchema }))
    .handler(async ({ input, context }) =>
      updateField(input.id, input.data, toServiceCtx(context))
    ),

  delete: protectedProcedure
    .input(z.object({ id: z.string() }))
    .handler(async ({ input, context }) =>
      deleteField(input.id, toServiceCtx(context))
    ),

  reorder: protectedProcedure
    .input(z.object({ entityId: z.string(), fieldIds: z.array(z.string()) }))
    .handler(async ({ input, context }) =>
      reorderFields(input.entityId, input.fieldIds, toServiceCtx(context))
    ),
};
