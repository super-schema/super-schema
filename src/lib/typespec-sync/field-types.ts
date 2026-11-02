/**
 * The field types a TypeSpec write may store. A type name that is not one of the app's types is refused before anything is written: a row
 * typed with a model or scalar name is generated back as `string` (or as a name nothing declares), so it is not stored. Pure.
 */

import { ALL_DATA_TYPES } from "@/lib/data-types";

/** The types a row may hold after a TypeSpec write: the app's data types, and a union (its members are read where they are declared). */
const WRITABLE_TYPES: ReadonlySet<string> = new Set<string>([...ALL_DATA_TYPES, "union"]);

/** A field of the entity's model as the source writes it: its name, its type and, for an array, its element type. */
export interface WrittenField {
  name: string;
  type: string;
  arrayElementType?: string;
  /** The members of a union the source declares (`A | B`): a union of values (`"a" | "b"`) has none. */
  unionMembers?: readonly string[];
}

/**
 * The fields whose type the source names with something that is not a type of the app: not one of its data types, not an enum the source
 * declares, not an entity of the tenant (`resolved`: the fields whose name resolved to one), and not a model the source declares (`declaredModels`:
 * a model named like an app type takes that name over). A union (`A | B`) is not checked here: its members are read where they are declared or
 * resolved (see `merge-fields`); a union with no members (a union of values) is refused. Each refusal names the field and the name it was typed with.
 */
export function unwritableFieldTypes(
  fields: readonly WrittenField[],
  opts: { enums: ReadonlySet<string>; resolved: ReadonlySet<string>; declaredModels?: ReadonlySet<string> }
): Array<{ field: string; written: string }> {
  const known = (name: string) => (WRITABLE_TYPES.has(name) || opts.enums.has(name)) && opts.declaredModels?.has(name) !== true;
  const refused: Array<{ field: string; written: string }> = [];
  for (const f of fields) {
    if (opts.resolved.has(f.name)) continue;
    if (f.type.includes("|")) {
      if (f.unionMembers && f.unionMembers.length > 0) continue;
      refused.push({ field: f.name, written: f.type });
      continue;
    }
    const written = f.type === "array" ? f.arrayElementType : f.type;
    if (written === undefined || known(written)) continue;
    refused.push({ field: f.name, written });
  }
  return refused;
}

/** The part of an import result the refusal reads: its models' fields and its shared enums (by name). */
export interface ImportedTypesForRefusal {
  models: ReadonlyArray<{ name: string; fields: readonly WrittenField[] }>;
  sharedEnums: ReadonlyArray<{ name: string }>;
}

/**
 * The first field of an import whose type is not a type of the app (`void`, a union that names no type, a scalar with no base), as the message
 * that refuses the import; null when every field is a type the app stores. A model-typed field is already a reference, an enum or a union of
 * values an enum field (both imports read them so). Shared by the TypeSpec and the OpenAPI import.
 */
export function refusedImportFieldMessage(result: ImportedTypesForRefusal): string | null {
  const enums = new Set(result.sharedEnums.map((e) => e.name));
  for (const model of result.models) {
    const [first] = unwritableFieldTypes(model.fields, { enums, resolved: new Set() });
    if (first) {
      return `Model "${model.name}": field "${first.field}" is typed "${first.written}", which is not a type of this app: use a TypeSpec standard type, an enum, a union or a model of the text.`;
    }
  }
  return null;
}
