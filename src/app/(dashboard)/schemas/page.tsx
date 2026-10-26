import { prisma } from "@/lib/db";
import { can, canListDomain, readableWhere } from "@/lib/access";
import { requirePageAccess } from "@/lib/access/page-access";
import { EVENTS_ASSET_COUNT_SELECT } from "@/lib/product-deletion";
import { DomainGrid } from "./domain-grid";

/**
 * The domains of the tenant in view, as far as the caller's roles reach: a domain is listed when a role covers it or one of its products
 * (`canListDomain`), and what is COUNTED on its card is what the caller may read (`entity.read`), so a role at one product does not learn how many entities
 * the rest of the domain holds. The delete dialog's impact figures (every asset the domain would take with it) are loaded only for a caller who may delete
 * a domain (`domain.delete`: a tenant administrator, who reads all of it anyway).
 */
export default async function SchemasPage() {
  const { principal, tenantId } = await requirePageAccess();
  const assignments = principal.assignments;
  const canDeleteDomains = can(assignments, "domain.delete", { tenantId });

  const [rows, readableEntities] = await Promise.all([
    prisma.domain.findMany({
      where: { tenantId },
      orderBy: [{ isSystem: "desc" }, { name: "asc" }],
      ...(canDeleteDomains
        ? {
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
                  ...EVENTS_ASSET_COUNT_SELECT,
                },
              },
              // Product-level Data Types / APIs cascade with their products when the domain goes.
              products: {
                select: {
                  _count: {
                    select: {
                      sharedEnums: true,
                      customScalars: true,
                      unionTypes: true,
                      services: true,
                    },
                  },
                },
              },
            },
          }
        : {}),
    }),
    // What the card counts: the entities the caller may read, per domain.
    prisma.entity.groupBy({ by: ["domainId"], where: { tenantId, ...readableWhere(assignments, "entity.read", tenantId) }, _count: { _all: true } }),
  ]);
  const entitiesOf = new Map(readableEntities.map((row) => [row.domainId, row._count._all]));
  const domains = rows.filter((d) => canListDomain(assignments, { tenantId, domainId: d.id }));

  return (
    <DomainGrid
      canDeleteDomains={canDeleteDomains}
      domains={domains.map((d) => {
        const impact = "_count" in d ? (d as unknown as WithImpact) : null;
        return {
          id: d.id,
          name: d.name,
          slug: d.slug,
          description: d.description,
          isSystem: d.isSystem,
          entityCount: entitiesOf.get(d.id) ?? 0,
          // Only a caller who may delete a domain is shown what deleting it would take; anyone else's dialog never opens (and gets zeros).
          deletionImpact: impact ? impactOf(impact) : NO_IMPACT,
          createdAt: d.createdAt,
        };
      })}
    />
  );
}

type Counts = Record<string, number>;
type WithImpact = { _count: Counts; products: Array<{ _count: Counts }> };

const NO_IMPACT = {
  entities: 0,
  products: 0,
  productLevelAssets: 0,
  modelDefinitions: 0,
  decoratorDefinitions: 0,
  sharedEnums: 0,
  customScalars: 0,
  unionTypes: 0,
  services: 0,
  interfaces: 0,
  userRoles: 0,
  traits: 0,
  eventSpecs: 0,
};

function impactOf(d: WithImpact) {
  return {
    entities: d._count.entities,
    products: d.products.length,
    productLevelAssets: d.products.reduce((sum, p) => sum + p._count.sharedEnums + p._count.customScalars + p._count.unionTypes + p._count.services, 0),
    modelDefinitions: d._count.modelDefinitions,
    decoratorDefinitions: d._count.decoratorDefinitions,
    sharedEnums: d._count.sharedEnums,
    customScalars: d._count.customScalars,
    unionTypes: d._count.unionTypes,
    services: d._count.services,
    interfaces: d._count.interfaces,
    userRoles: d._count.userRoles,
    traits: d._count.traits,
    eventSpecs: d._count.eventSpecs,
  };
}
