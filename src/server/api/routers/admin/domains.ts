/**
 * Admin Domains oRPC Router — domain workspace management.
 * All routes require Admin role via adminProcedure.
 */

import { z } from "zod";
import { adminProcedure } from "../../procedures";
import {
  CreateDomainAdminInputSchema,
  UpdateDomainAdminInputSchema,
} from "@/types/schemas/domain-policy";
import * as domainAdminService from "@/services/domain-admin.service";
import type { ServiceContext } from "@/types/service-context";

function toServiceCtx(ctx: { session: unknown; db: unknown }): ServiceContext {
  const session = ctx.session as { user: { id: string } };
  return {
    userId: session.user.id,
    userRole: "ADMIN",
    prisma: ctx.db as ServiceContext["prisma"],
  };
}

export const adminDomainsRouter = {
  getAll: adminProcedure.handler(async ({ context }) =>
    domainAdminService.getDomainsAdmin(toServiceCtx(context))
  ),

  getById: adminProcedure
    .input(z.object({ id: z.string() }))
    .handler(async ({ input, context }) =>
      domainAdminService.getDomainAdminById(input.id, toServiceCtx(context))
    ),

  create: adminProcedure
    .input(CreateDomainAdminInputSchema)
    .handler(async ({ input, context }) =>
      domainAdminService.createDomainAdmin(input, toServiceCtx(context))
    ),

  update: adminProcedure
    .input(UpdateDomainAdminInputSchema)
    .handler(async ({ input, context }) =>
      domainAdminService.updateDomainAdmin(input, toServiceCtx(context))
    ),

  delete: adminProcedure
    .input(z.object({ id: z.string() }))
    .handler(async ({ input, context }) =>
      domainAdminService.deleteDomainAdmin(input.id, toServiceCtx(context))
    ),
};
