/**
 * Metadata packs: install and uninstall a code-defined set of dictionary entries for a tenant.
 *
 * Authorization (admin rights) is enforced by the calling layer; every query is scoped by tenantId. Pack-owned rows refuse the
 * dictionary's update and delete, so this service writes through Prisma directly. Install is all-or-nothing: a key already owned by
 * the tenant stops it before anything is written. Uninstall removes only the pack's rows; stored field values stay as plain extensions.
 */

import { Prisma } from "@/generated/prisma/client";
import { prisma } from "@/lib/db";
import { getMetadataPack } from "@/lib/metadata-attributes/packs";
import { MetadataAttributeDefinitionSchema } from "@/types/schemas/metadata-attribute";
import { rederiveTenant } from "@/services/metadata-rederive.service";
import { optionNumbersExhausted, ProtobufOptionNumbersExhausted, takeProtobufOptionNumber } from "@/services/metadata-attribute.service";
import { err, ok } from "@/types/result";
import type { Result } from "@/types/result";

class KeyConflict extends Error {
  constructor(readonly key: string) {
    super(key);
  }
}

function unknownPack(id: string) {
  return err({ code: "NOT_FOUND", message: `Unknown pack "${id}"`, suggestedFix: "Refresh and try again." });
}

export async function installMetadataPack(tenantId: string, packId: string): Promise<Result<{ id: string; keys: string[] }>> {
  const pack = getMetadataPack(packId);
  if (!pack) return unknownPack(packId);
  const defs = pack.definitions.map((d) => MetadataAttributeDefinitionSchema.parse({ ...d, pack: pack.id }));
  const keys = defs.map((d) => d.key);

  try {
    await prisma.$transaction(async (tx) => {
      const clash = await tx.metadataAttributeDefinition.findFirst({ where: { tenantId, key: { in: keys }, pack: null } });
      if (clash) throw new KeyConflict(clash.key);
      for (const d of defs) {
        const data = {
          label: d.label,
          description: d.description,
          valueSchema: d.valueSchema as unknown as Prisma.InputJsonValue,
          targets: d.targets,
          scope: d.scope,
          placement: d.placement,
          derive: d.derive ? (d.derive as Prisma.InputJsonValue) : Prisma.DbNull,
          requiredWhen: d.requiredWhen,
          pack: pack.id,
        };
        // A reinstall keeps the row's option number; a new row takes the next one from the tenant's counter (never reused).
        const current = await tx.metadataAttributeDefinition.findUnique({ where: { tenantId_key: { tenantId, key: d.key } } });
        if (current) {
          const protobufOptionNumber = current.protobufOptionNumber ?? (await takeProtobufOptionNumber(tx, tenantId));
          await tx.metadataAttributeDefinition.update({ where: { id: current.id }, data: { ...data, protobufOptionNumber } });
        } else {
          const protobufOptionNumber = await takeProtobufOptionNumber(tx, tenantId);
          await tx.metadataAttributeDefinition.create({ data: { tenantId, key: d.key, ...data, protobufOptionNumber } });
        }
      }
    });
  } catch (e) {
    if (e instanceof KeyConflict) {
      return err({
        code: "KEY_CONFLICT",
        message: `This tenant already defines "${e.key}" itself, so the "${pack.name}" pack cannot be installed`,
        suggestedFix: "Rename or delete the tenant's own attribute, then install the pack.",
      });
    }
    if (e instanceof ProtobufOptionNumbersExhausted) return optionNumbersExhausted();
    throw e;
  }
  await rederiveTenant(tenantId);
  return ok({ id: pack.id, keys });
}

/** Removes only this pack's definitions. Field values already stored are left as they are. */
export async function uninstallMetadataPack(tenantId: string, packId: string): Promise<Result<{ id: string; removed: number }>> {
  if (!getMetadataPack(packId)) return unknownPack(packId);
  const { count } = await prisma.metadataAttributeDefinition.deleteMany({ where: { tenantId, pack: packId } });
  return ok({ id: packId, removed: count });
}

/** The ids of the packs installed for the tenant (a pack counts as installed while any of its rows exists). */
export async function installedPacks(tenantId: string): Promise<string[]> {
  const rows = await prisma.metadataAttributeDefinition.findMany({
    where: { tenantId, pack: { not: null } },
    select: { pack: true },
    distinct: ["pack"],
    orderBy: { pack: "asc" },
  });
  return rows.map((r) => r.pack!).filter((id) => getMetadataPack(id));
}
