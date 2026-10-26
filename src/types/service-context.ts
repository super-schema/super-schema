import type { PrismaClient } from "@/generated/prisma/client";
import type { Assignment } from "@/types/schemas/rbac";

export type ServiceContext = {
  userId: string;
  /**
   * The role the caller holds AT PLATFORM (GLOBAL) SCOPE and nothing else, the lowest rung when none. A label kept for the services
   * that still compare it; it says nothing about a tenant, a domain or a product, so it must never decide a permission over a resource.
   * Those decisions are `authorize` / `authorizeInActiveTenant` (src/lib/action-context.ts) and, inside a service, `can` / `grantAllowed`
   * over `assignments`. New code does not read this.
   *
   * @deprecated Ask the policy (`@/lib/access`) instead; `tests/unit/access/no-role-label.test.ts` keeps the list of readers shrinking.
   */
  userRole: string;
  /**
   * The caller's role assignments, as the principal the caller was authorized with holds them (`contextOf`). A service that must judge
   * for itself asks `can(ctx.assignments, action, resource)` / `grantAllowed(...)`; a context that carries none (older callers, tests)
   * allows nothing, never everything.
   */
  assignments?: readonly Assignment[];
  domainId?: string;
  /**
   * The tenant being viewed, for the services that read across entities (the compliance queries). Absent = no tenant filter (a caller that
   * is not a page, a test). The page routes set it from the `active_tenant` cookie.
   */
  tenantId?: string;
  prisma: PrismaClient;
};
