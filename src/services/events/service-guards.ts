// src/services/events/service-guards.ts
import type { ScopeTarget } from "@/lib/asset-scope";
import { ok, err, type Result } from "@/types/result";

/** Upper bound for an untrusted id list (e.g. a channel's allowed messages). */
export const MAX_ID_LIST = 200;

const invalid = (message: string, suggestedFix?: string) =>
  err({ code: "VALIDATION_ERROR", message, ...(suggestedFix && { suggestedFix }) });

/**
 * Run a pre-write read so an unexpected throw (lost connection, driver / Prisma validation error) becomes a
 * `DB_ERROR` Result instead of crossing the service boundary. Writes go through `auditedWrite`, which maps
 * its own errors; this covers everything that runs before it (scope / ownership / reference lookups).
 */
export async function guardRead<T>(read: () => Promise<Result<T>>): Promise<Result<T>> {
  try {
    return await read();
  } catch (e: unknown) {
    return err({ code: "DB_ERROR", message: e instanceof Error && e.message ? e.message : "Database error" });
  }
}

/** A non-empty string id (rejects numbers, objects, arrays, empty / blank strings). */
export function requireId(value: unknown, label: string): Result<string> {
  if (typeof value !== "string" || value.trim() === "") return invalid(`${label} must be a non-empty string`);
  return ok(value);
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
