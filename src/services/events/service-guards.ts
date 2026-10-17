// src/services/events/service-guards.ts
import type { Prisma, PrismaClient } from "@/generated/prisma/client";
import { resolveScope, type ScopeTarget } from "@/lib/asset-scope";
import { dbErrorResult } from "@/lib/db-error";
import { assertOwnedBy } from "@/lib/events/ownership";
import type { LevelScope } from "@/lib/levels";
import { ok, err, type Result } from "@/types/result";
import type { ServiceContext } from "@/types/service-context";

/** Upper bound for an untrusted id list (e.g. a channel's allowed messages). */
export const MAX_ID_LIST = 200;

const invalid = (message: string, suggestedFix?: string) =>
  err({ code: "VALIDATION_ERROR", message, ...(suggestedFix && { suggestedFix }) });

/**
 * Run a pre-write read so an unexpected throw (lost connection, driver / Prisma validation error) becomes a
 * `DB_ERROR` Result instead of crossing the service boundary. Writes go through `auditedWrite`, which maps
 * its own errors; this covers everything that runs before it (scope / ownership / reference lookups).
 * The Result carries only a generic message: the thrown error (driver text, table / column names) is logged server-side.
 */
export async function guardRead<T>(read: () => Promise<Result<T>>): Promise<Result<T>> {
  try {
    return await read();
  } catch (e: unknown) {
    return dbErrorResult("guardRead", e);
  }
}

type Db = PrismaClient | Prisma.TransactionClient;

export interface OwnedRowParams<TRow extends LevelScope> {
  /** What the row is, as shown to the user: "Message", "Event spec", "Channel", "Trait". */
  kind: string;
  /**
   * The id the caller supplied. It names the row in BOTH failures; the row's own `name` is never used, because the row may belong
   * to another product, level or tenant and a FORBIDDEN must not reveal what it is.
   */
  id: string;
  /** The scope the caller acts from (a product page passes `{ level: "PRODUCT", productId }`). */
  owner: ScopeTarget;
  /** The row by id through the caller's own Prisma delegate and select; the select must include `tenantId`, `domainId` and `productId`. */
  load: (id: string) => Promise<TRow | null>;
}

/**
 * The ownership read shared by every events asset service (spec §10: another level's / product's records are read-only here):
 * resolve the scope from the owner (unknown product / domain -> NOT_FOUND), load the row by id (unknown -> NOT_FOUND), and require
 * tenant + domain + product to match (`assertOwnedBy`, otherwise FORBIDDEN with no `details`). Returns the row and the resolved
 * scope. A DB throw anywhere in the reads becomes `DB_ERROR` (`guardRead`), so callers never need their own try / catch.
 * Id and owner SHAPE validation (`requireId`, `parseScopeTarget`) stays with the caller: its messages name the caller's argument.
 */
export async function loadOwnedRow<TRow extends LevelScope>(db: Db, p: OwnedRowParams<TRow>): Promise<Result<{ row: TRow; scope: LevelScope }>> {
  return guardRead(async () => {
    const scope = await resolveScope(db, p.owner);
    if (!scope.success) return scope;
    const row = await p.load(p.id);
    if (!row) return err({ code: "NOT_FOUND", message: `${p.kind} "${p.id}" not found` });
    const owned = assertOwnedBy(row, scope.data, `${p.kind} "${p.id}"`);
    if (!owned.success) return owned;
    return ok({ row, scope: scope.data });
  });
}

/** A non-empty string id (rejects numbers, objects, arrays, empty / blank strings). */
export function requireId(value: unknown, label: string): Result<string> {
  if (typeof value !== "string" || value.trim() === "") return invalid(`${label} must be a non-empty string`);
  return ok(value);
}

/** The level columns of an event by id and nothing else: a foreign event's name, document or versions are never read by an ownership check. */
const eventLevelOf = (db: Db) => (id: string) => db.eventSpec.findUnique({ where: { id }, select: { tenantId: true, domainId: true, productId: true } });

