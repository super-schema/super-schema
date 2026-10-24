import type { PrismaClient } from "@/generated/prisma/client";

export type ServiceContext = {
  userId: string;
  userRole: string;
  domainId?: string;
  /**
   * The tenant being viewed, for the services that read across entities (the compliance queries). Absent = no tenant filter (a caller that
   * is not a page, a test). The page routes set it from the `active_tenant` cookie.
   */
  tenantId?: string;
  prisma: PrismaClient;
};
