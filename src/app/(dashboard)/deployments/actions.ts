"use server";

import { auth } from "@/lib/auth";
import { prisma } from "@/lib/db";
import { getEffectiveRole } from "@/services/rbac.service";
import type { ServiceContext } from "@/types/service-context";
import { getEntities } from "@/services/entity.service";
import { getDomains } from "@/services/domain.service";
import {
  getDeploymentOverview,
  type DeploymentOverviewRow,
} from "@/services/deployment.service";
import { getSchemaTargetCatalog } from "@/lib/schema-targets/catalog";
import { domainLabel } from "@/lib/entity-placement";

async function resolveCtx(): Promise<
  { ok: true; ctx: ServiceContext } | { ok: false; error: string }
> {
  const session = await auth();
  if (!session?.user?.id) return { ok: false, error: "Not authenticated" };
  const userId = session.user.id;
  let userRole = "VIEWER";
  const roleResult = await getEffectiveRole(userId, null, { userId, userRole, prisma });
  if (roleResult.success && roleResult.data) userRole = roleResult.data;
  return { ok: true, ctx: { userId, userRole, prisma } };
}

export async function getDeploymentOverviewAction() {
  const authRes = await resolveCtx();
  if (!authRes.ok) return { error: authRes.error };

  const entitiesRes = await getEntities({}, authRes.ctx);
  if (!entitiesRes.success) return { error: entitiesRes.error.message };

  const domainsRes = await getDomains(authRes.ctx);
  if (!domainsRes.success) return { error: domainsRes.error.message };
  const domainById = new Map(
    domainsRes.data.map((d) => [d.id, { name: d.name, slug: d.slug }])
  );

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
}
