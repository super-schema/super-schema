import type { PrismaClient, Prisma } from "@/generated/prisma/client";
import { resolveScope, type ScopeTarget } from "@/lib/asset-scope";
import { validateScope, type LevelKind, type LevelScope } from "@/lib/levels";
import { assertNameAvailable, withTenantNameLock, type RegistryKind } from "@/services/name-registry.service";
import { ok, type Result, type ServiceError } from "@/types/result";

type Tx = Prisma.TransactionClient;

/**
 * A Result failure (placement or name registry) carried out of an audited write as a
 * thrown error, so the failure is never audited and callers can map it back to an error.
 */
export class ServiceErrorRejection extends Error {
  constructor(readonly serviceError: ServiceError) {
    super(serviceError.message);
    this.name = "ServiceErrorRejection";
  }
}

/**
 * Check the line-unique name registry and run `write` under the tenant's advisory lock.
 * A registry failure (NAME_CONFLICT or DB_ERROR) returns before `write` is called, so no
 * statement runs on a transaction the registry query may have aborted. A throwing
 * `write` propagates and rolls the transaction back.
 */
export async function writeWithUniqueName<T>(
  db: PrismaClient,
  args: {
    scope: LevelScope;
    name: string;
    exclude?: { kind: RegistryKind; id: string };
    write: (tx: Tx) => Promise<T>;
  }
): Promise<Result<T>> {
  const { scope, name, exclude, write } = args;
  return withTenantNameLock(db, scope.tenantId, async (tx) => {
    const free = await assertNameAvailable(tx, {
      name,
      tenantId: scope.tenantId,
      domainId: scope.domainId,
      productId: scope.productId,
      ...(exclude && { exclude }),
    });
    if (!free.success) return free;
    return ok(await write(tx));
  });
}

/**
 * The one create pattern for level-aware assets (spec §4.1, §4.3):
 * resolve the target to a scope -> validate the kind's placement matrix -> optional
 * caller precondition -> name-registry check + write under the tenant lock.
 * Nothing is locked or written unless scope, placement and precondition all pass.
 */
export async function createInScope<T>(
  db: PrismaClient,
  args: {
    kind: LevelKind;
    target: ScopeTarget;
    name: string;
    exclude?: { kind: RegistryKind; id: string };
    precondition?: (scope: LevelScope) => Result<void>;
    write: (tx: Tx, scope: LevelScope) => Promise<T>;
  }
): Promise<Result<T>> {
  const scope = await resolveScope(db, args.target);
  if (!scope.success) return scope;
  const valid = validateScope(args.kind, scope.data);
  if (!valid.success) return valid;
  const pre = args.precondition?.(scope.data);
  if (pre && !pre.success) return pre;
  return writeWithUniqueName(db, {
    scope: scope.data,
    name: args.name,
    exclude: args.exclude,
    write: (tx) => args.write(tx, scope.data),
  });
}
