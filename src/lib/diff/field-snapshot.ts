import type { FieldSnapshot } from "@/services/version-history/version.types";

/** The Field columns a snapshot captures. A Prisma `Field` row satisfies this structurally. */
export interface FieldSnapshotSource {
  id: string;
  name: string;
  type: string;
  precision: number | null;
  scale: number | null;
  nullable: boolean;
  isKey: boolean;
  fieldNumber: number | null;
  description: string;
  classification: string | null;
  aliases: string[];
  decorators: unknown;
  sortOrder: number;
}

/** Field projection frozen into EntityVersion.fieldSnapshot and compared by field-diff. */
export function toFieldSnapshot(field: FieldSnapshotSource): FieldSnapshot {
  return {
    id: field.id,
    name: field.name,
    type: field.type,
    precision: field.precision,
    scale: field.scale,
    nullable: field.nullable,
    isKey: field.isKey,
    fieldNumber: field.fieldNumber,
    description: field.description,
    classification: field.classification,
    aliases: field.aliases,
    decorators: (field.decorators as Record<string, unknown> | null) ?? {},
    sortOrder: field.sortOrder,
  };
}
