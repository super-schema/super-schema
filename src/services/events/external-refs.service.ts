// src/services/events/external-refs.service.ts
// Read side of external event references (spec 2026-10-16 §5): the loaders the reference picker and the "newer version
// available" badge use. Nothing is written. An item is found in a version's stored `resolvedSpec` by id (= the reference's
// `itemKey`), the way `event-snapshot` resolves it and `validateDocumentRefs` validates it.
//
// Every function is scoped by `tenantId`, which the caller takes from the authenticated context, never from the client: an
// event or version of another tenant reads exactly like a missing one (NOT_FOUND naming only the id the caller sent).
import { Prisma } from "@/generated/prisma/client";
import type { ScopeTarget } from "@/lib/asset-scope";
import { formatVersionLabel } from "@/lib/entity-versioning/version-math";
import {
  externalItemSummaries, isNewerVersion, missingItemKeys,
  type ExternalEventCandidate, type ExternalRefInput, type ExternalRefStatus, type ExternalVersionItems, type ExternalVersionOption,
} from "@/lib/events/external-refs";
import { guardRead, loadOwnedRow, MAX_ID_LIST, requireId } from "@/services/events/service-guards";
import { ok, err, type Result } from "@/types/result";
import type { ServiceContext } from "@/types/service-context";

const DEFAULT_CANDIDATE_LIMIT = 25;
const MAX_CANDIDATE_LIMIT = 50;

/** Prisma passes `%` and `_` of a `contains` value on as LIKE wildcards; a search box holds plain text (`_` is even legal in an event name). */
const likeEscaped = (text: string) => text.replace(/[\\%_]/g, "\\$&");

const invalid = (message: string) => err({ code: "VALIDATION_ERROR", message });
const notFound = (what: string, id: string) => err({ code: "NOT_FOUND", message: `${what} "${id}" not found` });

/** A version that carries a resolved spec (published since document v2); older versions cannot be referenced. */
const HAS_RESOLVED_SPEC = { resolvedSpec: { not: Prisma.DbNull } } satisfies Prisma.EventSpecVersionWhereInput;

// ── the event the picker is opened from ─────────────────────────────────────────────────────────────────────────────────

/**
 * The id of an event that `owner` (the product the user is working in) owns, or NOT_FOUND / FORBIDDEN: the event the candidate
 * list leaves out is the user's own, never one the client merely names. The read is the shared ownership guard.
 */
export async function requireOwnedEvent(ctx: ServiceContext, eventId: unknown, owner: ScopeTarget): Promise<Result<string>> {
  const id = requireId(eventId, "eventId");
  if (!id.success) return id;
  const owned = await loadOwnedRow(ctx.prisma, {
    kind: "Event", id: id.data, owner,
    load: (rowId) => ctx.prisma.eventSpec.findUnique({ where: { id: rowId }, select: { tenantId: true, domainId: true, productId: true } }),
  });
  return owned.success ? ok(id.data) : owned;
}

// ── candidates ──────────────────────────────────────────────────────────────────────────────────────────────────────────

export interface ListExternalEventCandidatesInput {
  tenantId: string;
  /** The event being edited: it can never reference itself, so it is never offered. */
  excludeEventId: string;
  /** Matched case-insensitively against the event, domain and product name. */
  query?: string;
  /** Default 25, at most 50. */
  limit?: number;
}

function candidateLimit(raw: unknown): Result<number> {
  if (raw === undefined) return ok(DEFAULT_CANDIDATE_LIMIT);
  if (typeof raw !== "number" || !Number.isFinite(raw)) return invalid("limit must be a number");
  return ok(Math.min(Math.max(Math.trunc(raw), 1), MAX_CANDIDATE_LIMIT));
}

/**
 * Published events of the tenant whose LATEST version carries a resolved spec, by event name; never `excludeEventId`, never an
 * event that was not published, never another tenant's. The resolved spec itself is not read (it holds the rendered schemas).
 */
