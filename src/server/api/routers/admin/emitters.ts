/**
 * Admin Emitters oRPC Router — emitter configuration and type mapping admin.
 * All routes require Admin role via adminProcedure.
 */

import { z } from "zod";
import { adminProcedure } from "../../procedures";
import {
  UpdateEmitterConfigInputSchema,
  TestEmitterInputSchema,
  CreateTypeMappingOverrideInputSchema,
} from "@/types/schemas/emitter-config";
import * as emitterConfigService from "@/services/emitter-config.service";
import type { ServiceContext } from "@/types/service-context";

function toServiceCtx(ctx: { session: unknown; db: unknown }): ServiceContext {
  const session = ctx.session as { user: { id: string } };
  return {
    userId: session.user.id,
    userRole: "ADMIN",
    prisma: ctx.db as ServiceContext["prisma"],
  };
}

export const adminEmittersRouter = {
  getAll: adminProcedure.handler(async ({ context }) =>
    emitterConfigService.getEmitterConfigs(toServiceCtx(context))
  ),

  getByName: adminProcedure
    .input(z.object({ name: z.string() }))
    .handler(async ({ input, context }) =>
      emitterConfigService.getEmitterConfigByName(input.name, toServiceCtx(context))
    ),

  updateConfig: adminProcedure
    .input(UpdateEmitterConfigInputSchema)
    .handler(async ({ input, context }) =>
      emitterConfigService.updateEmitterConfig(input, toServiceCtx(context))
    ),

  test: adminProcedure
    .input(TestEmitterInputSchema)
    .handler(async ({ input, context }) =>
      emitterConfigService.testEmitter(input.emitterName, input.entityId, toServiceCtx(context))
    ),

  getTypeMappings: adminProcedure
    .input(z.object({ targetFormat: z.string() }))
    .handler(async ({ input, context }) =>
      emitterConfigService.getTypeMappingsForTarget(input.targetFormat, toServiceCtx(context))
    ),

  createTypeMappingOverride: adminProcedure
    .input(CreateTypeMappingOverrideInputSchema)
    .handler(async ({ input, context }) =>
      emitterConfigService.createTypeMappingOverride(
        { targetFormat: input.targetFormat, sourceType: input.sourceType, mappedType: input.mappedType },
        toServiceCtx(context)
      )
    ),

  updateTypeMapping: adminProcedure
    .input(z.object({ id: z.string(), mappedType: z.string() }))
    .handler(async ({ input, context }) =>
      emitterConfigService.updateTypeMapping(input.id, input.mappedType, toServiceCtx(context))
    ),

  deleteTypeMappingOverride: adminProcedure
    .input(z.object({ id: z.string() }))
    .handler(async ({ input, context }) =>
      emitterConfigService.deleteTypeMappingOverride(input.id, toServiceCtx(context))
    ),
};
