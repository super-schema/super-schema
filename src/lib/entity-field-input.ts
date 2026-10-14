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
    ...(field.aliases?.length ? { aliases: field.aliases } : {}),
    ...(field.decorators && Object.keys(field.decorators).length > 0
      ? { decorators: field.decorators as Prisma.InputJsonValue }
      : {}),
  };
}
