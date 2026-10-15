import { prisma } from "@/lib/db";
import { formatVersionLabel } from "@/lib/entity-versioning/version-math";
import type { LevelScope } from "@/lib/levels";
import type { TraitKind } from "@/lib/events/types";
import type { EntityOption, VersionOption } from "./shared/EntityPinPicker";

/**
 * Server-side option loaders for the event pickers. Every loader takes the tenant derived from the
 * server context (`resolveProductRoute` / `resolveLevelRoute`) — never an id from the client — and
 * filters every query by it, so a forged product id can never surface another tenant's records.
 */

const OWNER_SELECT = { domain: { select: { name: true } }, product: { select: { name: true } } } as const;
type OwnerRow = { domain: { name: string } | null; product: { name: string } | null };

export function ownerLabel(row: OwnerRow): string {
  if (row.domain && row.product) return `${row.domain.name} / ${row.product.name}`;
  return row.domain ? row.domain.name : "Enterprise";
}

export async function loadEntityOptions(tenantId: string): Promise<EntityOption[]> {
  const rows = await prisma.entity.findMany({
    where: { tenantId },
    orderBy: { name: "asc" },
    select: { id: true, name: true, latestVersionId: true, latestVersion: { select: { major: true, minor: true } }, ...OWNER_SELECT },
  });
  return rows.map((r) => ({
    id: r.id, name: r.name, ownerLabel: ownerLabel(r), latestVersionId: r.latestVersionId,
    latestVersionLabel: r.latestVersion ? formatVersionLabel(r.latestVersion) : null,
  }));
}

/**
 * Published versions of one entity, newest first, for the pin picker's version list. The entity id comes
 * from the client, so it is only honoured inside `tenantId`: an entity of another tenant (or an unknown
 * id) yields `null`, indistinguishable from "does not exist". Versions are immutable published rows, so
 * every row is pinnable — drafts are never versions.
 */
export async function loadPinnableVersions(tenantId: string, entityId: string): Promise<VersionOption[] | null> {
  if (typeof entityId !== "string" || entityId.length === 0) return null;
  const entity = await prisma.entity.findFirst({
    where: { id: entityId, tenantId },
    select: { versions: { orderBy: { sequence: "desc" }, select: { id: true, major: true, minor: true } } },
  });
  if (!entity) return null;
  return entity.versions.map((v) => ({ id: v.id, label: formatVersionLabel(v) }));
}

export interface TraitOption {
  id: string;
  name: string;
  ownerLabel: string;
}

/** Traits visible from a level: Enterprise + that domain + that product (spec §4.3 line). */
export async function loadTraitOptions(scope: LevelScope, kind: TraitKind): Promise<TraitOption[]> {
  const rows = await prisma.trait.findMany({
    where: {
      tenantId: scope.tenantId,
      kind,
      OR: [
        { domainId: null },
        ...(scope.domainId ? [{ domainId: scope.domainId, productId: null }] : []),
        ...(scope.productId ? [{ productId: scope.productId }] : []),
      ],
    },
    orderBy: { name: "asc" },
    select: { id: true, name: true, ...OWNER_SELECT },
  });
  return rows.map((r) => ({ id: r.id, name: r.name, ownerLabel: ownerLabel(r) }));
}

export interface ChannelOption {
  id: string;
  name: string;
  address: string | null;
  protocol: string;
  format: string;
  ownerLabel: string;
  own: boolean;
  allowedMessageIds: string[];
}

export async function loadChannelOptions(tenantId: string, productId: string): Promise<ChannelOption[]> {
  const rows = await prisma.channel.findMany({
    where: { tenantId },
    orderBy: { name: "asc" },
    select: {
      id: true, name: true, address: true, protocol: true, format: true, productId: true, ...OWNER_SELECT,
      messages: { select: { messageId: true } },
    },
  });
  return rows
    .map((r) => ({
      id: r.id, name: r.name, address: r.address, protocol: r.protocol, format: r.format, ownerLabel: ownerLabel(r),
      own: r.productId === productId, allowedMessageIds: r.messages.map((m) => m.messageId),
    }))
    .sort((a, b) => Number(b.own) - Number(a.own));
}

export interface MessageRefOption {
  /** MessageVersion id, or the Message id for an own-product draft (D4). */
  id: string;
  messageId: string;
  label: string;
  ownerLabel: string;
  own: boolean;
  draft: boolean;
}

export async function loadMessageRefOptions(tenantId: string, productId: string): Promise<MessageRefOption[]> {
  const [versions, drafts] = await Promise.all([
    prisma.messageVersion.findMany({
      where: { message: { tenantId } },
      orderBy: [{ message: { name: "asc" } }, { sequence: "desc" }],
      select: { id: true, major: true, minor: true, messageId: true, message: { select: { name: true, productId: true, ...OWNER_SELECT } } },
    }),
    // tenantId is part of the filter too: `productId` alone would trust the caller's id.
    prisma.message.findMany({ where: { tenantId, productId }, orderBy: { name: "asc" }, select: { id: true, name: true } }),
  ]);
  return [
    ...versions.map((v) => ({
      id: v.id, messageId: v.messageId, label: `${v.message.name} v${formatVersionLabel(v)}`, ownerLabel: ownerLabel(v.message),
      own: v.message.productId === productId, draft: false,
    })),
    ...drafts.map((m) => ({ id: m.id, messageId: m.id, label: `${m.name} (draft — preview only)`, ownerLabel: "This product", own: true, draft: true })),
  ];
}

export interface MessageOption {
  id: string;
  name: string;
  ownerLabel: string;
}

export async function loadMessageOptions(tenantId: string): Promise<MessageOption[]> {
  const rows = await prisma.message.findMany({ where: { tenantId }, orderBy: { name: "asc" }, select: { id: true, name: true, ...OWNER_SELECT } });
  return rows.map((r) => ({ id: r.id, name: r.name, ownerLabel: ownerLabel(r) }));
}
