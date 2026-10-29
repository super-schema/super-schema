import { prisma } from "@/lib/db";
import { assetHref } from "@/lib/navigation/asset-href";
import { EVENT_SELECT, toEventDetail } from "@/services/events/event.service";

export interface EventListItem {
  id: string;
  name: string;
  specType: string;
  /** Label of the latest published version; null = never published. */
  versionLabel: string | null;
  hasUnpublishedChanges: boolean;
  channels: number;
  messages: number;
  operations: number;
  href: string;
  description: string;
  /** One entry per channel that has an address, in document order. */
  topics: { protocol: string; address: string }[];
  /** Distinct payload entities of the event's messages, by name. */
  payloads: { name: string; href: string }[];
}

/**
 * The product's events for the flat Events list, sorted by name. The by-id service reads are unscoped by design, so the
 * list filters by the tenant AND the product inside the query itself; the caller passes the tenant of the route's domain,
 * never an id taken from the client. Only events whose stored document is a valid v2 document are listed: a legacy v1
 * (catalog-id) row, which only the old services read, is skipped silently, and so is any other unreadable document.
 */
export async function loadEventsList(args: { tenantId: string; productId: string; domainSlug: string; productSlug: string }): Promise<EventListItem[]> {
  const { tenantId, productId, domainSlug, productSlug } = args;
  const rows = await prisma.eventSpec.findMany({ where: { tenantId, productId }, orderBy: { name: "asc" }, select: EVENT_SELECT });
  const details = rows.flatMap((row) => {
    const detail = toEventDetail(row);
    return detail.success ? [{ row, detail: detail.data }] : [];
  });
  const entityIds = [...new Set(details.flatMap(({ detail }) => detail.document.messages.map((m) => m.payload.entityId)))];
  const entities = entityIds.length === 0 ? [] : await prisma.entity.findMany({ where: { id: { in: entityIds }, tenantId }, select: { id: true, name: true, slug: true } });
  const entityById = new Map(entities.map((e) => [e.id, e]));
  const items: EventListItem[] = [];
  for (const { row, detail: data } of details) {
    const { document } = data;
    const payloads = [...new Set(document.messages.map((m) => m.payload.entityId))].flatMap((id) => {
      const e = entityById.get(id);
      return e ? [{ name: e.name, href: assetHref({ kind: "entity", slug: e.slug, domainSlug, productSlug }) }] : [];
    });
    items.push({
      id: row.id,
      name: row.name,
      specType: row.specType,
      versionLabel: data.latestVersionLabel,
      hasUnpublishedChanges: data.hasUnpublishedChanges,
      channels: document.channels.length,
      messages: document.messages.length,
      operations: document.operations.length,
      href: assetHref({ kind: "event", id: row.id, domainSlug, productSlug }),
      description: document.info.description ?? "",
      topics: document.channels.flatMap((c) => (c.address ? [{ protocol: c.protocol, address: c.address }] : [])),
      payloads,
    });
  }
  return items;
}
