/**
 * Domain Admin Service — domain workspace management with policy templates.
 *
 * Handles domain CRUD for the admin panel, policy template application, and inheritance tracking. Domains are the rows of the
 * `domains` table, read and written through `ctx.prisma`: the very rows the explorer sidebar and the Domains page list, in the tenant
 * the user is viewing. The service keeps no state of its own, so a domain made here is there after a restart.
 */

import { Prisma } from "@/generated/prisma/client";
import { ctxCan, effectiveRole, type ActionId } from "@/lib/access";
import { getActiveTenantId } from "@/lib/active-tenant";
import { AuditUserMissingError, withAudit } from "@/lib/audit";
import { domainDeleteBlocker } from "@/lib/domain-deletion";
import { EVENTS_ASSET_COUNT_SELECT } from "@/lib/product-deletion";
import { generateSlug, isReservedSchemaRouteSlug } from "@/lib/slug";
import { createDomainRow } from "@/services/domain-row.service";
import { ok, err } from "@/types/result";
import type { Result } from "@/types/result";
import type { ServiceContext } from "@/types/service-context";
import {
  PolicyTemplateSchema,
  CreateDomainAdminInputSchema,
  UpdateDomainAdminInputSchema,
  type PolicyTemplate,
  type DomainWithStats,
  type InheritedMetadata,
  type CreateDomainAdminInput,
  type UpdateDomainAdminInput,
} from "@/types/schemas/domain-policy";

export interface DomainRecord {
  id: string;
  name: string;
  description: string;
  policyTemplate: PolicyTemplate | null;
  isSystem: boolean;
  createdAt: Date;
  updatedAt: Date;
}

interface DomainRow {
  id: string;
  name: string;
  description: string;
  policyTemplate: Prisma.JsonValue | null;
  isSystem: boolean;
  createdAt: Date;
  updatedAt: Date;
}

const forbidden = () =>
  err({
    code: "FORBIDDEN",
    message: "You do not have permission to do this",
    suggestedFix: "Contact your administrator",
  });

/** The tenant the caller works in: the one the action put in the context, else the one in view (the cookie the principal may access). */
const tenantOf = async (ctx: ServiceContext): Promise<string> => ctx.tenantId ?? (await getActiveTenantId());

/**
 * May the caller do `action` over the domain `domainId` of the tenant? Null when allowed; else the refusal: a domain nothing of the caller's covers
 * reads as missing (the answer for a domain that does not exist), one they see but may not change is a generic FORBIDDEN.
 */
function refusalOver(ctx: ServiceContext, action: ActionId, tenantId: string, domainId: string) {
  const place = { tenantId, domainId };
  if (ctxCan(ctx, action, place)) return null;
  return effectiveRole([...(ctx.assignments ?? [])], place) === null ? domainNotFound(domainId) : forbidden();
}

const domainNotFound = (id: string) =>
  err({
    code: "NOT_FOUND",
    message: `Domain with ID "${id}" not found`,
    suggestedFix: "Verify the domain ID.",
  });

const duplicateName = (name: string) =>
  err({
    code: "DUPLICATE",
    message: `A domain named "${name}" already exists`,
    suggestedFix: "Choose a different domain name.",
  });

const isPrismaCode = (e: unknown, code: string): boolean =>
  typeof e === "object" && e !== null && (e as { code?: unknown }).code === code;

/**
 * A template stored with a FRACTIONAL retention period (stored before the editor and the server required a whole number: 0.5, 2.5) is
 * read with the period rounded UP to a whole number of at least 1, so it stays a template instead of reading as "No template". Nothing is
 * rewritten (saving the template writes the whole number). Any other fault of the template is not tolerated.
 */
function withWholeRetentionPeriod(value: Prisma.JsonValue): Prisma.JsonValue {
  if (value === null || typeof value !== "object" || Array.isArray(value)) return value;
  const retention = (value as { retentionPolicy?: unknown }).retentionPolicy;
  if (retention === null || typeof retention !== "object" || Array.isArray(retention)) return value;
  const period = (retention as { period?: unknown }).period;
  if (typeof period !== "number" || !Number.isFinite(period) || Number.isInteger(period)) return value;
  return { ...(value as object), retentionPolicy: { ...(retention as object), period: Math.max(1, Math.ceil(period)) } } as Prisma.JsonValue;
}

