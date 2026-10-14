import { prisma } from "@/lib/db";
import { getActiveTenantId } from "@/lib/active-tenant";
import {
  mapCustomScalarRows,
  mapSharedEnumRows,
  mapUnionTypeRows,
} from "../[domainSlug]/map-asset-rows";
import { EnterpriseWorkspace } from "./enterprise-workspace";

const NO_CLASSIFICATIONS = { NEVER_STORED: 0, PII: 0, SENSITIVE: 0, INTERNAL: 0, PUBLIC: 0 };

export default async function EnterprisePage() {
  const tenantId = await getActiveTenantId();

  const [entities, enums, scalars, unions] = await Promise.all([
    // Tenant-level entities carry neither a domain nor a product.
    prisma.entity.findMany({
      where: { tenantId, domainId: null, productId: null },
      orderBy: { updatedAt: "desc" },
      include: {
        _count: { select: { fields: true } },
        fields: { select: { classification: true } },
      },
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

  return (
    <EnterpriseWorkspace
      tenantId={tenantId}
      entities={entities.map((e) => {
        const classifications = { ...NO_CLASSIFICATIONS };
        for (const f of e.fields) {
          const cls = f.classification ?? "SENSITIVE";
          if (cls in classifications) {
            classifications[cls as keyof typeof classifications]++;
          }
        }
        return {
          id: e.id,
          name: e.name,
          slug: e.slug,
          description: e.description,
          status: e.status,
          version: e.version,
          fieldCount: e._count.fields,
          updatedAt: e.updatedAt,
          classifications,
        };
      })}
      dataTypes={{
        sharedEnums: mapSharedEnumRows(enums),
        customScalars: mapCustomScalarRows(scalars),
        unionTypes: mapUnionTypeRows(unions),
      }}
    />
  );
}
