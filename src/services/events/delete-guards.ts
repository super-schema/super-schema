// src/services/events/delete-guards.ts
import type { Prisma, PrismaClient } from "@/generated/prisma/client";
import { formatVersionLabel } from "@/lib/entity-versioning/version-math";
import type { CrossProductPin, PinnedAsset, PinnedAssetKind } from "@/lib/events/cross-product-pins";
import type { ServiceError } from "@/types/result";

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

// ── Trait / channel in-use guards ────────────────────────────────────────────────────────────────

/** Which asset the guard protects; also the noun used in the error. */
export type GuardedAssetKind = "Trait" | "Channel";

/** A message or event spec that still uses a trait / channel. */
export interface AssetReferrer {
  kind: "Message" | "Event spec";
  id: string;
  name: string;
  /** Labels ("1.0") of the PUBLISHED versions that reference the asset, oldest first; empty when only the live draft does. */
  versions: string[];
  /** The live draft (the message's `spec`, the event spec's draft document) references the asset too. */
  draft: boolean;
}

export interface AssetReferrers {
  /** Messages first, then event specs; each by name. At most `MAX_REFERRER_SCAN` rows are read per source. */
  referrers: AssetReferrer[];
  /** True when a source had more matches than the scan limit: the list is a prefix. */
  truncated: boolean;
}

/** Rows read per source. Any hit blocks the delete; only the first few referrers are ever named. */
const MAX_REFERRER_SCAN = 200;
const MAX_NAMED_REFERRERS = 5;
const MAX_NAMED_REFERRER_VERSIONS = 3;

interface ReferrerSource {
  kind: AssetReferrer["kind"];
  id: string;
  name: string;
  /** Present for a published version row, absent for a draft row. */
  version?: { major: number; minor: number };
}

/** One referrer per owning message / event spec, with its published version labels and whether its draft references the asset. */
function groupReferrers(rows: ReferrerSource[]): AssetReferrer[] {
  const byOwner = new Map<string, AssetReferrer>();
  for (const row of rows) {
    const key = `${row.kind}:${row.id}`;
    const entry = byOwner.get(key) ?? { kind: row.kind, id: row.id, name: row.name, versions: [], draft: false };
    if (row.version) entry.versions.push(formatVersionLabel(row.version));
    else entry.draft = true;
    byOwner.set(key, entry);
  }
  const kindOrder = { Message: 0, "Event spec": 1 } as const;
  return [...byOwner.values()].sort((a, b) => kindOrder[a.kind] - kindOrder[b.kind] || a.name.localeCompare(b.name) || a.id.localeCompare(b.id));
}

const specVersionOrder = [{ eventSpec: { name: "asc" as const } }, { eventSpec: { id: "asc" as const } }, { sequence: "asc" as const }];
const messageVersionOrder = [{ message: { name: "asc" as const } }, { message: { id: "asc" as const } }, { sequence: "asc" as const }];
const byName = [{ name: "asc" as const }, { id: "asc" as const }];
/** One row past the limit tells whether a source was cut. */
const SCAN_TAKE = MAX_REFERRER_SCAN + 1;

/** Cut a source down to the scan limit; flags when it was longer. */
function bounded<T>(rows: T[], flag: { truncated: boolean }): T[] {
  if (rows.length <= MAX_REFERRER_SCAN) return rows;
  flag.truncated = true;
  return rows.slice(0, MAX_REFERRER_SCAN);
}

/**
 * Everything of the trait's tenant that still uses it. A published version is immutable, so one that carries the trait would be
 * left unresolvable for good (`UNRESOLVED_REFERENCE` on every spec that uses it) if the trait went away, and a live draft would
 * dangle until someone repaired it:
 * - published `message_versions.resolvedSpec.spec.traitIds` (the frozen message spec);
 * - published `event_spec_versions.frozenTraits` (by id);
 * - draft `messages.spec.traitIds`;
 * - draft `event_specs.document.operations[].traitIds`.
 * All four are jsonb containment reads (`@>`), so a malformed stored document cannot hide a reference, and every one filters on
 * `tenantId`. Run it inside the delete's own transaction (like `deleteMessage`'s pin check); it takes no locks.
 */
export async function findTraitReferrers(db: Db, trait: { id: string; tenantId: string }): Promise<AssetReferrers> {
  const { id, tenantId } = trait;
  // Sequential on purpose: `db` is normally the delete's interactive transaction (one connection), where concurrent queries
  // only queue behind each other (and trip the driver's "client is already executing a query" deprecation).
  const messageVersions = await db.messageVersion.findMany({
    where: { message: { tenantId }, resolvedSpec: { path: ["spec", "traitIds"], array_contains: [id] } },
    select: { major: true, minor: true, message: { select: { id: true, name: true } } },
    orderBy: messageVersionOrder,
    take: SCAN_TAKE,
  });
  const specVersions = await db.eventSpecVersion.findMany({
    where: { eventSpec: { tenantId }, frozenTraits: { array_contains: [{ id }] } },
    select: { major: true, minor: true, eventSpec: { select: { id: true, name: true } } },
    orderBy: specVersionOrder,
    take: SCAN_TAKE,
  });
  const messages = await db.message.findMany({
    where: { tenantId, spec: { path: ["traitIds"], array_contains: [id] } },
    select: { id: true, name: true },
    orderBy: byName,
    take: SCAN_TAKE,
  });
  const specs = await db.eventSpec.findMany({
    where: { tenantId, document: { path: ["operations"], array_contains: [{ traitIds: [id] }] } },
    select: { id: true, name: true },
    orderBy: byName,
    take: SCAN_TAKE,
  });
  const flag = { truncated: false };
  const rows: ReferrerSource[] = [
    ...bounded(messageVersions, flag).map((v) => ({ kind: "Message" as const, ...v.message, version: v })),
    ...bounded(messages, flag).map((m) => ({ kind: "Message" as const, ...m })),
    ...bounded(specVersions, flag).map((v) => ({ kind: "Event spec" as const, ...v.eventSpec, version: v })),
    ...bounded(specs, flag).map((s) => ({ kind: "Event spec" as const, ...s })),
  ];
  return { referrers: groupReferrers(rows), truncated: flag.truncated };
}

