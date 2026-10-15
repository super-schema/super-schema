// src/services/events/delete-guards.ts
import type { Prisma, PrismaClient } from "@/generated/prisma/client";
import { formatVersionLabel } from "@/lib/entity-versioning/version-math";
import type { CrossProductPin, PinnedAsset, PinnedAssetKind } from "@/lib/events/cross-product-pins";

type Db = PrismaClient | Prisma.TransactionClient;

/** What is being deleted. `tenantId` bounds the lookup: specs of other tenants are never read, counted or named. */
export type DeleteGuardScope =
  | { kind: "product"; productId: string; tenantId: string }
  | { kind: "domain"; domainId: string; tenantId: string };

/**
 * Rows the delete would cascade. Product-level rows always carry their product's `domainId` (CHECK + resolveScope),
 * so a domain owns everything with its `domainId` — product-level assets and its own domain-level traits alike.
 */
const ownedBy = (scope: DeleteGuardScope) => (scope.kind === "product" ? { productId: scope.productId } : { domainId: scope.domainId });

/** Specs that survive the delete: any other product's (event specs always carry both product and domain). */
const elsewhere = (scope: DeleteGuardScope) =>
  scope.kind === "product" ? { productId: { not: scope.productId } } : { domainId: { not: scope.domainId } };

const KIND_ORDER: Record<PinnedAssetKind, number> = { Message: 0, Channel: 1, Trait: 2 };

/** Ids of the elements of a frozen channel / trait array (`ResolvedChannel[]` / `FrozenTrait[]`); anything malformed is skipped. */
function frozenIds(json: Prisma.JsonValue): string[] {
  if (!Array.isArray(json)) return [];
  return json.flatMap((e) => {
    const id = e !== null && typeof e === "object" && !Array.isArray(e) ? e.id : undefined;
    return typeof id === "string" ? [id] : [];
  });
}

/**
 * Published event spec versions of OTHER products (same tenant) that pin a message version owned by the delete
 * target, or froze a channel / trait it owns — grouped per spec. Drafts do not count: only published versions are
 * immutable, and a draft cannot be published against a deleted asset (publish re-verifies its references).
 *
 * Message pins are read from both places a publish records them — `event_spec_versions.messageVersionIds` and the
 * non-draft `schema_references` EVENT_SPEC_VERSION -> MESSAGE_VERSION edges — exactly like `deleteMessage`'s own
 * guard. Frozen channels / traits exist only in the version's JSON, matched by id with a containment query.
 * Runs three small reads and returns early when the target owns no messages / channels / traits.
 */
export async function findCrossProductPins(db: Db, scope: DeleteGuardScope): Promise<CrossProductPin[]> {
  const where = ownedBy(scope);
  const [messageVersions, channels, traits] = await Promise.all([
    db.messageVersion.findMany({ where: { message: where }, select: { id: true, message: { select: { id: true, name: true } } } }),
    db.channel.findMany({ where, select: { id: true, name: true } }),
    db.trait.findMany({ where, select: { id: true, name: true } }),
  ]);
  if (messageVersions.length === 0 && channels.length === 0 && traits.length === 0) return [];

  const messageByVersion = new Map(messageVersions.map((v) => [v.id, v.message]));
  const channelById = new Map(channels.map((c) => [c.id, c.name]));
  const traitById = new Map(traits.map((t) => [t.id, t.name]));

  const messageVersionIds = [...messageByVersion.keys()];
  const edges =
    messageVersionIds.length === 0
      ? []
      : await db.schemaReference.findMany({
          where: { fromKind: "EVENT_SPEC_VERSION", toKind: "MESSAGE_VERSION", toId: { in: messageVersionIds }, isDraft: false },
          select: { fromId: true, toId: true },
        });
  const edgeTargets = new Map<string, string[]>();
  for (const e of edges) edgeTargets.set(e.fromId, [...(edgeTargets.get(e.fromId) ?? []), e.toId]);

  const matches: Prisma.EventSpecVersionWhereInput[] = [];
  if (messageVersionIds.length > 0) matches.push({ messageVersionIds: { hasSome: messageVersionIds } });
  if (edgeTargets.size > 0) matches.push({ id: { in: [...edgeTargets.keys()] } });
  for (const id of channelById.keys()) matches.push({ frozenChannels: { array_contains: [{ id }] } });
  for (const id of traitById.keys()) matches.push({ frozenTraits: { array_contains: [{ id }] } });

  const versions = await db.eventSpecVersion.findMany({
    where: { eventSpec: { tenantId: scope.tenantId, ...elsewhere(scope) }, OR: matches },
    select: {
      id: true,
      major: true,
      minor: true,
      messageVersionIds: true,
      frozenChannels: true,
      frozenTraits: true,
      eventSpec: { select: { id: true, name: true, productId: true, product: { select: { id: true, name: true } } } },
    },
    orderBy: [{ eventSpec: { name: "asc" } }, { eventSpec: { id: "asc" } }, { sequence: "asc" }],
  });

  const bySpec = new Map<string, { pin: CrossProductPin; assets: Map<string, PinnedAsset> }>();
  for (const v of versions) {
    const referenced = new Map<string, PinnedAsset>();
    for (const mvId of [...v.messageVersionIds, ...(edgeTargets.get(v.id) ?? [])]) {
      const message = messageByVersion.get(mvId);
      if (message) referenced.set(`message:${message.id}`, { kind: "Message", name: message.name });
    }
    for (const id of frozenIds(v.frozenChannels)) {
      const name = channelById.get(id);
      if (name !== undefined) referenced.set(`channel:${id}`, { kind: "Channel", name });
    }
    for (const id of frozenIds(v.frozenTraits)) {
      const name = traitById.get(id);
      if (name !== undefined) referenced.set(`trait:${id}`, { kind: "Trait", name });
    }
    if (referenced.size === 0) continue;

    const entry = bySpec.get(v.eventSpec.id) ?? {
      pin: {
        specId: v.eventSpec.id,
        specName: v.eventSpec.name,
        productId: v.eventSpec.product?.id ?? v.eventSpec.productId ?? "",
        productName: v.eventSpec.product?.name ?? "unknown product",
        versions: [],
        assets: [],
      },
      assets: new Map<string, PinnedAsset>(),
    };
    entry.pin.versions.push(formatVersionLabel(v));
    for (const [key, asset] of referenced) entry.assets.set(key, asset);
    bySpec.set(v.eventSpec.id, entry);
  }

  return [...bySpec.values()].map(({ pin, assets }) => ({
    ...pin,
    assets: [...assets.values()].sort((a, b) => KIND_ORDER[a.kind] - KIND_ORDER[b.kind] || a.name.localeCompare(b.name)),
  }));
}
