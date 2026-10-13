"use server";

import { prisma } from "@/lib/db";
import { auth } from "@/lib/auth";
import { AuditUserMissingError, withAudit } from "@/lib/audit";
import { resolveGlobalAdminAccess } from "@/lib/access-control";
import { revalidatePath } from "next/cache";
import { generateSlug, isReservedSchemaRouteSlug } from "@/lib/slug";
import { ensureDefaultTenantId } from "@/lib/org-defaults";
import { getActiveTenantId } from "@/lib/active-tenant";

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

  const name = formData.get("name") as string;
  const description = (formData.get("description") as string) || "";

  if (!name || name.trim().length === 0) {
    return { error: "Domain name is required" };
  }

  if (name.length > 64) {
    return { error: "Domain name must be 64 characters or less" };
  }

  const slug = generateSlug(name);
  if (isReservedSchemaRouteSlug(slug)) {
    return { error: `"${slug}" is reserved for a schemas utility page` };
  }

  try {
    await withAudit({
      action: "CREATE",
      entityType: "Domain",
      entityId: "pending",
      userId: session.user.id,
      fn: async () => {
        // New domains belong to the tenant the user is currently viewing.
        // ensureDefaultTenantId guarantees a tenant exists on a fresh install.
        await ensureDefaultTenantId();
        const tenantId = await getActiveTenantId();
        return prisma.domain.create({
          data: { name: name.trim(), slug, description, tenantId },
        });
      },
    });
    revalidatePath("/schemas");
    return { success: true };
  } catch (e: unknown) {
    if (e instanceof AuditUserMissingError) {
      return {
        error:
          "Your session is stale. Sign out and sign in again, then create the domain.",
      };
    }
    if (e instanceof Error && e.message.includes("Unique constraint")) {
      return { error: `A domain named "${name}" already exists` };
    }
    const message = e instanceof Error ? e.message : "Failed to create domain";
    return { error: message };
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
            modelDefinitions: true,
            decoratorDefinitions: true,
            sharedEnums: true,
            customScalars: true,
            unionTypes: true,
            services: true,
            interfaces: true,
            userRoles: true,
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

    if (domain._count.entities > 0) {
      const isSingleEntity = domain._count.entities === 1;
      return {
        error: `Cannot delete - ${domain._count.entities} ${isSingleEntity ? "entity exists" : "entities exist"} in this domain. Move or delete ${isSingleEntity ? "it" : "them"} first.`,
      };
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
    const message = e instanceof Error ? e.message : "Failed to delete domain";
    return { error: message };
  }
}
