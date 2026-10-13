import { Prisma } from "@/generated/prisma/client";
import { prisma } from "@/lib/db";

export class AuditUserMissingError extends Error {
  constructor(userId: string) {
    super(
      `Authenticated user "${userId}" no longer exists. Sign out and sign in again before making changes.`
    );
    this.name = "AuditUserMissingError";
  }
}

type UserLookupDelegate = {
  findUnique: (args: {
    where: { id: string };
    select: { id: true };
  }) => Promise<{ id: string } | null>;
};

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
  const userDelegate = (prisma as unknown as { user?: UserLookupDelegate })
    .user;
  if (typeof userDelegate?.findUnique === "function") {
    const user = await userDelegate.findUnique({
      where: { id: userId },
      select: { id: true },
    });

    if (!user) {
      throw new AuditUserMissingError(userId);
    }
  }

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
