// src/services/events/pins.ts
import type { PrismaClient, Prisma } from "@/generated/prisma/client";
import type { EntityPin } from "@/lib/events/types";
import { ok, err, type Result } from "@/types/result";

type Db = PrismaClient | Prisma.TransactionClient;

/** D5: `entityVersionId` omitted → latest published version; `null` → unpinned (draft preview only). */
export interface PinInput {
  entityId: string;
  entityVersionId?: string | null;
}

export async function resolvePin(db: Db, tenantId: string, input: PinInput, label: string): Promise<Result<EntityPin>> {
  const entity = await db.entity.findFirst({
    where: { id: input.entityId, tenantId },
    select: { id: true, name: true, latestVersionId: true },
  });
  if (!entity) return err({ code: "VALIDATION_ERROR", message: `${label}: entity "${input.entityId}" not found in this tenant` });
  if (input.entityVersionId === undefined) return ok({ entityId: entity.id, entityVersionId: entity.latestVersionId });
  if (input.entityVersionId === null) return ok({ entityId: entity.id, entityVersionId: null });
  const version = await db.entityVersion.findUnique({ where: { id: input.entityVersionId }, select: { entityId: true } });
  if (!version || version.entityId !== entity.id) {
    return err({ code: "VALIDATION_ERROR", message: `${label}: "${input.entityVersionId}" is not a published version of ${entity.name}` });
  }
  return ok({ entityId: entity.id, entityVersionId: input.entityVersionId });
}
