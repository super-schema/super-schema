// src/features/events/builder/template/value.ts
// Pure helpers behind TemplateForm: what counts as "empty", setting a field on an AsyncAPI-shaped value object without ever
// storing an empty value, conditional visibility (`when`) and pointer matching for inline errors. Client-safe, no React.
import type { FieldTemplate } from "@/lib/events/templates";

const isRecord = (v: unknown): v is Record<string, unknown> => typeof v === "object" && v !== null && !Array.isArray(v);

/**
 * True for a value that carries nothing and is omitted from the output: `undefined`, `null`, `""`, `[]`, `{}` and an object whose
 * values are all empty. `0` and `false` are values. An array is empty only when it has no items: an item that is itself empty
 * (`[{}]`) is an item card the user just added and must stay.
 */
export function isEmptyValue(v: unknown): boolean {
  if (v === undefined || v === null) return true;
  if (typeof v === "string") return v === "";
  if (Array.isArray(v)) return v.length === 0;
  if (isRecord(v)) return Object.values(v).every(isEmptyValue);
  return false;
}

export interface SetFieldOptions {
  /**
   * The value is a map whose entries mean something even when they hold nothing (a declared channel parameter `{ userId: {} }`,
   * a label with an empty value): it is empty only when it has no entries.
   */
  keepEmptyEntries?: boolean;
}

/**
 * `value` with `key` set to `next`, or without the key when `next` is empty (see `isEmptyValue`). Never mutates `value`;
 * every other key (including unknown ones such as `x-…` extensions) is carried over untouched and in order.
 */
export function setField(value: Record<string, unknown>, key: string, next: unknown, options: SetFieldOptions = {}): Record<string, unknown> {
  const empty = options.keepEmptyEntries && isRecord(next) ? Object.keys(next).length === 0 : isEmptyValue(next);
  if (empty) return omitKey(value, key);
  return { ...value, [key]: next };
}

/** A copy of `value` without `key`; the same object when the key is not there. */
export function omitKey(value: Record<string, unknown>, key: string): Record<string, unknown> {
  if (!Object.hasOwn(value, key)) return value;
  const next = { ...value };
  delete next[key];
  return next;
}

/** Whether a field is shown: always, unless its template says it only applies while a sibling holds one of some values. */
export function whenMatches(field: FieldTemplate, value: Record<string, unknown>): boolean {
  if (!field.when) return true;
  const sibling = value[field.when.field];
  if (typeof sibling !== "string" && typeof sibling !== "number" && typeof sibling !== "boolean") return false;
  return field.when.oneOf.includes(String(sibling));
}

/** Whether the user has set the field (what the "More properties (N set)" count counts). */
export function isFieldSet(field: FieldTemplate, value: Record<string, unknown>): boolean {
  const v = value[field.key];
  if (field.kind === "keyValue" || (field.kind === "list" && field.mapKeyLabel)) return isRecord(v) && Object.keys(v).length > 0;
  if (field.kind === "boolean") return typeof v === "boolean";
  return !isEmptyValue(v);
}

/** Whether a problem pointer is `path` itself or something below it (`/a/b` is below `/a`, `/ab` is not). */
export function matchesPointer(pointer: string, path: string): boolean {
  return pointer === path || pointer.startsWith(`${path}/`);
}

/** The messages of the problems at `path` (or below it, unless `exact`), in the order given. */
export function errorsFor(errors: ReadonlyArray<{ pointer: string; message: string }> | undefined, path: string, options: { exact?: boolean } = {}): string[] {
  if (!errors) return [];
  return errors.filter((e) => (options.exact ? e.pointer === path : matchesPointer(e.pointer, path))).map((e) => e.message);
}

/** "Examples" -> "example", "Properties" -> "property": the noun for an add / remove button. */
export function singular(label: string): string {
  const lower = label.trim().toLowerCase();
  if (lower.endsWith("ies")) return `${lower.slice(0, -3)}y`;
  if (/(ss|us|is)$/.test(lower)) return lower;
  if (lower.endsWith("s")) return lower.slice(0, -1);
  return lower;
}
