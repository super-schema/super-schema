"use server";

import { prisma } from "@/lib/db";
import { AuditUserMissingError, withAudit } from "@/lib/audit";
import { createDomainRow } from "@/services/domain-row.service";
import { revalidatePath } from "next/cache";
import { canListDomain, productScopesIn, seesWholeDomain } from "@/lib/access";
import { guardActiveTenant, guardSubject, unexpectedFailure } from "@/lib/action-context";
import { domainDeleteBlocker } from "@/lib/domain-deletion";
import { combineBlockers, EVENTS_ASSET_COUNT_SELECT } from "@/lib/product-deletion";
import { eventsInUseError, findCrossProductEventRefs } from "@/services/events/event-guards";

/**
 * The domains of the ACTIVE tenant (never another tenant's) that the caller may read: the caller must hold a role in the tenant
 * (`tenant.access`), and each domain is listed only when their roles reach it: a tenant or domain role lists the domain (and a domain-scoped
 * role not its siblings), a PRODUCT-scoped role lists the domain of its product as the way to reach that product (`canListDomain`). A domain
 * listed only through product roles counts only the entities of those products (never the siblings' entities).
 */
export async function getDomainsAction() {
  try {
    const access = await guardActiveTenant("tenant.access", { label: "Domains" });
    if (!access.allowed) return { error: access.refusal.error };

    const domains = await prisma.domain.findMany({
      where: { tenantId: access.resource.tenantId },
      orderBy: [{ isSystem: "desc" }, { name: "asc" }],
      include: {
        _count: { select: { entities: true } },
      },
    });
    const { assignments } = access.principal;
    const listed = domains.filter((domain) => canListDomain(assignments, { tenantId: domain.tenantId, domainId: domain.id }));
    const reach = productScopesIn(assignments, access.resource.tenantId);
    return await Promise.all(
      listed.map(async (domain) => {
        if (seesWholeDomain(assignments, { tenantId: domain.tenantId, domainId: domain.id })) return domain;
        const productIds = reach.filter((scope) => scope.domainId === domain.id).map((scope) => scope.productId);
        const entities = await prisma.entity.count({ where: { tenantId: domain.tenantId, domainId: domain.id, productId: { in: productIds } } });
        return { ...domain, _count: { ...domain._count, entities } };
      })
    );
  } catch (e: unknown) {
    return { ...unexpectedFailure("getDomainsAction", e) };
  }
}

export async function createDomainAction(formData: FormData) {
  const name = (formData.get("name") as string | null) ?? "";
  const description = (formData.get("description") as string) || "";

  try {
    // Making a domain is a tenant-level decision (`domain.create`: a steward or above over the whole tenant, the active one); what a domain
    // row must be (the name, its slug, the duplicate check, the tenant, the audit row) is `createDomainRow`'s, the same function the Admin tab uses.
    const access = await guardActiveTenant("domain.create", { label: "Tenant", unauthenticated: "You must be logged in" });
    if (!access.allowed) return { error: access.refusal.error };
    const created = await createDomainRow({ name, description, userId: access.principal.userId }, prisma);
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
  try {
    // Deleting a domain is a tenant administrator's decision (`domain.delete`, over the whole tenant: a domain-scoped administrator does not
    // reach it), judged before the domain is read. A missing domain, one of another tenant and one the caller cannot see are the same answer.
    const access = await guardSubject("domain.delete", { kind: "domain", id: domainId }, { label: "Domain", unauthenticated: "You must be logged in" });
    if (!access.allowed) return { error: access.refusal.error };

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

    if (!domain) {
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
      userId: access.principal.userId,
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
