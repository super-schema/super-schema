/**
 * The tenant's metadata attribute dictionary as emission needs it (`EmitterRunOptions.metadata`). Load it once per emission request.
 */

import type { Prisma } from "@/generated/prisma/client";
import { prisma } from "@/lib/db";
import { internalKeySet, type MetadataEmissionContext } from "@/lib/metadata-attributes/emission";
import { listMetadataAttributes } from "@/services/metadata-attribute.service";

/**
 * The context for `tenantId`, or `undefined` when the tenant has no definitions (then emission is exactly today's). Throws when the
 * dictionary cannot be read: emitting without it could publish `internal` values.
 */
export async function loadMetadataEmission(
  tenantId: string,
  db: Pick<Prisma.TransactionClient, "metadataAttributeDefinition"> = prisma,
): Promise<MetadataEmissionContext | undefined> {
  const listed = await listMetadataAttributes(tenantId, undefined, db);
  if (!listed.success) throw new Error(`The metadata attribute dictionary could not be read: ${listed.error.message}`);
  if (listed.data.length === 0) return undefined;
  return { definitions: listed.data };
}

/**
 * The `internal`-scope keys of `tenantId`'s dictionary (what the AsyncAPI assembler drops from an emitted document), or `undefined` when
 * there are none. Throws when the dictionary cannot be read, like {@link loadMetadataEmission}.
 */
export async function loadInternalKeys(
  tenantId: string,
  db: Pick<Prisma.TransactionClient, "metadataAttributeDefinition"> = prisma,
): Promise<ReadonlySet<string> | undefined> {
  return internalKeySet((await loadMetadataEmission(tenantId, db))?.definitions);
}
