import { prisma } from "@/lib/db";
import { assetHref } from "@/lib/navigation/asset-href";
import type { ChannelDetail } from "@/lib/events/types";
import { CHANNEL_SELECT, toChannelDetail } from "@/services/events/channel.service";
import { productCrumbs } from "@/features/events/crumbs";
import { loadMessageOptions, type MessageOption } from "@/features/events/load-options";
import { resolveProductRoute } from "@/features/events/route-scope";
import type { Crumb } from "@/features/events/shared/EventBreadcrumb";

export interface ChannelPageData {
  channel: ChannelDetail;
  productId: string;
  crumbs: Crumb[];
  listHref: string;
  messageOptions: MessageOption[];
}

/**
 * null → 404, identically for an unknown id, another product's channel and another tenant's channel (no existence oracle).
 * `getChannel` is an unscoped by-id read, so the read here is scoped by the route's tenant AND product, never by id alone.
 */
export async function loadChannelPage(params: { domainSlug: string; productSlug: string; channelId: string }): Promise<ChannelPageData | null> {
  const route = await resolveProductRoute(params.domainSlug, params.productSlug);
  if (!route) return null;
  const row = await prisma.channel.findFirst({
    where: { id: params.channelId, tenantId: route.tenantId, domainId: route.domain.id, productId: route.product.id },
    select: CHANNEL_SELECT,
  });
  if (!row) return null;
  const listHref = assetHref({ kind: "events", domainSlug: route.domain.slug, productSlug: route.product.slug, section: "channels" });
  return {
    channel: toChannelDetail(row),
    productId: route.product.id,
    listHref,
    crumbs: productCrumbs(route, { label: "Channels", href: listHref }, row.name),
    messageOptions: await loadMessageOptions(route.tenantId),
  };
}