export async function listExternalEventCandidates(ctx: ServiceContext, input: ListExternalEventCandidatesInput): Promise<Result<ExternalEventCandidate[]>> {
  if (typeof input !== "object" || input === null) return invalid("Input must be an object");
  const tenantId = requireId(input.tenantId, "tenantId");
  if (!tenantId.success) return tenantId;
  const excludeEventId = requireId(input.excludeEventId, "excludeEventId");
  if (!excludeEventId.success) return excludeEventId;
  if (input.query !== undefined && typeof input.query !== "string") return invalid("query must be a string");
  const limit = candidateLimit(input.limit);
  if (!limit.success) return limit;
  const query = input.query?.trim();
  const needle = query ? likeEscaped(query) : undefined;

  return guardRead(async () => {
    const rows = await ctx.prisma.eventSpec.findMany({
      where: {
        tenantId: tenantId.data,
        id: { not: excludeEventId.data },
        domainId: { not: null },
        productId: { not: null },
        latestVersion: { is: HAS_RESOLVED_SPEC },
        ...(needle && {
          OR: [
            { name: { contains: needle, mode: "insensitive" } },
            { domain: { is: { name: { contains: needle, mode: "insensitive" } } } },
            { product: { is: { name: { contains: needle, mode: "insensitive" } } } },
          ],
        }),
      },
      orderBy: [{ name: "asc" }, { id: "asc" }],
      take: limit.data,
      select: {
        id: true, name: true,
        domain: { select: { name: true } }, product: { select: { name: true } },
        latestVersion: { select: { id: true, major: true, minor: true } },
      },
    });
    const candidates: ExternalEventCandidate[] = [];
    for (const row of rows) {
      if (!row.latestVersion || !row.domain || !row.product) continue;
      candidates.push({
        eventId: row.id, eventName: row.name, domainName: row.domain.name, productName: row.product.name,
        latestVersionId: row.latestVersion.id, latestLabel: formatVersionLabel(row.latestVersion),
      });
    }
    return ok(candidates);
  });
}

// ── versions of one event ───────────────────────────────────────────────────────────────────────────────────────────────

/** The versions of an event of the tenant that can be referenced (they carry a resolved spec), newest first. */
export async function listExternalEventVersions(ctx: ServiceContext, input: { tenantId: string; eventId: string }): Promise<Result<ExternalVersionOption[]>> {
  if (typeof input !== "object" || input === null) return invalid("Input must be an object");
  const tenantId = requireId(input.tenantId, "tenantId");
  if (!tenantId.success) return tenantId;
  const eventId = requireId(input.eventId, "eventId");
  if (!eventId.success) return eventId;

  return guardRead(async () => {
    const event = await ctx.prisma.eventSpec.findFirst({
      where: { id: eventId.data, tenantId: tenantId.data },
      select: {
        versions: { where: HAS_RESOLVED_SPEC, orderBy: { sequence: "desc" }, select: { id: true, major: true, minor: true, publishedAt: true } },
      },
    });
    if (!event) return notFound("Event", eventId.data);
    return ok(event.versions.map((v) => ({ versionId: v.id, label: formatVersionLabel(v), publishedAt: v.publishedAt.toISOString() })));
  });
}

// ── items of one version ────────────────────────────────────────────────────────────────────────────────────────────────

/**
 * The channels and messages a version offers, from its stored resolved spec. What is malformed in the stored value is skipped;
 * a version without a usable resolved spec offers nothing (empty lists).
 */
export async function getExternalVersionItems(ctx: ServiceContext, input: { tenantId: string; eventVersionId: string }): Promise<Result<ExternalVersionItems>> {
  if (typeof input !== "object" || input === null) return invalid("Input must be an object");
  const tenantId = requireId(input.tenantId, "tenantId");
  if (!tenantId.success) return tenantId;
  const versionId = requireId(input.eventVersionId, "eventVersionId");
  if (!versionId.success) return versionId;

  return guardRead(async () => {
    const version = await ctx.prisma.eventSpecVersion.findFirst({
      where: { id: versionId.data, eventSpec: { tenantId: tenantId.data } },
      select: { major: true, minor: true, resolvedSpec: true, eventSpec: { select: { name: true } } },
    });
    if (!version) return notFound("Event version", versionId.data);
    return ok({
      eventName: version.eventSpec.name,
      label: formatVersionLabel(version),
      channels: externalItemSummaries(version.resolvedSpec, "channel") ?? [],
      messages: externalItemSummaries(version.resolvedSpec, "message") ?? [],
    });
  });
}

