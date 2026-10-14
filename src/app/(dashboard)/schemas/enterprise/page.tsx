import { prisma } from "@/lib/db";
import { getActiveTenantId } from "@/lib/active-tenant";
import {
  mapCustomScalarRows,
  mapSharedEnumRows,
  mapUnionTypeRows,
} from "../[domainSlug]/map-asset-rows";
import {
  classificationCountsFromGroups,
  emptyClassificationCounts,
} from "@/lib/classification-counts";
import { EnterpriseWorkspace } from "./enterprise-workspace";

export default async function EnterprisePage() {
  const tenantId = await getActiveTenantId();

  // Tenant-level entities carry neither a domain nor a product.
  const tenantEntities = { tenantId, domainId: null, productId: null };

  const [entities, classificationGroups, enums, scalars, unions] = await Promise.all([
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
    />
  );
}
