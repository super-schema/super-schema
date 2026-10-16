import { prisma } from "@/lib/db";
import { formatVersionLabel } from "@/lib/entity-versioning/version-math";
import type { LevelScope } from "@/lib/levels";
import { isBundledTrait, propertySummary, type PropertySummaryRow } from "@/lib/events/bundled-traits";
import { entitySourceFormat } from "@/lib/events/document/representation";
import { isJsonObject } from "@/lib/events/inputs";
import type { JsonObject, TraitKind } from "@/lib/events/types";
import { assetHref } from "@/lib/navigation/asset-href";
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
    select: {
      id: true, name: true, slug: true, latestVersionId: true, metadata: true, latestVersion: { select: { major: true, minor: true } },
      domain: { select: { name: true, slug: true } }, product: { select: { name: true, slug: true } },
    },
  });
  return rows.map((r) => {
    const sourceFormat = entitySourceFormat(r.metadata);
    return {
      id: r.id, name: r.name, ownerLabel: ownerLabel(r), latestVersionId: r.latestVersionId,
      latestVersionLabel: r.latestVersion ? formatVersionLabel(r.latestVersion) : null,
      href: assetHref({ kind: "entity", slug: r.slug, domainSlug: r.domain?.slug ?? null, productSlug: r.product?.slug ?? null }),
      ...(sourceFormat && { sourceFormat }),
    };
  });
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

/** A trait option as `loadTraitOptions` returns it: the picker fields plus what the builder needs to SHOW the trait's message properties. */
export interface LibraryTraitSource extends TraitOption {
  /** The stored AsyncAPI trait object (inline `headers` included), so the instant code can emit the real definition. */
  spec: JsonObject;
  /** Built in (`x-bundled`): read-only everywhere, shown locked. */
  bundled: boolean;
  /** The trait's inline headers as table rows (`propertySummary`); empty for a trait without inline properties. */
  properties: PropertySummaryRow[];
}

/** Traits visible from a level: Enterprise + that domain (product-level traits no longer exist; spec §4.3 line). */
export async function loadTraitOptions(scope: LevelScope, kind: TraitKind): Promise<LibraryTraitSource[]> {
  const rows = await prisma.trait.findMany({
    where: {
      tenantId: scope.tenantId,
      kind,
      OR: [
        { domainId: null },
        ...(scope.domainId ? [{ domainId: scope.domainId, productId: null }] : []),
      ],
    },
    orderBy: { name: "asc" },
    select: { id: true, name: true, spec: true, ...OWNER_SELECT },
  });
  return rows.map((r) => {
    const spec = isJsonObject(r.spec) ? r.spec : {};
    return { id: r.id, name: r.name, ownerLabel: ownerLabel(r), spec, bundled: isBundledTrait(spec), properties: propertySummary(spec) };
  });
}
