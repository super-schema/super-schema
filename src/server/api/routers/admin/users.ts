/**
 * Admin Users oRPC Router — thin wrapper over user and RBAC services.
 * All routes require Admin role via adminProcedure.
 */

import { z } from "zod";
import { adminProcedure } from "../../procedures";
import { AssignRoleInputSchema, RemoveRoleInputSchema } from "@/types/schemas/rbac";
import { UpdateUserInputSchema } from "@/types/schemas/user";
import * as rbacService from "@/services/rbac.service";
import * as userService from "@/services/user.service";
import type { ServiceContext } from "@/types/service-context";

function toServiceCtx(ctx: { session: unknown; db: unknown }): ServiceContext {
  const session = ctx.session as { user: { id: string } };
  return {
    userId: session.user.id,
    userRole: "ADMIN",
    prisma: ctx.db as ServiceContext["prisma"],
  };
}

export const adminUsersRouter = {
  getAll: adminProcedure.handler(async ({ context }) =>
    userService.getUsers(toServiceCtx(context))
  ),

  getById: adminProcedure
    .input(z.object({ id: z.string() }))
    .handler(async ({ input, context }) =>
      userService.getUserById(input.id, toServiceCtx(context))
    ),

  update: adminProcedure
    .input(UpdateUserInputSchema)
    .handler(async ({ input, context }) =>
      userService.updateUser(input, toServiceCtx(context))
    ),

  getRoles: adminProcedure
    .input(z.object({ userId: z.string() }))
    .handler(async ({ input, context }) =>
      rbacService.getUserRoles(input.userId, toServiceCtx(context))
    ),

  assignRole: adminProcedure
    .input(AssignRoleInputSchema)
    .handler(async ({ input, context }) =>
      rbacService.assignRole(input, toServiceCtx(context))
    ),

  removeRole: adminProcedure
    .input(RemoveRoleInputSchema)
    .handler(async ({ input, context }) =>
      rbacService.removeRole(input.id, toServiceCtx(context))
    ),
};
