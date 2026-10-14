import type { PrismaClient, Prisma } from "@/generated/prisma/client";
import { ok, err, type Result } from "@/types/result";
import { levelOf, levelLabel } from "@/lib/levels";

type Db = PrismaClient | Prisma.TransactionClient;

export type RegistryKind = "entity" | "sharedEnum" | "customScalar" | "unionType" | "service";

export interface NamedAsset {
  kind: RegistryKind;
  id: string;
  name: string;
  tenantId: string;
  domainId: string | null;
  productId: string | null;
}

type Placement = Pick<NamedAsset, "tenantId" | "domainId" | "productId">;
type Candidate = Omit<NamedAsset, "id" | "kind"> & { exclude?: { kind: RegistryKind; id: string } };

const KIND_LABEL: Record<RegistryKind, string> = {
  entity: "Entity",
  sharedEnum: "Enum",
  customScalar: "Scalar",
  unionType: "Union",
  service: "API",
};

/** True when one placement is an ancestor-or-self of the other (spec §4.3). */
export function inSameLine(a: Placement, b: Placement): boolean {
  if (a.tenantId !== b.tenantId) return false;
  if (!a.domainId || !b.domainId) return true; // tenant level is in every line
  if (a.domainId !== b.domainId) return false;
  if (!a.productId || !b.productId) return true; // domain level is in every product line of that domain
  return a.productId === b.productId;
}

export function findLineConflict(candidate: Candidate, existing: NamedAsset[]): NamedAsset | null {
  const name = candidate.name.trim().toLowerCase();
  for (const a of existing) {
    if (candidate.exclude && a.kind === candidate.exclude.kind && a.id === candidate.exclude.id) continue;
    if (a.name.trim().toLowerCase() !== name) continue;
    if (inSameLine(candidate, a)) return a;
  }
  return null;
}

/** Load every named asset whose placement could share a line with the candidate. */
async function loadLineCandidates(db: Db, c: Candidate): Promise<NamedAsset[]> {
  const nameFilter = { equals: c.name.trim(), mode: "insensitive" as const };
  const where = { tenantId: c.tenantId, name: nameFilter };
  const select = { id: true, name: true, tenantId: true, domainId: true, productId: true };
  const [entities, enums, scalars, unions, services] = await Promise.all([
    db.entity.findMany({ where, select }),
    db.sharedEnum.findMany({ where, select }),
    db.customScalar.findMany({ where, select }),
    db.unionType.findMany({ where, select }),
    db.serviceDefinition.findMany({ where, select }),
  ]);
  return [
    ...entities.map((r) => ({ ...r, kind: "entity" as const })),
    ...enums.map((r) => ({ ...r, kind: "sharedEnum" as const })),
    ...scalars.map((r) => ({ ...r, kind: "customScalar" as const })),
    ...unions.map((r) => ({ ...r, kind: "unionType" as const })),
    ...services.map((r) => ({ ...r, kind: "service" as const })),
  ];
}

export async function assertNameAvailable(db: Db, candidate: Candidate): Promise<Result<void>> {
  const hit = findLineConflict(candidate, await loadLineCandidates(db, candidate));
  if (!hit) return ok(undefined);
  return err({
    code: "NAME_CONFLICT",
    message: `"${candidate.name}" is already used by ${KIND_LABEL[hit.kind]} "${hit.name}" at ${levelLabel(levelOf(hit))} level.`,
    details: { conflict: hit },
    suggestedFix: "Names must be unique across Enterprise, Domain and Product levels. Choose a different name.",
  });
}

/** Serialize name checks + writes within one tenant (spec §4.3). */
export async function withTenantNameLock<T>(
  db: PrismaClient,
  tenantId: string,
  fn: (tx: Prisma.TransactionClient) => Promise<T>
): Promise<T> {
  return db.$transaction(async (tx) => {
    await tx.$executeRaw`SELECT pg_advisory_xact_lock(hashtext(${tenantId}))`;
    return fn(tx);
  });
}

export async function findNameConflicts(db: Db, tenantId: string): Promise<Array<{ name: string; assets: NamedAsset[] }>> {
  const select = { id: true, name: true, tenantId: true, domainId: true, productId: true };
  const where = { tenantId };
  const [entities, enums, scalars, unions, services] = await Promise.all([
    db.entity.findMany({ where, select }),
    db.sharedEnum.findMany({ where, select }),
    db.customScalar.findMany({ where, select }),
    db.unionType.findMany({ where, select }),
    db.serviceDefinition.findMany({ where, select }),
  ]);
  const all: NamedAsset[] = [
    ...entities.map((r) => ({ ...r, kind: "entity" as const })),
    ...enums.map((r) => ({ ...r, kind: "sharedEnum" as const })),
    ...scalars.map((r) => ({ ...r, kind: "customScalar" as const })),
    ...unions.map((r) => ({ ...r, kind: "unionType" as const })),
    ...services.map((r) => ({ ...r, kind: "service" as const })),
  ];
  const byName = new Map<string, NamedAsset[]>();
  for (const a of all) {
    const key = a.name.trim().toLowerCase();
    byName.set(key, [...(byName.get(key) ?? []), a]);
  }
  const conflicts: Array<{ name: string; assets: NamedAsset[] }> = [];
  for (const [, group] of byName) {
    if (group.length < 2) continue;
    const clashing = group.filter((a) => group.some((b) => b !== a && inSameLine(a, b)));
    if (clashing.length > 0) conflicts.push({ name: clashing[0].name, assets: clashing });
  }
  return conflicts;
}
