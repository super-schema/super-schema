import { z } from "zod";
import { protectedProcedure } from "../procedures";
import { CreateDomainInputSchema } from "@/types/schemas/domain.schema";
import {
  createDomain,
  getDomains,
  getDomainById,
} from "@/services/domain.service";
import type { ServiceContext } from "@/types/service-context";

function toServiceCtx(ctx: { session: unknown; db: unknown }): ServiceContext {
  const session = ctx.session as { user: { id: string } };
  return {
    userId: session.user.id,
    userRole: "AUTHOR", // TODO: resolve from RBAC in Story 8.1
    prisma: ctx.db as ServiceContext["prisma"],
  };
}

export const domainRouter = {
  create: protectedProcedure
    .input(CreateDomainInputSchema)
    .handler(async ({ input, context }) =>
      createDomain(input, toServiceCtx(context))
    ),

  list: protectedProcedure.handler(async ({ context }) =>
    getDomains(toServiceCtx(context))
  ),

  getById: protectedProcedure
    .input(z.object({ id: z.string() }))
    .handler(async ({ input, context }) =>
      getDomainById(input.id, toServiceCtx(context))
    ),
};
