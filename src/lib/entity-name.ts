import { builtInNameMessage } from "@/lib/compiler/built-in-names";
import { reservedEntitySlugMessage } from "@/lib/slug";

/**
 * Why an entity of this name cannot be created or renamed to, or null: its URL segment is reserved (`events`), or it is a built-in
 * type name of a language the schemas are generated for (`url`, `int32`, `String`: see `builtInNameConflict`). The check every path
 * that names an entity BY HAND makes: create, wizard, rename. An import does not refuse such a name, it renames the entity
 * (`renameBuiltInEntities`, src/lib/builtin-entity-renames.ts).
 */
export function entityNameMessage(name: string): string | null {
  return reservedEntitySlugMessage(name) ?? builtInNameMessage(name);
}

/** The longest entity name (the emitters write a file per declaration). */
export const MAX_ENTITY_NAME_LENGTH = 128;

/**
 * THE suffix rule of every rename of an entity name: the name itself for the first attempt, then `Name2`, `Name3`, ... The name is cut, never
 * the number, so the result stays within {@link MAX_ENTITY_NAME_LENGTH}. The events import's name allocator and the bulk import's rename of a
 * built-in type name both take their candidates from it, so the same name gets the same new name whichever way it comes in.
 */
export function numberedName(requested: string, attempt: number): string {
  const suffix = attempt <= 1 ? "" : String(attempt);
  return `${requested.slice(0, MAX_ENTITY_NAME_LENGTH - suffix.length)}${suffix}`;
}