/** A stored template that is not a template (hand-edited JSON) reads as no template, not as a crash on every page load. */
function parseTemplate(value: Prisma.JsonValue | null): PolicyTemplate | null {
  if (value === null) return null;
  const parsed = PolicyTemplateSchema.safeParse(withWholeRetentionPeriod(value));
  return parsed.success ? parsed.data : null;
}

function toRecord(row: DomainRow): DomainRecord {
  return {
    id: row.id,
    name: row.name,
    description: row.description,
    policyTemplate: parseTemplate(row.policyTemplate),
    isSystem: row.isSystem,
    createdAt: row.createdAt,
    updatedAt: row.updatedAt,
  };
}

/** The slug a name gets (the URL of the domain), or an error when it has none or names a utility page of /schemas. */
function slugFor(name: string): Result<string> {
  const slug = generateSlug(name);
  if (slug === "") {
    return err({
      code: "VALIDATION_ERROR",
      message: "Domain name must contain at least one letter or digit",
      suggestedFix: "Use a name with letters or digits.",
    });
  }
  if (isReservedSchemaRouteSlug(slug)) {
    return err({
      code: "VALIDATION_ERROR",
      message: `"${slug}" is reserved for a schemas utility page`,
      suggestedFix: "Choose a different domain name.",
    });
  }
  return ok(slug);
}

/** The audit trail of a mutation names the acting user; a session whose user no longer exists is told to sign in again. */
const staleSession = () =>
  err({
    code: "UNAUTHORIZED",
    message: "Your session is stale. Sign out and sign in again, then retry.",
    suggestedFix: "Sign out and sign in again.",
  });

// ---------------------------------------------------------------------------
// getDomains — fetch all domains of the active tenant with stats (Admin only)
// ---------------------------------------------------------------------------

export async function getDomainsAdmin(
  ctx: ServiceContext
): Promise<Result<DomainWithStats[]>> {
  const tenantId = await tenantOf(ctx);
  if (!ctxCan(ctx, "tenant.access", { tenantId })) return forbidden();

  const rows = await ctx.prisma.domain.findMany({
    where: { tenantId },
    orderBy: [{ isSystem: "desc" }, { name: "asc" }],
    include: { _count: { select: { entities: true } } },
  });

  // Only the domains the caller's roles cover (`domain.read`): a domain-scoped role lists its domain, a tenant-wide role every one.
  return ok(
    rows.filter((row) => ctxCan(ctx, "domain.read", { tenantId, domainId: row.id })).map((row) => {
      const policyTemplate = parseTemplate(row.policyTemplate);
      return {
        id: row.id,
        name: row.name,
        description: row.description,
        policyTemplate,
        policyTemplateStatus: policyTemplate ? ("Configured" as const) : ("No template" as const),
        entityCount: row._count.entities,
        isSystem: row.isSystem,
        createdAt: row.createdAt,
        updatedAt: row.updatedAt,
      };
    })
  );
}

// ---------------------------------------------------------------------------
// getDomainById — Admin only; a domain of the active tenant, any other reads as missing
// ---------------------------------------------------------------------------

export async function getDomainAdminById(
  id: string,
  ctx: ServiceContext
): Promise<Result<DomainRecord>> {
  const tenantId = await tenantOf(ctx);
  const row = await ctx.prisma.domain.findFirst({ where: { id, tenantId } });
  if (!row) return domainNotFound(id);
  const refused = refusalOver(ctx, "domain.read", tenantId, row.id);
  if (refused) return refused;
  return ok(toRecord(row));
}

// ---------------------------------------------------------------------------
// createDomain — Admin only
// ---------------------------------------------------------------------------

