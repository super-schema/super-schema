import type { PrismaClient, Prisma } from "@/generated/prisma/client";
import type { LevelScope } from "@/lib/levels";
import { ok, err, type Result } from "@/types/result";

type Db = PrismaClient | Prisma.TransactionClient;

export type ScopeTarget =
  | { level: "TENANT"; tenantId: string }
  | { level: "DOMAIN"; domainId: string }
  | { level: "PRODUCT"; productId: string };

export async function resolveScope(db: Db, target: ScopeTarget): Promise<Result<LevelScope>> {
  if (target.level === "TENANT") {
    // The tenant must exist: a write under an unknown tenant would otherwise fail later on its foreign key (P2003),
    // which the audited-write mapping reports as "IN_USE".
    const t = await db.tenant.findUnique({ where: { id: target.tenantId }, select: { id: true } });
    if (!t) return err({ code: "NOT_FOUND", message: `Tenant "${target.tenantId}" not found` });
    return ok({ tenantId: t.id, domainId: null, productId: null });
  }
  if (target.level === "DOMAIN") {
    const d = await db.domain.findUnique({ where: { id: target.domainId }, select: { id: true, tenantId: true } });
    if (!d) return err({ code: "NOT_FOUND", message: `Domain "${target.domainId}" not found` });
    return ok({ tenantId: d.tenantId, domainId: d.id, productId: null });
  }
  const p = await db.product.findUnique({
    where: { id: target.productId },
    select: { id: true, domainId: true, domain: { select: { tenantId: true } } },
  });
  if (!p) return err({ code: "NOT_FOUND", message: `Product "${target.productId}" not found` });
  return ok({ tenantId: p.domain.tenantId, domainId: p.domainId, productId: p.id });
}
