import { Prisma } from "@/generated/prisma/client";
import { prisma } from "@/lib/db";

type AuditParams<T> = {
  action: string;
  entityType: string;
  entityId: string;
  userId: string;
  beforeState?: object;
  fn: () => Promise<T>;
};

export async function withAudit<T>({
  action,
  entityType,
  entityId,
  userId,
  beforeState,
  fn,
}: AuditParams<T>): Promise<T> {
  const result = await fn();

  const afterState =
    result !== null && typeof result === "object" ? result : undefined;

  await prisma.auditLog.create({
    data: {
      action,
      entityType,
      entityId,
      userId,
      beforeState:
        beforeState !== undefined
          ? (beforeState as Prisma.InputJsonValue)
          : Prisma.JsonNull,
      afterState:
        afterState !== undefined
          ? (afterState as Prisma.InputJsonValue)
          : Prisma.JsonNull,
    },
  });

  return result;
}
