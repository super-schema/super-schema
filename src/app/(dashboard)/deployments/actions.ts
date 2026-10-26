"use server";

import { prisma } from "@/lib/db";
import { contextOf, guardActiveTenant, unexpectedFailure } from "@/lib/action-context";
import { getEntities } from "@/services/entity.service";
import {
  getDeploymentOverview,
  type DeploymentOverviewRow,
} from "@/services/deployment.service";
import { getSchemaTargetCatalog } from "@/lib/schema-targets/catalog";
import { domainLabel } from "@/lib/entity-placement";

/**
 * The deployment overview of the ACTIVE tenant, for the entities the caller may read (`deploy.read`, a viewer's act over each entity): the caller
 * must hold a role in the tenant (`tenant.access`), and the entity list is restricted IN THE QUERY to the entities their roles cover (a tenant-wide
 * role lists every entity of the tenant, a domain- or product-scoped role only the entities under its domains and products, never another tenant's).
 * Only the domains of the listed entities are read for their names and slugs. Marking an entity deployed is `deploy.run` in the entity actions.
 */
export async function getDeploymentOverviewAction() {
  try {
    const access = await guardActiveTenant("tenant.access", { label: "Deployments" });
    if (!access.allowed) return { error: access.refusal.error };
    const ctx = { ...contextOf(access.principal), tenantId: access.resource.tenantId };

    const entitiesRes = await getEntities({}, ctx);
    if (!entitiesRes.success) return { error: entitiesRes.error.message };

    // The names and slugs of the domains the listed entities sit in (only those: another domain of the tenant is not read).
    const domainIds = [...new Set(entitiesRes.data.flatMap((e) => (e.domainId ? [e.domainId] : [])))];
    const domainRows = domainIds.length
      ? await prisma.domain.findMany({ where: { id: { in: domainIds }, tenantId: access.resource.tenantId }, select: { id: true, name: true, slug: true } })
      : [];
    const domainById = new Map(domainRows.map((d) => [d.id, { name: d.name, slug: d.slug }]));

    const targets = getSchemaTargetCatalog().filter((t) => t.enabledInSchemaTab);
    const targetFormats = targets.map((t) => t.targetFormat);

    const input = entitiesRes.data.map((e) => ({
      entityId: e.id,
      entityName: e.name,
      domain: e.domainId ? (domainById.get(e.domainId)?.name ?? "—") : domainLabel(null),
      currentVersion: e.version != null ? `v${e.version}` : null,
      targets: targets.map((t) => ({ id: `${e.id}:${t.key}`, format: t.targetFormat })),
    }));

    const overview = await getDeploymentOverview(input);
    if (!overview.success) return { error: overview.error.message };

    // Enrich rows with slugs for entity links (service does not carry them).
    const productIds = [...new Set(entitiesRes.data.flatMap((e) => (e.productId ? [e.productId] : [])))];
    const productSlugById = new Map(
      (productIds.length
        ? await prisma.product.findMany({
            where: { id: { in: productIds } },
            select: { id: true, slug: true },
          })
        : []
      ).map((p) => [p.id, p.slug])
    );
    const slugById = new Map(
      entitiesRes.data.map((e) => [
        e.id,
        {
          entitySlug: e.slug,
          // Tenant-level entities have no domain or product: null slugs make assetHref
          // emit their /schemas/enterprise/entities/<slug> URL.
          domainSlug: e.domainId ? domainById.get(e.domainId)?.slug : null,
          productSlug: e.productId ? productSlugById.get(e.productId) : null,
        },
      ])
    );
    const rows: DeploymentOverviewRow[] = overview.data.rows.map((r) => ({
      ...r,
      entitySlug: slugById.get(r.entityId)?.entitySlug,
      domainSlug: slugById.get(r.entityId)?.domainSlug,
      productSlug: slugById.get(r.entityId)?.productSlug,
    }));

    return { success: true as const, data: { rows, targetFormats } };
  } catch (e: unknown) {
    return { ...unexpectedFailure("getDeploymentOverviewAction", e) };
  }
}