// ── status of the references of a document ──────────────────────────────────────────────────────────────────────────────

/** `refs` arrives from the client: every entry must be an object with a non-blank version id and item key and a known kind. */
function parseRefs(raw: unknown): Result<ExternalRefInput[]> {
  if (!Array.isArray(raw)) return invalid("refs must be an array");
  if (raw.length > MAX_ID_LIST) return invalid(`refs has ${raw.length} entries; the limit is ${MAX_ID_LIST}`);
  const refs: ExternalRefInput[] = [];
  for (const [i, ref] of raw.entries()) {
    if (typeof ref !== "object" || ref === null || Array.isArray(ref)) return invalid(`refs[${i}] must be an object`);
    const { eventVersionId, kind, itemKey } = ref as Record<string, unknown>;
    if (typeof eventVersionId !== "string" || eventVersionId.trim() === "") return invalid(`refs[${i}].eventVersionId must be a non-empty string`);
    if (kind !== "channel" && kind !== "message") return invalid(`refs[${i}].kind must be "channel" or "message"`);
    if (typeof itemKey !== "string" || itemKey.trim() === "") return invalid(`refs[${i}].itemKey must be a non-empty string`);
    refs.push({ eventVersionId, kind, itemKey });
  }
  return ok(refs);
}

/**
 * One status per DISTINCT referenced version (the order they first appear in `refs`): the version, its event's latest version,
 * whether the latest is newer (and a new major), and which of the referenced items of that version the latest no longer has. A
 * version that is not in the tenant (unknown or another tenant's) fails the whole call as NOT_FOUND. An event with no recorded
 * latest version counts as being at the referenced version; a latest without a usable resolved spec has none of the items.
 */
export async function getExternalRefStatuses(ctx: ServiceContext, input: { tenantId: string; refs: ExternalRefInput[] }): Promise<Result<ExternalRefStatus[]>> {
  if (typeof input !== "object" || input === null) return invalid("Input must be an object");
  const tenantId = requireId(input.tenantId, "tenantId");
  if (!tenantId.success) return tenantId;
  const parsed = parseRefs(input.refs);
  if (!parsed.success) return parsed;
  const refs = parsed.data;
  if (refs.length === 0) return ok([]);

  const refsByVersion = new Map<string, ExternalRefInput[]>();
  for (const ref of refs) refsByVersion.set(ref.eventVersionId, [...(refsByVersion.get(ref.eventVersionId) ?? []), ref]);

  return guardRead(async () => {
    const versions = await ctx.prisma.eventSpecVersion.findMany({
      where: { id: { in: [...refsByVersion.keys()] }, eventSpec: { tenantId: tenantId.data } },
      select: {
        id: true, major: true, minor: true,
        eventSpec: { select: { id: true, name: true, latestVersion: { select: { id: true, major: true, minor: true, resolvedSpec: true } } } },
      },
    });
    const versionById = new Map(versions.map((v) => [v.id, v]));
    const statuses: ExternalRefStatus[] = [];
    for (const [versionId, versionRefs] of refsByVersion) {
      const version = versionById.get(versionId);
      if (!version) return notFound("Event version", versionId);
      const { eventSpec } = version;
      const latest = eventSpec.latestVersion;
      if (!latest) {
        statuses.push({
          eventVersionId: version.id, eventId: eventSpec.id, eventName: eventSpec.name, label: formatVersionLabel(version),
          latestVersionId: version.id, latestLabel: formatVersionLabel(version), newerAvailable: false, newerIsMajor: false, itemsMissingInLatest: [],
        });
        continue;
      }
      const newerAvailable = isNewerVersion(version, latest);
      statuses.push({
        eventVersionId: version.id, eventId: eventSpec.id, eventName: eventSpec.name, label: formatVersionLabel(version),
        latestVersionId: latest.id, latestLabel: formatVersionLabel(latest),
        newerAvailable, newerIsMajor: newerAvailable && latest.major > version.major,
        itemsMissingInLatest: missingItemKeys(latest.resolvedSpec, versionRefs),
      });
    }
    return ok(statuses);
  });
}
