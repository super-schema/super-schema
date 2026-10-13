import { prisma } from "@/lib/db";
import { auth } from "@/lib/auth";
import { resolveGlobalAdminAccess } from "@/lib/access-control";
import { getActiveTenantId } from "@/lib/active-tenant";
import { DomainGrid } from "./domain-grid";

export default async function SchemasPage() {
  const tenantId = await getActiveTenantId();
  const domainsPromise = prisma.domain.findMany({
    where: { tenantId },
    orderBy: [{ isSystem: "desc" }, { name: "asc" }],
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
  const session = await auth();
  const [domains, access] = await Promise.all([
    domainsPromise,
    resolveGlobalAdminAccess(session?.user),
  ]);

  return (
    <DomainGrid
      canDeleteDomains={access?.isAdmin ?? false}
      domains={domains.map((d) => ({
        id: d.id,
        name: d.name,
        slug: d.slug,
        description: d.description,
        isSystem: d.isSystem,
        entityCount: d._count.entities,
        deletionImpact: {
          entities: d._count.entities,
          modelDefinitions: d._count.modelDefinitions,
          decoratorDefinitions: d._count.decoratorDefinitions,
          sharedEnums: d._count.sharedEnums,
          customScalars: d._count.customScalars,
          unionTypes: d._count.unionTypes,
          services: d._count.services,
          interfaces: d._count.interfaces,
          userRoles: d._count.userRoles,
        },
        createdAt: d.createdAt,
      }))}
    />
  );
}
