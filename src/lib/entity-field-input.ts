import type { Prisma } from "@/generated/prisma/client";
import { generateSlug } from "@/lib/slug";
import type { CreateFieldInput } from "@/app/(dashboard)/schemas/[domainSlug]/actions";

/** Map a wizard/import field to the nested `Field` create input of `Entity.fields`. */
export function mapFieldCreateInput(
  field: CreateFieldInput,
  index: number
): Prisma.FieldCreateWithoutEntityInput {
  return {
    name: field.name,
    slug: generateSlug(field.name),
    type: field.type,
    nullable: field.nullable,
    isKey: field.isKey,
    description: field.description,
    classification: field.classification,
    precision: field.precision,
    scale: field.scale,
    sortOrder: index,
    ...(field.fieldNumber != null ? { fieldNumber: field.fieldNumber } : {}),
    ...(field.aliases?.length ? { aliases: field.aliases } : {}),
    ...(field.decorators && Object.keys(field.decorators).length > 0
      ? { decorators: field.decorators as Prisma.InputJsonValue }
      : {}),
  };
}

/** The largest value of a PostgreSQL `Int` column (`fields.precision`, `fields.scale`). */
const MAX_INT4 = 2_147_483_647;

const isStorableCount = (value: unknown): boolean =>
  value === null || value === undefined || (typeof value === "number" && Number.isInteger(value) && value >= 0 && value <= MAX_INT4);

/**
 * The message for the first field whose precision or scale the database cannot hold (not a whole number from 0 to 2147483647: `99999999999`,
 * a fraction, a string, NaN), or null. Said before anything is created, so a bad value is a validation error that names the field, not an
 * "unexpected failure" of the create. Not a list, or an entry that is not an object: null.
 */
export function firstInvalidDecimalFactMessage(fields: ReadonlyArray<{ name: string; precision?: unknown; scale?: unknown }>): string | null {
  if (!Array.isArray(fields)) return null;
  for (const field of fields) {
    if (field === null || typeof field !== "object") continue;
    const bad = !isStorableCount(field.precision) ? "precision" : !isStorableCount(field.scale) ? "scale" : null;
    if (bad !== null) {
      return `The ${bad} of the field "${String(field.name)}" must be a whole number from 0 to ${MAX_INT4}.`;
    }
  }
  return null;
}
