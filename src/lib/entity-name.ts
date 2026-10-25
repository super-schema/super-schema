import { builtInNameMessage } from "@/lib/compiler/built-in-names";
import { reservedEntitySlugMessage } from "@/lib/slug";

/**
 * Why an entity of this name cannot be created or renamed to, or null: its URL segment is reserved (`events`), or it is a built-in
 * type name of a language the schemas are generated for (`url`, `int32`, `String`: see `builtInNameConflict`). The one check every path
 * that names an entity makes: create, wizard, imports, rename.
 */
export function entityNameMessage(name: string): string | null {
  return reservedEntitySlugMessage(name) ?? builtInNameMessage(name);
}
