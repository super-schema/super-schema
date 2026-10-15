// src/lib/editable-fields.ts
import { ok, err, type Result } from "@/types/result";

/** Runtime check for one editable column's value (client input is untyped at the server-action boundary). */
export type ValueCheck = (value: unknown) => boolean;

export const isString: ValueCheck = (v) => typeof v === "string";
export const isBoolean: ValueCheck = (v) => typeof v === "boolean";
export const isStringOrNull: ValueCheck = (v) => v === null || typeof v === "string";
export const isInt: ValueCheck = (v) => typeof v === "number" && Number.isInteger(v);
export const isIntOrNull: ValueCheck = (v) => v === null || isInt(v);
export const isStringArray: ValueCheck = (v) => Array.isArray(v) && v.every((x) => typeof x === "string");
/**
 * A plain data object: not null, not an array and not one of the exotic objects the server-action wire can carry (`Date`,
 * `Map`, `Set`, `RegExp`, typed arrays, `Error`, `Promise`, ...). A `Date` has no own enumerable keys, so as `data` it would
 * pass the whitelist as `{}` and become a no-op update that still marks the draft changed.
 */
export const isPlainObject: ValueCheck = (v) => typeof v === "object" && v !== null && Object.prototype.toString.call(v) === "[object Object]";

/** An optional column: absent (`undefined`) is fine, anything else must pass `check`. */
export const optional =
  (check: ValueCheck): ValueCheck =>
  (v) =>
    v === undefined || check(v);

/** The most key names echoed back to the caller (a hostile payload must not turn the error into a megabyte reflection). */
const MAX_ECHOED_KEYS = 5;
const MAX_KEY_CHARS = 40;

const echo = (keys: string[]) =>
  keys
    .slice(0, MAX_ECHOED_KEYS)
    .map((k) => (k.length > MAX_KEY_CHARS ? `${k.slice(0, MAX_KEY_CHARS)}…` : k))
    .join(", ") + (keys.length > MAX_ECHOED_KEYS ? `, … (${keys.length} total)` : "");

const invalid = (message: string, suggestedFix?: string) =>
  err({ code: "VALIDATION_ERROR", message, ...(suggestedFix && { suggestedFix }) });

/**
 * The explicit whitelist for an update action's client `data` (the server-action boundary is untyped at runtime, so a
 * TypeScript parameter type protects nothing). `data` must be a plain object; every key must be one of `editable` and carry
 * a value its check accepts; a key whose value is `undefined` is treated as absent (it never survives JSON serialization
 * anyway). The returned object is built from the whitelisted keys only, so it is safe to hand to `prisma.<model>.update`.
 *
 * Unknown keys are REJECTED, never silently dropped: a payload naming `tenantId`, `domainId`, `productId`, `entityId`,
 * `id`, `createdAt`, a version / flag column or a server-derived `slug` is an attack or a client bug, and either way the
 * caller must see that nothing was written. Renames of registry-managed names (enums, scalars, unions, ...) are simply not
 * in a whitelist: they have no update path here, so the line-unique name registry cannot be bypassed.
 */
export function pickEditable(data: unknown, editable: Record<string, ValueCheck>, subject: string): Result<Record<string, unknown>> {
  if (!isPlainObject(data)) return invalid(`The changes to ${subject} must be an object`);
  const input = data as Record<string, unknown>;
  const unknown: string[] = [];
  const wrongType: string[] = [];
  const picked: Record<string, unknown> = {};
  for (const key of Object.keys(input)) {
    const check = Object.hasOwn(editable, key) ? editable[key] : undefined;
    if (!check) {
      unknown.push(key);
      continue;
    }
    const value = input[key];
    if (value === undefined) continue;
    if (!check(value)) {
      wrongType.push(key);
      continue;
    }
    picked[key] = value;
  }
  if (unknown.length > 0) {
    return invalid(
      `${unknown.length === 1 ? "This field is" : "These fields are"} not editable on ${subject}: ${echo(unknown)}`,
      `Editable fields: ${Object.keys(editable).join(", ")}.`
    );
  }
  if (wrongType.length > 0) return invalid(`Invalid value for ${echo(wrongType)} on ${subject}`);
  return ok(picked);
}

/**
 * For creates, where the write builds its columns explicitly (an extra key in `data` can never reach the database, so it
 * is ignored): `data` must be a plain object and every key of `shape` must pass its check (wrap optional ones in
 * `optional`). Returns the well-typed values of the named keys. Keeps a malformed payload (`name: 123`, `values: "a"`,
 * `data: null`) from reaching a `.trim()` or a Prisma validator and coming back as a raw TypeError / Prisma message.
 */
export function readFields(data: unknown, shape: Record<string, ValueCheck>, subject: string): Result<Record<string, unknown>> {
  if (!isPlainObject(data)) return invalid(`The details of ${subject} must be an object`);
  const input = data as Record<string, unknown>;
  const wrongType = Object.keys(shape).filter((key) => !shape[key](input[key]));
  if (wrongType.length > 0) return invalid(`Invalid or missing value for ${echo(wrongType)} on ${subject}`);
  const picked: Record<string, unknown> = {};
  for (const key of Object.keys(shape)) if (input[key] !== undefined) picked[key] = input[key];
  return ok(picked);
}
