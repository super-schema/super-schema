/**
 * Where an `abc-primitive` attribute sits for a field. The field's shape comes from the same stored decorators the compiler reads
 * (`compileEntity`): `type`, `arrayElementType`, the reference keys and the dangling marker.
 */

import { activeDanglingRef } from "@/lib/field-dangling";

export type Placement = "field" | "items" | "none";

export interface PlacementField {
  type: string;
  decorators?: unknown;
  complexType?: { arrayElementType?: string };
}

const NON_PRIMITIVE = new Set(["reference", "array", "map", "object", "union"]);

function decoratorsOf(field: PlacementField): Record<string, unknown> {
  const d = field.decorators;
  return d && typeof d === "object" && !Array.isArray(d) ? (d as Record<string, unknown>) : {};
}

function arrayElementType(field: PlacementField): string | undefined {
  const fromComplex = field.complexType?.arrayElementType;
  if (fromComplex !== undefined) return fromComplex;
  const raw = decoratorsOf(field).arrayElementType;
  return typeof raw === "string" ? raw : undefined;
}

function isDangling(field: PlacementField): boolean {
  const d = decoratorsOf(field);
  return activeDanglingRef(field.type, { danglingRef: d.danglingRef, arrayElementType: arrayElementType(field) }) !== undefined;
}

/** A scalar value field: not a reference, collection, nested object or union (an enum counts as a scalar). */
export function isPrimitiveField(field: PlacementField): boolean {
  return !NON_PRIMITIVE.has(field.type);
}

/**
 * resolved entity reference -> none; dangling reference -> field; array of primitives -> items; array of references -> none;
 * anything else -> field.
 */
export function abcPlacement(field: PlacementField): Placement {
  if (isDangling(field)) return "field";
  if (field.type === "reference") return "none";
  if (field.type === "array") {
    const element = arrayElementType(field) ?? "string";
    if (element === "reference") return "none";
    return NON_PRIMITIVE.has(element) ? "field" : "items";
  }
  return "field";
}