export async function createDomainAdmin(
  input: CreateDomainAdminInput,
  ctx: ServiceContext
): Promise<Result<DomainRecord>> {
  // Making a domain is a tenant-level decision (a steward or above over the whole tenant).
  if (!ctxCan(ctx, "domain.create", { tenantId: await tenantOf(ctx) })) return forbidden();

  const parsed = CreateDomainAdminInputSchema.safeParse(input);
  if (!parsed.success) {
    return err({
      code: "VALIDATION_ERROR",
      message: parsed.error.issues[0].message,
      suggestedFix: "Check the domain input fields.",
    });
  }

  try {
    // The row itself (name, slug, duplicate check, tenant, audit) is `createDomainRow`'s: the Domains page's action makes it the same way.
    const created = await createDomainRow(
      { name: parsed.data.name, description: parsed.data.description, policyTemplate: parsed.data.policyTemplate, userId: ctx.userId },
      ctx.prisma
    );
    if (!created.success) return created;
    return ok(toRecord(created.data));
  } catch (e: unknown) {
    if (e instanceof AuditUserMissingError) return staleSession();
    throw e;
  }
}

// ---------------------------------------------------------------------------
// updateDomain — Admin only
// ---------------------------------------------------------------------------

export async function updateDomainAdmin(
  input: UpdateDomainAdminInput,
  ctx: ServiceContext
): Promise<Result<DomainRecord>> {
  const tenantId = await tenantOf(ctx);
  // Nobody learns what a valid input looks like without a role over some domain of the tenant.
  if (!ctxCan(ctx, "tenant.access", { tenantId })) return forbidden();

  const parsed = UpdateDomainAdminInputSchema.safeParse(input);
  if (!parsed.success) {
    return err({
      code: "VALIDATION_ERROR",
      message: parsed.error.issues[0].message,
      suggestedFix: "Check the domain input fields.",
    });
  }

  const existing = await ctx.prisma.domain.findFirst({ where: { id: parsed.data.id, tenantId } });
  if (!existing) return domainNotFound(parsed.data.id);
  const refused = refusalOver(ctx, "domain.update", tenantId, existing.id);
  if (refused) return refused;

  const data: Prisma.DomainUpdateInput = {};

  const newName = parsed.data.name?.trim();
  if (newName !== undefined && newName !== existing.name) {
    // A system domain keeps its name: the app finds "Public" and "Playground" by it.
    if (existing.isSystem) {
      return err({
        code: "CONFLICT",
        message: "System domains cannot be renamed",
        suggestedFix: "Change the description or the policy template instead.",
      });
    }
    const slug = slugFor(newName);
    if (!slug.success) return slug;
    const duplicate = await ctx.prisma.domain.findFirst({
      where: { tenantId, id: { not: existing.id }, name: { equals: newName, mode: "insensitive" } },
      select: { id: true },
    });
    if (duplicate) return duplicateName(newName);
    // The slug is the name's address (a create derives it the same way), so it follows the name.
    data.name = newName;
    data.slug = slug.data;
  }
  if (parsed.data.description !== undefined) data.description = parsed.data.description;
  if (parsed.data.policyTemplate !== undefined) data.policyTemplate = parsed.data.policyTemplate as Prisma.InputJsonValue;

  try {
    const updated = await withAudit({
      action: "UPDATE",
      entityType: "Domain",
      entityId: existing.id,
      userId: ctx.userId,
      beforeState: existing as unknown as object,
      fn: () => ctx.prisma.domain.update({ where: { id: existing.id }, data }),
    });
    return ok(toRecord(updated));
  } catch (e: unknown) {
    if (e instanceof AuditUserMissingError) return staleSession();
    if (isPrismaCode(e, "P2002")) return duplicateName(newName ?? existing.name);
    if (isPrismaCode(e, "P2025")) return domainNotFound(parsed.data.id);
    throw e;
  }
}

// ---------------------------------------------------------------------------
// deleteDomain — Admin only; never a system domain; blocked while it owns entities or events assets
// ---------------------------------------------------------------------------

