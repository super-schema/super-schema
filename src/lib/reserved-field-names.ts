// src/lib/reserved-field-names.ts
// Field names and asset names (entities, models, enums ...) that are not allowed while we use this AsyncAPI parser. Pure — client-safe.
//
// The list is `PARSER_UNSAFE_KEYS` (`src/lib/event-specs/own-property.ts`), the ONE place to lift it: an entity's field becomes a JSON Schema
// property of an event's payload, an entity's name a definition key of it, and the AsyncAPI parser crashes on a document that has a key of
// such a name (see there for why). So the name is refused wherever a field or an asset is created or renamed by a person (the field editor,
// the services, the TypeSpec source save, the entity wizard, the name registry) and renamed, with a warning, by the importers that take a name
// from a file. A field or an asset that already has the name is still caught when an event that pins its entity is emitted
// (`findParserUnsafeKeys`).
import { isParserUnsafeKey } from "@/lib/event-specs/own-property";
import { generateSlug } from "@/lib/slug";

/** The one sentence, so the wording lives once: `subject` is "field name" or "name". */
function reservedWording(name: string, subject: "field name" | "name"): string | null {
  if (typeof name !== "string") return null;
  const trimmed = name.trim();
  return isParserUnsafeKey(trimmed) ? `"${trimmed}" is a reserved name: AsyncAPI documents cannot contain it. Choose another ${subject}.` : null;
}

/**
 * Why `name` (compared trimmed and exactly: `hasownproperty` is fine) cannot be a field name, or null when it can. Anything that is not a
 * string is not looked at: callers get their names from the browser untyped, and their own checks answer for those.
 */
export function reservedFieldNameMessage(name: string): string | null {
  return reservedWording(name, "field name");
}

/** The same for the NAME of an entity, a model, an enum, an event ...: why `name` cannot be one, or null when it can. */
export function reservedNameMessage(name: string): string | null {
  return reservedWording(name, "name");
}

/** The message for the first field of `fields` whose name is reserved, or null. Not a list, or an entry that is not an object: null. */
export function firstReservedFieldNameMessage(fields: ReadonlyArray<{ name: string }>): string | null {
  if (!Array.isArray(fields)) return null;
  for (const field of fields) {
    const message = reservedFieldNameMessage(field?.name);
    if (message !== null) return message;
  }
  return null;
}

/** What an importer reports for a field it had to rename. `ownerName` says where (an entity, or a model with `kind: "model"`). */
export function reservedFieldRenamedMessage(from: string, to: string, ownerName: string, kind: "entity" | "model" = "entity"): string {
  return `The field "${from}" was renamed to "${to}": the name is reserved. It belongs to the ${kind} "${ownerName}".`;
}

/** What an importer reports for an entity or a model it had to rename. */
export function reservedNameRenamedMessage(kind: "entity" | "model", from: string, to: string): string {
  return `The ${kind} "${from}" was renamed to "${to}": the name is reserved.`;
}

/**
 * `fields` with every reserved name replaced by the first of `name_1`, `name_2`, ... that is not reserved and not used by another field of
 * the list (by name, or by URL slug: a field has a unique name AND a unique slug within its entity). `onRename` hears about each one.
 * Returns the very same array when nothing had to change.
 */
export function renameReservedFields<T extends { name: string }>(fields: readonly T[], onRename?: (from: string, to: string) => void): T[] {
  if (!fields.some((field) => reservedFieldNameMessage(field.name) !== null)) return fields as T[];
  const names = new Set(fields.map((field) => field.name.trim()));
  const slugs = new Set(fields.map((field) => generateSlug(field.name)));
  return fields.map((field) => {
    if (reservedFieldNameMessage(field.name) === null) return field;
    const from = field.name.trim();
    let n = 1;
    let to = `${from}_${n}`;
    while (reservedFieldNameMessage(to) !== null || names.has(to) || slugs.has(generateSlug(to))) {
      n += 1;
      to = `${from}_${n}`;
    }
    names.add(to);
    slugs.add(generateSlug(to));
    onRename?.(from, to);
    return { ...field, name: to };
  });
}

/**
 * The items of one import batch (entities, models) with every reserved name replaced by the first of `name_1`, `name_2`, ... that is not
 * reserved and not used by another item (names are compared case-insensitively: the name registry does). An `extends` that points at a renamed
 * item follows it. `renames` maps each ORIGINAL (trimmed) name to its new one, so the caller can rewrite what else refers to it; `onRename`
 * hears about each one. Returns the very same array when nothing had to change.
 */
export function renameReservedNames<T extends { name: string; extends?: string }>(
  items: readonly T[], onRename?: (from: string, to: string) => void,
): { items: T[]; renames: Map<string, string> } {
  const renames = new Map<string, string>();
  if (!items.some((item) => reservedNameMessage(item.name) !== null)) return { items: items as T[], renames };
  const taken = new Set(items.map((item) => item.name.trim().toLowerCase()));
  for (const item of items) {
    if (reservedNameMessage(item.name) === null) continue;
    const from = item.name.trim();
    let n = 1;
    let to = `${from}_${n}`;
    while (reservedNameMessage(to) !== null || taken.has(to.toLowerCase())) {
      n += 1;
      to = `${from}_${n}`;
    }
    taken.add(to.toLowerCase());
    renames.set(from, to);
    onRename?.(from, to);
  }
  const renamed = items.map((item) => {
    const name = renames.get(item.name.trim()) ?? item.name;
    const parent = item.extends === undefined ? undefined : renames.get(item.extends.trim());
    return name === item.name && parent === undefined ? item : { ...item, name, ...(parent === undefined ? {} : { extends: parent }) };
  });
  return { items: renamed, renames };
}
