"use server";

import { prisma } from "@/lib/db";
import { auth } from "@/lib/auth";
import { AuditUserMissingError, withAudit } from "@/lib/audit";
import { revalidatePath } from "next/cache";
import { getActiveTenantId } from "@/lib/active-tenant";
import { inActiveTenant, unexpectedFailure } from "@/lib/action-context";
import { FOREIGN_REFERENCE_MESSAGE, fieldsReferenceAllowed } from "@/lib/references/foreign-reference-guard";
import { generateSlug, reservedEntitySlugMessage } from "@/lib/slug";
import { firstReservedFieldNameMessage } from "@/lib/reserved-field-names";
import { resolveCurrentUserId, STALE_SESSION_ENTITY_ERROR } from "@/lib/current-user";
import { firstInvalidDecimalFactMessage, mapFieldCreateInput } from "@/lib/entity-field-input";
import { createInScope, ServiceErrorRejection } from "@/services/scoped-create.service";
import { entityExtensionsMetadata } from "@/services/imported-entities";
import type { CreateFieldInput } from "../[domainSlug]/actions";

/**
 * Create an Enterprise (tenant-level) entity: no domain, no product. Goes through the
 * shared scoped-create pattern — placement matrix (`entity` is allowed at TENANT) and
 * the line-unique name registry under the tenant lock — and is audited.
 *
 * A tenant-level entity has no `@@unique([slug, productId])` protection (NULL product
 * ids never collide), so slug uniqueness among Enterprise entities is checked here,
 * inside the same lock, to keep `/schemas/enterprise/entities/<slug>` unambiguous.
 */
export async function createTenantEntityAction(data: {
  name: string;
  description: string;
  fields: CreateFieldInput[];
  /** Entity-level vendor extensions of an import (`metadata.custom.extensions`). */
  extensions?: Record<string, unknown>;
}): Promise<{ success: true; entity: { id: string; slug: string } } | { error: string }> {
  const session = await auth();
  if (!session?.user?.id) {
    return { error: "You must be logged in" };
  }

  // `data` and its name arrive from the browser untyped: neither may throw before the `try`.
  const name = typeof data?.name === "string" ? data.name.trim() : "";
  if (name.length === 0) {
    return { error: "Entity name is required" };
  }
  if (name.length > 128) {
    return { error: "Entity name must be 128 characters or less" };
  }

  // Reserved URL segments are rejected before any database work.
  const reservedMsg = reservedEntitySlugMessage(name);
  if (reservedMsg) {
    return { error: reservedMsg };
  }

  // A field named like a key the AsyncAPI parser cannot read is refused by name, before anything is created.
  const reservedField = firstReservedFieldNameMessage(data.fields);
  if (reservedField !== null) return { error: reservedField };

  // A precision or scale the database cannot hold is said by name here, not an unexpected failure of the create.
  const badDecimalFact = firstInvalidDecimalFactMessage(data.fields);
  if (badDecimalFact !== null) return { error: badDecimalFact };

  const slug = generateSlug(name);

  try {
    // An entity id inside a field's decorators is what publish pins and the renderers load: it must be an entity of the active tenant.
    if (!(await fieldsReferenceAllowed(data.fields, (id) => inActiveTenant("entity", id)))) return { error: FOREIGN_REFERENCE_MESSAGE };

    const [tenantId, userId] = await Promise.all([
      getActiveTenantId(),
      resolveCurrentUserId(session.user),
    ]);

    const entity = await withAudit({
      action: "CREATE",
      entityType: "Entity",
      entityId: "pending",
      userId,
      fn: async () => {
        const created = await createInScope(prisma, {
          kind: "entity",
          target: { level: "TENANT", tenantId },
          name,
          write: async (tx, scope) => {
            const slugTaken = await tx.entity.findFirst({
              where: { ...scope, slug },
              select: { id: true },
            });
            if (slugTaken) {
              throw new ServiceErrorRejection({
                code: "NAME_CONFLICT",
                message: `An Enterprise entity with the URL name "${slug}" already exists`,
              });
            }
            return tx.entity.create({
              data: {
                name,
                slug,
                ...scope,
                description: data.description,
                ownerId: userId,
                ...entityExtensionsMetadata(data.extensions),
                ...(data.fields.length > 0 && {
                  fields: { create: data.fields.map(mapFieldCreateInput) },
                }),
              },
            });
          },
        });
        if (!created.success) throw new ServiceErrorRejection(created.error);
        return created.data;
      },
    });

    revalidatePath("/schemas");
    return { success: true, entity: { id: entity.id, slug: entity.slug } };
  } catch (e: unknown) {
    if (e instanceof ServiceErrorRejection) return { error: e.message };
    if (e instanceof AuditUserMissingError) return { error: STALE_SESSION_ENTITY_ERROR };
    return { error: unexpectedFailure("createTenantEntityAction", e).error };
  }
}
