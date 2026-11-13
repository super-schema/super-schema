/**
 * Where an `abc-primitive` attribute sits for a field. The field's shape comes from the same stored decorators the compiler reads
 * (`compileEntity`): `type`, `arrayElementType`, the reference keys and the dangling marker.
 */

import { activeDanglingRef } from "@/lib/field-dangling";

export type Placement = "field" | "items" | "none";

export interface PlacementField {
  type: string;
  decorators?: unknown;
  complexType?: { arrayElementType?: string; nestedFields?: unknown };
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

/** An `object` whose properties (`decorators.nestedFields`) are empty or missing: it carries a value, not a structure. */
function isPropertylessObject(field: PlacementField): boolean {
  const nested = field.complexType?.nestedFields ?? decoratorsOf(field).nestedFields;
  return !Array.isArray(nested) || nested.length === 0;
}

/**
 * A value field: not a reference, collection or union, and not an object with properties (an enum counts as a scalar; a
 * property-less object counts as primitive).
 */
export function isPrimitiveField(field: PlacementField): boolean {
  if (field.type === "object") return isPropertylessObject(field);
  return !NON_PRIMITIVE.has(field.type);
}

/**
 * Whether a `requiredWhen: "primitive"` attribute applies to the field: a value field, or an array whose elements are primitive (the value
 * then sits on `items`). The ONE predicate derive, the completeness alerts and the domain-policy defaults share.
 */
export function attributeApplies(field: PlacementField): boolean {
  return isPrimitiveField(field) || abcPlacement(field) === "items";
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
    if (element === "object") return isPropertylessObject(field) ? "items" : "field";
    return NON_PRIMITIVE.has(element) ? "field" : "items";
  }
  return "field";
}
