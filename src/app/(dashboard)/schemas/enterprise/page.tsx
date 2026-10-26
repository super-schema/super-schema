import { prisma } from "@/lib/db";
import { notFound } from "next/navigation";
import { can } from "@/lib/access";
import { requirePageAccess } from "@/lib/access/page-access";
import {
  mapCustomScalarRows,
  mapSharedEnumRows,
  mapUnionTypeRows,
} from "../[domainSlug]/map-asset-rows";
import {
  classificationCountsFromGroups,
  emptyClassificationCounts,
} from "@/lib/classification-counts";
import { loadLevelTraits } from "@/features/events/workspace/load-events-tab-data";
import { EnterpriseWorkspace } from "./enterprise-workspace";

export default async function EnterprisePage() {
  const { principal, tenantId } = await requirePageAccess();

  // The Enterprise level is the tenant itself: its entities, data types and traits are covered by a role over the TENANT as a whole (or a platform role), never
  // by a role at one domain or product. A caller without one is told 404, as for a missing page.
  if (!can(principal.assignments, "entity.read", { tenantId })) notFound();

  // Tenant-level entities carry neither a domain nor a product.
  const tenantEntities = { tenantId, domainId: null, productId: null };

  const [entities, classificationGroups, enums, scalars, unions, traits] = await Promise.all([
    prisma.entity.findMany({
      where: tenantEntities,
      orderBy: { updatedAt: "desc" },
      include: { _count: { select: { fields: true } } },
    }),
    // Classification tallies without loading every field row.
    prisma.field.groupBy({
      by: ["entityId", "classification"],
      where: { entity: tenantEntities },
      _count: true,
    }),
    prisma.sharedEnum.findMany({
      where: { tenantId, domainId: null },
      orderBy: { name: "asc" },
    }),
    prisma.customScalar.findMany({
      where: { tenantId, domainId: null },
      orderBy: { name: "asc" },
    }),
    prisma.unionType.findMany({
      where: { tenantId, domainId: null },
      orderBy: { name: "asc" },
    }),
    loadLevelTraits({ scope: { tenantId, domainId: null, productId: null }, domainSlug: null }),
  ]);

  const classificationsByEntity = classificationCountsFromGroups(
    classificationGroups,
    entities.map((e) => e.id)
  );

  return (
    <EnterpriseWorkspace
      tenantId={tenantId}
      entities={entities.map((e) => ({
        id: e.id,
        name: e.name,
        slug: e.slug,
        description: e.description,
        status: e.status,
        version: e.version,
        fieldCount: e._count.fields,
        updatedAt: e.updatedAt,
        classifications: classificationsByEntity.get(e.id) ?? emptyClassificationCounts(),
      }))}
      dataTypes={{
        sharedEnums: mapSharedEnumRows(enums),
        customScalars: mapCustomScalarRows(scalars),
        unionTypes: mapUnionTypeRows(unions),
      }}
      traits={traits}
    />
  );
}