/**
 * Spec §10 ownership of an event, checked ONCE per call before anything is read, rendered or written (an event's level columns never
 * change): the page's product must own the event (unknown event or product → NOT_FOUND, another product's or tenant's event →
 * FORBIDDEN). Neither error carries `details`, and the label is the caller's own id (never the row's name), so a foreign event's
 * name, document or versions never leak. Used by the emit and publish services.
 */
export async function assertOwnedEvent(db: Db, eventId: string, productId: string): Promise<Result<void>> {
  const eventIdOk = requireId(eventId, "eventId");
  if (!eventIdOk.success) return eventIdOk;
  const productIdOk = requireId(productId, "productId");
  if (!productIdOk.success) return productIdOk;
  const owned = await loadOwnedRow(db, { kind: "Event", id: eventId, owner: { level: "PRODUCT", productId: productIdOk.data }, load: eventLevelOf(db) });
  return owned.success ? ok(undefined) : owned;
}

/**
 * The id of an event that `owner` (the product the user is working in) owns, or NOT_FOUND / FORBIDDEN: the event the external-ref
 * candidate list leaves out is the user's own, never one the client merely names. The read is the shared ownership guard.
 */
export async function requireOwnedEvent(ctx: ServiceContext, eventId: unknown, owner: ScopeTarget): Promise<Result<string>> {
  const id = requireId(eventId, "eventId");
  if (!id.success) return id;
  const owned = await loadOwnedRow(ctx.prisma, { kind: "Event", id: id.data, owner, load: eventLevelOf(ctx.prisma) });
  return owned.success ? ok(id.data) : owned;
}

/** A required string (the value is returned untrimmed; callers normalize). */
export function requireString(value: unknown, label: string): Result<string> {
  return typeof value === "string" ? ok(value) : invalid(`${label} must be a string`);
}

/** An optional string: `undefined` / `null` -> null; anything else that is not a string is rejected. */
export function optionalString(value: unknown, label: string): Result<string | null> {
  if (value === undefined || value === null) return ok(null);
  return typeof value === "string" ? ok(value) : invalid(`${label} must be a string or null`);
}

/**
 * An array of non-empty string ids, de-duplicated (first occurrence wins). The raw length is capped at `max`
 * so an untrusted payload cannot make the service do unbounded work.
 */
export function parseIdList(value: unknown, label: string, max: number = MAX_ID_LIST): Result<string[]> {
  if (!Array.isArray(value)) return invalid(`${label} must be an array of ids`);
  if (value.length > max) {
    return invalid(`${label} has ${value.length} entries; the limit is ${max}`, `Send at most ${max} ids.`);
  }
  const bad = value.findIndex((v) => typeof v !== "string" || v.trim() === "");
  if (bad !== -1) return invalid(`${label}[${bad}] must be a non-empty string`);
  return ok([...new Set(value as string[])]);
}

/** A well-formed scope target: a known level plus a non-empty id for that level. */
export function parseScopeTarget(value: unknown): Result<ScopeTarget> {
  if (typeof value !== "object" || value === null) return invalid("Scope target must be an object");
  const t = value as { level?: unknown; tenantId?: unknown; domainId?: unknown; productId?: unknown };
  if (t.level === "TENANT") {
    const id = requireId(t.tenantId, "tenantId");
    return id.success ? ok({ level: "TENANT", tenantId: id.data }) : id;
  }
  if (t.level === "DOMAIN") {
    const id = requireId(t.domainId, "domainId");
    return id.success ? ok({ level: "DOMAIN", domainId: id.data }) : id;
  }
  if (t.level === "PRODUCT") {
    const id = requireId(t.productId, "productId");
    return id.success ? ok({ level: "PRODUCT", productId: id.data }) : id;
  }
  return invalid("Scope level must be TENANT, DOMAIN or PRODUCT");
}
