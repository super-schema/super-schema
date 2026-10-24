/**
 * The ONE place a Domain row is made. Three entry points make domains (the Domains page's `createDomainAction`, the Admin tab's
 * `createDomainAdmin`, the tRPC `createDomain`); they differ in WHO may ask (a signed-in user, an ADMIN), and nothing else, so what a
 * domain row must be lives here: a name of 1 to 64 characters whose slug is not empty and not a utility page of /schemas, unique in the
 * tenant being viewed whatever its case, made in that tenant, with an audit row naming the user.
 *
 * Returns a Result for what the caller can fix (validation, duplicate). Anything else THROWS, including `AuditUserMissingError` (a
 * session whose user no longer exists): each entry point says that in its own words.
 */

import type { Domain, Prisma, PrismaClient } from "@/generated/prisma/client";
import { getActiveTenantId } from "@/lib/active-tenant";
import { withAudit } from "@/lib/audit";
import { ensureDefaultTenantId } from "@/lib/org-defaults";
import { generateSlug, isReservedSchemaRouteSlug } from "@/lib/slug";
import { err, ok } from "@/types/result";
import type { Result } from "@/types/result";

const MAX_NAME_LENGTH = 64;

export interface CreateDomainRowInput {
  name: string;
  description?: string;
  /** Already validated by the caller (each entry point has its own template schema). */
  policyTemplate?: object;
  /** The acting user: the audit row names them. */
  userId: string;
}

const duplicate = (name: string) =>
  err({
    code: "DUPLICATE",
    message: `A domain named "${name}" already exists`,
    suggestedFix: "Choose a different domain name.",
  });

/** A unique-constraint refusal: Prisma's P2002, or (a driver that does not set the code) its text. */
function isUniqueViolation(e: unknown): boolean {
  if (typeof e !== "object" || e === null) return false;
  if ((e as { code?: unknown }).code === "P2002") return true;
  return e instanceof Error && e.message.includes("Unique constraint");
}

export async function createDomainRow(input: CreateDomainRowInput, db: PrismaClient): Promise<Result<Domain>> {
  const name = input.name.trim();
  if (name === "") return err({ code: "VALIDATION_ERROR", message: "Domain name is required", suggestedFix: "Check the domain input fields." });
  if (name.length > MAX_NAME_LENGTH) {
    return err({ code: "VALIDATION_ERROR", message: `Domain name must be ${MAX_NAME_LENGTH} characters or less`, suggestedFix: "Check the domain input fields." });
  }

  // The slug is the domain's address: a name with no letter or digit has none, and some are the pages beside it.
  const slug = generateSlug(name);
  if (slug === "") {
    return err({ code: "VALIDATION_ERROR", message: "Domain name must contain at least one letter or digit", suggestedFix: "Use a name with letters or digits." });
  }
  if (isReservedSchemaRouteSlug(slug)) {
    return err({ code: "VALIDATION_ERROR", message: `"${slug}" is reserved for a schemas utility page`, suggestedFix: "Choose a different domain name." });
  }

  // A new domain belongs to the tenant being viewed; a fresh install has none until the default one is made.
  await ensureDefaultTenantId(db);
  const tenantId = await getActiveTenantId();

  // Unique name per tenant, case-insensitively (the database's own unique index is case-sensitive).
  const existing = await db.domain.findFirst({ where: { tenantId, name: { equals: name, mode: "insensitive" } }, select: { id: true } });
  if (existing) return duplicate(name);

  try {
    const created = await withAudit({
      action: "CREATE",
      entityType: "Domain",
      entityId: "pending",
      userId: input.userId,
      fn: () =>
        db.domain.create({
          data: {
            name,
            slug,
            description: input.description ?? "",
            tenantId,
            ...(input.policyTemplate ? { policyTemplate: input.policyTemplate as Prisma.InputJsonValue } : {}),
          },
        }),
    });
    return ok(created);
  } catch (e: unknown) {
    // The same slug from another spelling ("Order Data" / "order-data") is caught by the unique index, not by the name check.
    if (isUniqueViolation(e)) return duplicate(name);
    throw e;
  }
}