/**
 * Everything of the channel's tenant that still uses it, with NO "other product" restriction (unlike `findCrossProductPins`: a
 * channel's own product's specs count too, because only the channel is going away, not the spec):
 * - published `event_spec_versions.frozenChannels` (by id), in any product of the tenant;
 * - draft `event_specs.document.operations[]` whose `channelId` or `reply.channelId` is the channel.
 * The channel's allowed-message rows (`channel_messages`) are not a reference: they cascade with it. Same transaction / no-lock
 * rules as `findTraitReferrers`.
 */
export async function findChannelReferrers(db: Db, channel: { id: string; tenantId: string }): Promise<AssetReferrers> {
  const { id, tenantId } = channel;
  // Sequential on purpose, as in `findTraitReferrers`.
  const specVersions = await db.eventSpecVersion.findMany({
    where: { eventSpec: { tenantId }, frozenChannels: { array_contains: [{ id }] } },
    select: { major: true, minor: true, eventSpec: { select: { id: true, name: true } } },
    orderBy: specVersionOrder,
    take: SCAN_TAKE,
  });
  const specs = await db.eventSpec.findMany({
    where: {
      tenantId,
      OR: [
        { document: { path: ["operations"], array_contains: [{ channelId: id }] } },
        { document: { path: ["operations"], array_contains: [{ reply: { channelId: id } }] } },
      ],
    },
    select: { id: true, name: true },
    orderBy: byName,
    take: SCAN_TAKE,
  });
  const flag = { truncated: false };
  const rows: ReferrerSource[] = [
    ...bounded(specVersions, flag).map((v) => ({ kind: "Event spec" as const, ...v.eventSpec, version: v })),
    ...bounded(specs, flag).map((s) => ({ kind: "Event spec" as const, ...s })),
  ];
  return { referrers: groupReferrers(rows), truncated: flag.truncated };
}

function describeReferrer(r: AssetReferrer): string {
  const shown = r.versions.slice(0, MAX_NAMED_REFERRER_VERSIONS).map((v) => `v${v}`);
  const more = r.versions.length - shown.length;
  const parts = [...shown, ...(more > 0 ? [`${more} more`] : []), ...(r.draft ? ["draft"] : [])];
  return `"${r.name}" (${parts.join(", ")})`;
}

/** `Messages "A" (v1.0), "B" (draft) and Event spec "S" (v2.0)`: at most `MAX_NAMED_REFERRERS` names, then `, and N more`. */
function describeReferrers(found: AssetReferrers): string {
  const shown = found.referrers.slice(0, MAX_NAMED_REFERRERS);
  const groups: string[] = [];
  for (const kind of ["Message", "Event spec"] as const) {
    const ofKind = shown.filter((r) => r.kind === kind);
    if (ofKind.length > 0) groups.push(`${kind}${ofKind.length === 1 ? "" : "s"} ${ofKind.map(describeReferrer).join(", ")}`);
  }
  const hidden = found.referrers.length - shown.length;
  const tail = hidden > 0 ? `, and ${hidden}${found.truncated ? "+" : ""} more` : found.truncated ? ", and more" : "";
  return `${groups.join(" and ")}${tail}`;
}

/**
 * IN_USE naming the same-tenant messages / event specs that still use the trait or channel (capped), or null when none does.
 * `details.referrers` is the structured (scan-bounded) list. Published versions cannot be changed or deleted on their own, so
 * the remedy for those is deleting their owner; a draft-only reference is fixed by editing the draft.
 */
export function assetInUseError(kind: GuardedAssetKind, name: string, found: AssetReferrers): ServiceError | null {
  if (found.referrers.length === 0) return null;
  const published = found.referrers.find((r) => r.versions.length > 0);
  const noun = kind.toLowerCase();
  const others = found.referrers.length > 1 ? " and the other users listed" : "";
  const suggestedFix = published
    ? `Published versions cannot be changed, so delete ${published.kind.toLowerCase()} "${published.name}" (which removes its published versions)${others} first, or keep the ${noun}.`
    : `Remove the ${noun} from ${found.referrers.length === 1 ? `"${found.referrers[0].name}"` : "the drafts listed"} first, or keep the ${noun}.`;
  return {
    code: "IN_USE",
    message: `${kind} "${name}" cannot be deleted: it is used by ${describeReferrers(found)}.`,
    details: { referrers: found.referrers, truncated: found.truncated },
    suggestedFix,
  };
}
