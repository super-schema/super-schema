import { prisma } from "@/lib/db";
import { Prisma } from "@/generated/prisma/client";
import { parseVersionLabel } from "@/lib/entity-versioning/version-math";
import { assetHref } from "@/lib/navigation/asset-href";
import type { EventVersionSummary, MessageDetail, MessageResolvedSpec } from "@/lib/events/types";
import { MESSAGE_SELECT, toMessageDetail } from "@/services/events/message.service";
import { toEventVersionSummary, VERSION_SUMMARY_SELECT } from "@/services/events/version-summary";
import { productCrumbs } from "@/features/events/crumbs";
import { loadEntityOptions, loadTraitOptions, ownerLabel, type TraitOption } from "@/features/events/load-options";
import { resolveProductRoute } from "@/features/events/route-scope";
import type { Crumb } from "@/features/events/shared/EventBreadcrumb";
import type { EntityOption } from "@/features/events/shared/EntityPinPicker";

export interface MessagePageData {
  message: MessageDetail;
  /** The route's product (tenant-scoped): what every mutating call passes as the owner. */
  productId: string;
  domainSlug: string;
  productSlug: string;
  crumbs: Crumb[];
  listHref: string;
  entityOptions: EntityOption[];
  traitOptions: TraitOption[];
  versions: EventVersionSummary[];
  /** `?version=1.3` — the frozen MessageVersion, read-only. */
  viewing: { label: string; resolvedSpec: MessageResolvedSpec } | null;
  /** Set when the message belongs to another product of the tenant: published versions only, never editable here. */
  owner?: { label: string; href: string } | null;
}

const PAGE_SELECT = {
  ...MESSAGE_SELECT,
  product: { select: { id: true, name: true, slug: true, domain: { select: { id: true, name: true, slug: true } } } },
} as const;

/** Another product's draft (spec, pins, flags) never reaches this page: only its name and published versions do. */
function publishedOnly(detail: MessageDetail): MessageDetail {
  return { ...detail, spec: { traitIds: [] }, payload: { entityId: "", entityVersionId: null }, headers: null, key: null, hasUnpublishedChanges: false };
}

/**
 * One frozen version by label. `parseVersionLabel` already bounds both parts to Int range, so Prisma cannot refuse the
 * value; if it still does (a value no row can hold: out of range, non-finite) that is "no such version", not a server error.
 * It is logged, and every other failure (connection loss, a broken query) still propagates.
 */
async function findVersion(messageId: string, { major, minor }: { major: number; minor: number }) {
  try {
    return await prisma.messageVersion.findUnique({ where: { messageId_major_minor: { messageId, major, minor } }, select: { resolvedSpec: true } });
  } catch (e: unknown) {
    if (e instanceof Prisma.PrismaClientValidationError || (e instanceof Prisma.PrismaClientKnownRequestError && e.code === "P2020")) {
      console.error("[loadMessagePage] version lookup refused by Prisma", e.name);
      return null;
    }
    throw e;
  }
}

/**
 * `null` means 404, for every reason alike (unknown route, unknown id, another tenant's message, malformed or unknown
 * `?version`), so the page cannot be used to probe what exists. The message is looked up inside the route's tenant;
 * `getMessage` / `getMessageVersion` are unscoped by-id reads and are deliberately not used here.
 */
export async function loadMessagePage(params: { domainSlug: string; productSlug: string; messageId: string; version?: string }): Promise<MessagePageData | null> {
  const route = await resolveProductRoute(params.domainSlug, params.productSlug);
  if (!route) return null;
  const row = await prisma.message.findFirst({ where: { id: params.messageId, tenantId: route.tenantId }, select: PAGE_SELECT });
  if (!row) return null;

  // Spec decision log ("cross-product references: allowed, read-only, by ID") + §4.4: other products read a message's
  // PUBLISHED versions, read-only — never its draft, so `?version` is mandatory there. (§10 only covers writes: FORBIDDEN.)
  const placement =
    row.productId === route.product.id ? ({ own: true } as const) : row.product && params.version ? ({ own: false, owner: row.product } as const) : null;
  if (!placement) return null;

  let viewing: MessagePageData["viewing"] = null;
  if (params.version) {
    const label = parseVersionLabel(params.version);
    if (!label.success) return null;
    const v = await findVersion(row.id, label.data);
    if (!v) return null;
    viewing = { label: `${label.data.major}.${label.data.minor}`, resolvedSpec: v.resolvedSpec as unknown as MessageResolvedSpec };
  }

  // The pickers only feed the draft editor, which a published version never shows.
  const scope = { tenantId: route.tenantId, domainId: route.domain.id, productId: route.product.id };
  const [versions, entityOptions, traitOptions] = await Promise.all([
    prisma.messageVersion.findMany({ where: { messageId: row.id }, orderBy: { sequence: "desc" }, select: VERSION_SUMMARY_SELECT }),
    viewing ? Promise.resolve<EntityOption[]>([]) : loadEntityOptions(route.tenantId),
    viewing ? Promise.resolve<TraitOption[]>([]) : loadTraitOptions(scope, "MESSAGE"),
  ]);
  const shared = {
    productId: route.product.id,
    domainSlug: route.domain.slug,
    productSlug: route.product.slug,
    entityOptions,
    traitOptions,
    versions: versions.map(toEventVersionSummary),
    viewing,
  };

  if (placement.own) {
    const listHref = assetHref({ kind: "events", domainSlug: route.domain.slug, productSlug: route.product.slug, section: "messages" });
    return { ...shared, message: toMessageDetail(row), crumbs: productCrumbs(route, { label: "Messages", href: listHref }, row.name), listHref };
  }

  // Crumbs and the owner link name the owning product; version links keep the reader on this read-only page.
  const ownerProduct = placement.owner;
  const at = { domainSlug: ownerProduct.domain.slug, productSlug: ownerProduct.slug };
  const listHref = assetHref({ kind: "events", ...at, section: "messages" });
  return {
    ...shared,
    message: publishedOnly(toMessageDetail(row)),
    crumbs: productCrumbs({ tenantId: route.tenantId, tenantSlug: route.tenantSlug, domain: ownerProduct.domain, product: ownerProduct }, { label: "Messages", href: listHref }, row.name),
    listHref,
    owner: { label: ownerLabel({ domain: ownerProduct.domain, product: ownerProduct }), href: assetHref({ kind: "message", id: row.id, ...at }, { version: viewing?.label }) },
  };
}
