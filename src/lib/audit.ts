import { Prisma } from "@/generated/prisma/client";
import { prisma } from "@/lib/db";
import { redactCredentials } from "@/lib/audit-redaction";

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
  /**
   * The tenant the entry belongs to: the ACTING tenant (`audit_log.tenantId`, what the compliance Audit Trail is scoped by). A caller that has it
   * passes it; `null` says the entry is platform-level (no tenant owns it). Left out, it is the tenant of the row the entry is about
   * (`auditTenantOf`).
   */
  tenantId?: string | null;
  fn: () => Promise<T>;
};

const isText = (value: unknown): value is string => typeof value === "string" && value !== "";
const asRecord = (value: unknown): Record<string, unknown> => (typeof value === "object" && value !== null ? (value as Record<string, unknown>) : {});

/** A delegate that may be missing (a unit test's partial client): the look-ups below are best effort and never assume one. */
type Finder = (args: { where: { id: string }; select: Record<string, unknown> }) => Promise<unknown>;
const finder = (model: string): Finder | null => {
  const delegate = (prisma as unknown as Record<string, { findUnique?: Finder } | undefined>)[model];
  return typeof delegate?.findUnique === "function" ? delegate.findUnique.bind(delegate) : null;
};

async function tenantOf(model: "entity" | "domain" | "eventSpec" | "trait", id: unknown): Promise<string | null> {
  const find = isText(id) ? finder(model) : null;
  const row = find ? asRecord(await find({ where: { id: id as string }, select: { tenantId: true } })) : {};
  return isText(row.tenantId) ? row.tenantId : null;
}

/**
 * The tenant an audit entry belongs to, from what it is about (a caller that does not know the acting tenant, and the 47 that are older than
 * the column): the state of the row names it when the row carries its own tenant (entity, domain, event, trait: a CREATE is written with the
 * placeholder entityId "pending", so its state is all there is), a field and an annotation are found through their entity, a product through
 * its domain. Entries about what no tenant owns (a user, the git connection, a pull request) have none: they are the platform's.
 * `null` is the answer for everything else, and for a row that cannot be found.
 */
export async function auditTenantOf(entry: { entityType: string; entityId: string; beforeState?: unknown; afterState?: unknown }): Promise<string | null> {
  const { entityType, entityId } = entry;
  const after = asRecord(entry.afterState);
  const before = asRecord(entry.beforeState);
  const stated = [after.tenantId, before.tenantId].find(isText) ?? null;
  const real = entityId !== "pending";
  // The row to look up: the one the entry names, or (a CREATE is written with the placeholder "pending") the one the entry's state is, by its own id.
  const subject = real ? entityId : isText(after.id) ? after.id : null;

  switch (entityType) {
    case "Entity":
      return stated ?? (subject ? tenantOf("entity", subject) : null);
    case "EventSpec":
      return stated ?? (subject ? tenantOf("eventSpec", subject) : null);
    case "Trait":
      return stated ?? (subject ? tenantOf("trait", subject) : null);
    case "Domain":
      return stated ?? (subject ? tenantOf("domain", subject) : null);
    case "Field": {
      const entity = [after.entityId, before.entityId].find(isText);
      if (entity) return tenantOf("entity", entity);
      const find = real ? finder("field") : null;
      const row = find ? asRecord(asRecord(await find({ where: { id: entityId }, select: { entity: { select: { tenantId: true } } } })).entity) : {};
      return isText(row.tenantId) ? row.tenantId : null;
    }
    case "Product": {
      const domain = [after.domainId, before.domainId].find(isText);
      if (domain) return tenantOf("domain", domain);
      const find = real ? finder("product") : null;
      const row = find ? asRecord(asRecord(await find({ where: { id: entityId }, select: { domain: { select: { tenantId: true } } } })).domain) : {};
      return isText(row.tenantId) ? row.tenantId : null;
    }
    case "Annotation": {
      // An annotation is recorded against an entity or, when it is on a field, the field.
      const onEntity = await tenantOf("entity", entityId);
      if (onEntity) return onEntity;
      const find = finder("field");
      const row = find && isText(entityId) ? asRecord(asRecord(await find({ where: { id: entityId }, select: { entity: { select: { tenantId: true } } } })).entity) : {};
      return isText(row.tenantId) ? row.tenantId : null;
    }
    default:
      return null;
  }
}

/** The tenant to write: the caller's (`null` = platform-level), else the row's. A look-up that fails is logged and reads as none: an entry is never lost for it. */
async function resolveAuditTenant(params: AuditParams<unknown>, afterState: unknown): Promise<string | null> {
  if (params.tenantId !== undefined) return params.tenantId;
  try {
    return await auditTenantOf({ entityType: params.entityType, entityId: params.entityId, beforeState: params.beforeState, afterState });
  } catch (e) {
    console.error(`[audit] could not tell the tenant of ${params.entityType} ${params.entityId}; the entry is written without one`, e);
    return null;
  }
}

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
  /** The acting tenant (see `withAudit`); left out, it is the tenant of the row the failure is about. */
  tenantId?: string | null;
}): Promise<void> {
  try {
    const tenantId =
      params.tenantId !== undefined ? params.tenantId : await auditTenantOf({ entityType: params.entityType, entityId: params.entityId, afterState: params.details });
    await prisma.auditLog.create({
      data: {
        action: params.action,
        entityType: params.entityType,
        entityId: params.entityId,
        userId: params.userId,
        afterState: redactCredentials(params.details) as Prisma.InputJsonValue,
        ...(tenantId ? { tenantId } : {}),
      },
    });
  } catch (e) {
    console.error(`[audit] could not record ${params.action} for ${params.entityType} ${params.entityId}`, e);
  }
}

export async function withAudit<T>(params: AuditParams<T>): Promise<T> {
  const { action, entityType, entityId, userId, beforeState, fn } = params;
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

  // A row about to be DELETED is gone when the entry is written: its tenant is found first (a CREATE has no row yet: "pending").
  const early = params.tenantId === undefined && entityId !== "pending" ? await resolveAuditTenant(params, undefined) : undefined;

  const result = await fn();

  const afterState =
    result !== null && typeof result === "object" ? result : undefined;

  const entryTenant = params.tenantId !== undefined ? params.tenantId : early ?? (await resolveAuditTenant(params, afterState));

  await prisma.auditLog.create({
    data: {
      action,
      entityType,
      entityId,
      userId,
      beforeState:
        beforeState !== undefined
          ? (redactCredentials(beforeState) as Prisma.InputJsonValue)
          : Prisma.JsonNull,
      afterState:
        afterState !== undefined
          ? (redactCredentials(afterState) as Prisma.InputJsonValue)
          : Prisma.JsonNull,
      // The acting tenant; left out (NULL) for an entry no tenant owns, which only platform administrators read in the Audit Trail.
      ...(entryTenant ? { tenantId: entryTenant } : {}),
    },
  });

  return result;
}
