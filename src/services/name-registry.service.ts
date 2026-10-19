import type { PrismaClient, Prisma } from "@/generated/prisma/client";
import { dbErrorResult } from "@/lib/db-error";
import { ok, err, type Result } from "@/types/result";
import { levelOf, levelLabel } from "@/lib/levels";
import { reservedNameMessage } from "@/lib/reserved-field-names";

type Db = PrismaClient | Prisma.TransactionClient;

export type RegistryKind =
  | "entity" | "sharedEnum" | "customScalar" | "unionType" | "service"
  | "trait" | "eventSpec";

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

/**
 * Prisma delegate name behind each RegistryKind. Hand-built fake databases in tests must provide a
 * `findMany` for every value here (see `emptyRegistryDelegates` in tests/helpers/registry-mocks.ts);
 * both `Record<RegistryKind, …>` constraints make adding a kind a compile error until it is listed.
 */
export const REGISTRY_DELEGATES = {
  entity: "entity",
  sharedEnum: "sharedEnum",
  customScalar: "customScalar",
  unionType: "unionType",
  service: "serviceDefinition",
  trait: "trait",
  eventSpec: "eventSpec",
} as const satisfies Record<RegistryKind, keyof Db>;

export type RegistryDelegateKey = (typeof REGISTRY_DELEGATES)[RegistryKind];

const KIND_LABEL: Record<RegistryKind, string> = {
  entity: "Entity",
  sharedEnum: "Enum",
  customScalar: "Scalar",
  unionType: "Union",
  service: "API",
  trait: "Trait",
  eventSpec: "Event Spec",
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

type NamedRow = Omit<NamedAsset, "kind">;
type RegistryWhere = { tenantId: string; name?: { equals: string; mode: "insensitive" } };

const NAMED_SELECT = { id: true, name: true, tenantId: true, domainId: true, productId: true } as const;

/**
 * One finder per RegistryKind. The Record type makes adding a kind a compile error until its finder exists.
 */
const FINDERS: Record<RegistryKind, (db: Db, where: RegistryWhere) => Promise<NamedRow[]>> = {
  entity: (db, where) => db.entity.findMany({ where, select: NAMED_SELECT }),
  sharedEnum: (db, where) => db.sharedEnum.findMany({ where, select: NAMED_SELECT }),
  customScalar: (db, where) => db.customScalar.findMany({ where, select: NAMED_SELECT }),
  unionType: (db, where) => db.unionType.findMany({ where, select: NAMED_SELECT }),
  service: (db, where) => db.serviceDefinition.findMany({ where, select: NAMED_SELECT }),
  trait: (db, where) => db.trait.findMany({ where, select: NAMED_SELECT }),
  eventSpec: (db, where) => db.eventSpec.findMany({ where, select: NAMED_SELECT }),
};

/** Run every kind's finder and tag each row with its kind. */
async function loadNamedAssets(db: Db, where: RegistryWhere): Promise<NamedAsset[]> {
  const kinds = Object.keys(FINDERS) as RegistryKind[];
  const perKind = await Promise.all(
    kinds.map(async (kind) => (await FINDERS[kind](db, where)).map((row): NamedAsset => ({ ...row, kind })))
  );
  return perKind.flat();
}

/**
 * A name that is a parser-unsafe key (`PARSER_UNSAFE_KEYS`, wording in `reservedNameMessage`) is not available to any kind: it would become a
 * definition or component key of an AsyncAPI document, which the parser cannot read. Every create and rename of an entity, enum, scalar,
 * union, API, trait and event goes through here (`writeWithUniqueName`). A rename that keeps the name an asset ALREADY has (created before the
 * rule) is not refused, so the asset stays editable.
 */
function reservedNameError(reserved: string): Result<void> {
  return err({ code: "VALIDATION_ERROR", message: reserved });
}

export async function assertNameAvailable(db: Db, candidate: Candidate): Promise<Result<void>> {
  const reserved = reservedNameMessage(candidate.name);
  if (reserved !== null && !candidate.exclude) return reservedNameError(reserved);
  let sameName: NamedAsset[];
  try {
    sameName = await loadNamedAssets(db, {
      tenantId: candidate.tenantId,
      name: { equals: candidate.name.trim(), mode: "insensitive" },
    });
  } catch (e) {
    // The driver text stays in the server log; the Result (also shown by REST routes and forms) gets the generic message.
    return dbErrorResult("assertNameAvailable", e);
  }
  if (reserved !== null) {
    const { exclude } = candidate;
    const unchanged = sameName.some((a) => a.kind === exclude?.kind && a.id === exclude.id && a.name.trim() === candidate.name.trim());
    if (!unchanged) return reservedNameError(reserved);
  }
  const hit = findLineConflict(candidate, sameName);
  if (!hit) return ok(undefined);
  return err({
    code: "NAME_CONFLICT",
    message: `"${candidate.name}" is already used by ${KIND_LABEL[hit.kind]} "${hit.name}" at ${levelLabel(levelOf(hit))} level.`,
    details: { conflict: hit },
    suggestedFix: "Names must be unique across Enterprise, Domain and Product levels. Choose a different name.",
  });
}

/**
 * Serialize name checks + writes within one tenant (spec §4.3).
 * Deliberately lets errors propagate (does not return a Result): a throw is what rolls the transaction back.
 */
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

/** Pure step: group same-name assets and keep only the members that share a line with another member. */
export function groupLineConflicts(all: NamedAsset[]): Array<{ name: string; assets: NamedAsset[] }> {
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

export async function findNameConflicts(db: Db, tenantId: string): Promise<Array<{ name: string; assets: NamedAsset[] }>> {
  return groupLineConflicts(await loadNamedAssets(db, { tenantId }));
}
