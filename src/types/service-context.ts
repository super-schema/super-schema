import type { PrismaClient } from "@/generated/prisma/client";

export type ServiceContext = {
  userId: string;
  userRole: string;
  domainId?: string;
  prisma: PrismaClient;
};
