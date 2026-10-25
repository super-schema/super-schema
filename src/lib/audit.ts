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

/**
 * Records that something FAILED (`EMISSION_FAILED`, `COMPILATION_ERROR`: the Admin > Health error cards count them), best effort: the
 * failure is already what the caller answers, so a problem writing its row (a user who no longer exists, the database) is logged and
 * never replaces or hides it. Never throws. `details` is kept small (a message, a target): it is read by an administrator.
 */
export async function recordAuditFailure(params: {
  action: "EMISSION_FAILED" | "COMPILATION_ERROR";
  entityType: string;
  entityId: string;
  userId: string;
  details: Record<string, unknown>;
}): Promise<void> {
  try {
    await prisma.auditLog.create({
      data: {
        action: params.action,
        entityType: params.entityType,
        entityId: params.entityId,
        userId: params.userId,
        afterState: params.details as Prisma.InputJsonValue,
      },
    });
  } catch (e) {
    console.error(`[audit] could not record ${params.action} for ${params.entityType} ${params.entityId}`, e);
  }
}

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
