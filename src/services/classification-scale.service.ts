/**
 * Classification scale service — the tenant's admin-defined levels as a name -> class map,
 * for `classNumberOf(level, custom)` in `@/lib/classification-scale`.
 */

import type { Prisma } from "@/generated/prisma/client";
import { prisma } from "@/lib/db";

/** Custom (non-system) levels keyed by UPPERCASED name, valued by their 1-5 class. */
export async function loadCustomClassMap(db: Pick<Prisma.TransactionClient, "classificationLevel"> = prisma): Promise<Map<string, number>> {
  const rows = await db.classificationLevel.findMany({
    where: { isSystem: false },
    select: { name: true, classNumber: true },
  });
  return new Map(rows.map((r) => [r.name.toUpperCase(), r.classNumber]));
}