export async function deleteDomainAdmin(
  id: string,
  ctx: ServiceContext
): Promise<Result<void>> {
  // Deleting a domain is a tenant administrator's act over the whole tenant (a domain-scoped administrator does not reach it).
  const tenantId = await tenantOf(ctx);
  if (!ctxCan(ctx, "domain.delete", { tenantId })) return forbidden();

  const domain = await ctx.prisma.domain.findFirst({
    where: { id, tenantId },
    include: { _count: { select: { entities: true, ...EVENTS_ASSET_COUNT_SELECT } } },
  });
  if (!domain) return domainNotFound(id);

  if (domain.isSystem) {
    return err({
      code: "CONFLICT",
      message: "System domains cannot be deleted",
      suggestedFix: "Only domains you created can be deleted.",
    });
  }

  const blocker = domainDeleteBlocker(domain._count);
  if (blocker) {
    return err({
      code: "CONFLICT",
      message: blocker,
      suggestedFix: "Remove all entities and events from this domain before deleting it.",
    });
  }

  try {
    await withAudit({
      action: "DELETE",
      entityType: "Domain",
      entityId: domain.id,
      userId: ctx.userId,
      beforeState: domain as unknown as object,
      fn: async () => {
        await ctx.prisma.domain.delete({ where: { id: domain.id } });
        return null;
      },
    });
  } catch (e: unknown) {
    if (e instanceof AuditUserMissingError) return staleSession();
    if (isPrismaCode(e, "P2025")) return domainNotFound(id);
    throw e;
  }
  return ok(undefined);
}

// ---------------------------------------------------------------------------
// applyPolicyTemplate — merge template values into field decorators
// ---------------------------------------------------------------------------

export function applyPolicyTemplate(
  domain: DomainRecord,
  existingDecorators: Record<string, unknown>
): { decorators: Record<string, unknown>; inherited: InheritedMetadata | null } {
  if (!domain.policyTemplate) {
    return { decorators: existingDecorators, inherited: null };
  }

  const template = domain.policyTemplate;
  const result = { ...existingDecorators };
  const inheritedKeys: string[] = [];

  // Apply classification if not already set
  if (template.classification && !getNestedValue(result, "classification.level")) {
    result.classification = {
      ...(result.classification as Record<string, unknown> ?? {}),
      level: template.classification,
    };
    inheritedKeys.push("classification");
  }

  // Apply retention if not already set
  if (template.retention && !getNestedValue(result, "policy.retention")) {
    result.policy = {
      ...(result.policy as Record<string, unknown> ?? {}),
      retention: template.retention,
    };
    inheritedKeys.push("retention");
  }

  // Apply quality rules if not already set
  if (template.qualityRules && !getNestedValue(result, "quality.rules")) {
    result.quality = {
      ...(result.quality as Record<string, unknown> ?? {}),
      rules: template.qualityRules,
    };
    inheritedKeys.push("qualityRules");
  }

  if (inheritedKeys.length === 0) {
    return { decorators: result, inherited: null };
  }

  const inherited: InheritedMetadata = {
    domainId: domain.id,
    domainName: domain.name,
    keys: inheritedKeys,
  };

  result._inherited = inherited;

  return { decorators: result, inherited };
}

// ---------------------------------------------------------------------------
// removeInheritance — remove a key from inherited metadata
// ---------------------------------------------------------------------------

export function removeInheritance(
  decorators: Record<string, unknown>,
  decoratorKey: string
): Record<string, unknown> {
  const result = { ...decorators };
  const inherited = result._inherited as InheritedMetadata | undefined;

  if (!inherited) return result;

  const keys = inherited.keys.filter((k) => k !== decoratorKey);

  if (keys.length === 0) {
    delete result._inherited;
  } else {
    result._inherited = { ...inherited, keys };
  }

  return result;
}

// ---------------------------------------------------------------------------
// Utility
// ---------------------------------------------------------------------------

function getNestedValue(obj: Record<string, unknown>, path: string): unknown {
  const parts = path.split(".");
  let current: unknown = obj;
  for (const part of parts) {
    if (current == null || typeof current !== "object") return undefined;
    current = (current as Record<string, unknown>)[part];
  }
  return current;
}
