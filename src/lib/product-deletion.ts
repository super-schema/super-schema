/**
 * Product delete guard (pure, client-safe).
 *
 * Deleting a product cascades (FK ON DELETE CASCADE) its entities and its
 * product-level Data Types (shared enums, custom scalars, unions) and APIs
 * (service definitions). None of those may be lost silently, so a product is
 * deletable only when it owns none of them.
 */
export interface ProductContentCounts {
  entities: number;
  sharedEnums: number;
  customScalars: number;
  unionTypes: number;
  services: number;
}

/** Product-level Data Types = shared enums + custom scalars + union types. */
export function productDataTypeCount(c: Pick<ProductContentCounts, "sharedEnums" | "customScalars" | "unionTypes">): number {
  return c.sharedEnums + c.customScalars + c.unionTypes;
}

function countLabel(n: number, singular: string, plural: string): string {
  return `${n} ${n === 1 ? singular : plural}`;
}

function joinList(parts: string[]): string {
  if (parts.length <= 1) return parts.join("");
  return `${parts.slice(0, -1).join(", ")} and ${parts[parts.length - 1]}`;
}

/**
 * The block message when the product still owns anything a delete would cascade,
 * or null when it is empty and safe to delete.
 */
export function productDeleteBlocker(c: ProductContentCounts): string | null {
  const parts: string[] = [];
  if (c.entities > 0) parts.push(countLabel(c.entities, "entity", "entities"));
  const dataTypes = productDataTypeCount(c);
  if (dataTypes > 0) parts.push(countLabel(dataTypes, "Data Type", "Data Types"));
  if (c.services > 0) parts.push(countLabel(c.services, "API", "APIs"));
  if (parts.length === 0) return null;
  return `Delete the product's ${joinList(parts)} before removing it`;
}
