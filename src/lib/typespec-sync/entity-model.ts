/**
 * Which model of a TypeSpec source is the entity's own. A source may declare several models (the entity's and the nested types it refers to,
 * in any order): the entity's model is the one named after the entity, spelled the way the generator spells the name. Pure.
 */

import { sanitizeIdentifier } from "@/lib/compiler/typespec-identifiers";

/**
 * The model named exactly as the entity, else the one named as the entity's identifier (an entity called `Order Item` has the model
 * `Order_Item`). Undefined when the source declares neither: the caller refuses, it never picks a model for the entity.
 */
export function entityModelOf<M extends { name: string }>(models: readonly M[], entityName: string): M | undefined {
  return models.find((m) => m.name === entityName) ?? models.find((m) => m.name === sanitizeIdentifier(entityName));
}
