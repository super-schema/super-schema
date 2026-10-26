"use server";

import { prisma } from "@/lib/db";
import { auth } from "@/lib/auth";
import { AuditUserMissingError, withAudit } from "@/lib/audit";
import { createDomainRow } from "@/services/domain-row.service";
import { resolveGlobalAdminAccess } from "@/lib/access-control";
import { revalidatePath } from "next/cache";
import { isInActiveTenant, unexpectedFailure } from "@/lib/action-context";
import { domainDeleteBlocker } from "@/lib/domain-deletion";
import { combineBlockers, EVENTS_ASSET_COUNT_SELECT } from "@/lib/product-deletion";
import { eventsInUseError, findCrossProductEventRefs } from "@/services/events/event-guards";

export async function getDomainsAction() {
  const session = await auth();
  if (!session?.user?.id) {
    return { error: "Not authenticated" };
  }

  const domains = await prisma.domain.findMany({
    orderBy: [{ isSystem: "desc" }, { name: "asc" }],
    include: {
      _count: { select: { entities: true } },
    },
  });
  return domains;
}

export async function createDomainAction(formData: FormData) {
  const session = await auth();
  if (!session?.user?.id) {
    return { error: "You must be logged in" };
  }

  const name = (formData.get("name") as string | null) ?? "";
  const description = (formData.get("description") as string) || "";

  try {
    // Any signed-in user may make a domain; what a domain row must be (the name, its slug, the duplicate check, the tenant, the audit
    // row) is `createDomainRow`'s, the same function the Admin tab uses.
    const created = await createDomainRow({ name, description, userId: session.user.id }, prisma);
    if (!created.success) return { error: created.error.message };
    revalidatePath("/schemas");
    return { success: true };
  } catch (e: unknown) {
    if (e instanceof AuditUserMissingError) {
      return {
        error:
          "Your session is stale. Sign out and sign in again, then create the domain.",
      };
    }
    return { ...unexpectedFailure("createDomainAction", e) };
  }
}

export async function deleteDomainAction(domainId: string) {
  const session = await auth();
  if (!session?.user?.id) {
    return { error: "You must be logged in" };
  }

  try {
    const access = await resolveGlobalAdminAccess(session.user);
    if (!access) {
      return {
        error:
          "Your session is stale. Sign out and sign in again, then delete the domain.",
      };
    }

    if (!access.isAdmin) {
      return { error: "Administrator access is required to delete domains" };
    }

    const domain = await prisma.domain.findUnique({
      where: { id: domainId },
      include: {
        _count: {
          select: {
            entities: true,
            products: true,
            modelDefinitions: true,
            decoratorDefinitions: true,
            sharedEnums: true,
            customScalars: true,
            unionTypes: true,
            services: true,
            interfaces: true,
            userRoles: true,
            ...EVENTS_ASSET_COUNT_SELECT,
          },
        },
      },
    });

    // Ownership: the domain must belong to the active tenant; anything else reads as missing (same answer, nothing deleted).
    if (!domain || !(await isInActiveTenant(domain.tenantId))) { // TODO(access-control task 5): tenant-only guard, asks no role: move to authorizeInActiveTenant(action, resource) (it also needs the resource in the ACTIVE tenant)
      return { error: "Domain not found" };
    }

    if (domain.isSystem) {
      return { error: "System domains cannot be deleted" };
    }

    // Entities (domain- or product-level) and Events assets (events and traits, at either level) block the delete.
    // Everything else — the domain's products and every domain- AND product-level Data Type / API (productId FKs
    // cascade too) — is deleted with it; the confirmation dialog lists those counts (DomainDeletionImpact) before
    // the admin confirms. Events of OTHER domains that reference a published version of an event of this domain
    // (edges, no FK) are named too; a domain that owns no event has no version to reference, so the lookup is skipped.
    const eventRefs =
      domain._count.eventSpecs === 0 ? [] : await findCrossProductEventRefs(prisma, { kind: "domain", domainId, tenantId: domain.tenantId });
    const blocker = combineBlockers([
      domainDeleteBlocker(domain._count),
      eventsInUseError("Domain", domain.name, eventRefs)?.message,
    ]);
    if (blocker) {
      return { error: blocker };
    }

    await withAudit({
      action: "DELETE",
      entityType: "Domain",
      entityId: domainId,
      userId: access.userId,
      beforeState: domain as unknown as object,
      fn: async () => {
        await prisma.domain.delete({ where: { id: domainId } });
        return null;
      },
    });
    revalidatePath("/schemas");
    return { success: true };
  } catch (e: unknown) {
    if (e instanceof AuditUserMissingError) {
      return {
        error:
          "Your session is stale. Sign out and sign in again, then delete the domain.",
      };
    }
    return { ...unexpectedFailure("deleteDomainAction", e) };
  }
}
