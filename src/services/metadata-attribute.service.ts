/**
 * Metadata Attribute Dictionary service — tenant-scoped x-* attribute definitions.
 *
 * Authorization (admin rights) is enforced by the calling layer; every query
 * here is scoped by tenantId. Rows owned by a pack (`pack` set) are read-only.
 */

import { Prisma } from "@/generated/prisma/client";
import { prisma } from "@/lib/db";
import { checkValueSchema } from "@/lib/metadata-attributes/value-schema";
import {
  MetadataAttributeDefinitionSchema,
  type MetadataAttributeDefinition,
  type MetadataAttributeRecord,
  type MetadataAttributeTarget,
} from "@/types/schemas/metadata-attribute";
import { err, ok } from "@/types/result";
import type { Result } from "@/types/result";

type Row = Awaited<ReturnType<typeof prisma.metadataAttributeDefinition.findFirstOrThrow>>;

function toRecord(row: Row): MetadataAttributeRecord {
  return {
    id: row.id,
    tenantId: row.tenantId,
    key: row.key,
    label: row.label,
    description: row.description,
    valueSchema: row.valueSchema as unknown as MetadataAttributeRecord["valueSchema"],
    targets: row.targets as MetadataAttributeRecord["targets"],
    scope: row.scope as MetadataAttributeRecord["scope"],
    placement: row.placement as MetadataAttributeRecord["placement"],
    derive: (row.derive as Record<string, string> | null) ?? null,
    requiredWhen: row.requiredWhen as MetadataAttributeRecord["requiredWhen"],
    pack: row.pack,
    protobufOptionNumber: row.protobufOptionNumber,
    createdAt: row.createdAt,
    updatedAt: row.updatedAt,
  };
}

function invalidSchema(problems: string[]) {
  return err({
    code: "INVALID_VALUE_SCHEMA",
    message: problems[0],
    details: { problems },
    suggestedFix: "Use only type, enum, format, pattern, minimum, maximum, minLength, maxLength, items, properties and required.",
  });
}

function parseDefinition(input: unknown): Result<MetadataAttributeDefinition> {
  const vs = (input as { valueSchema?: unknown } | null)?.valueSchema;
  const problems = checkValueSchema(vs);
  if (problems.length > 0) return invalidSchema(problems);
  const parsed = MetadataAttributeDefinitionSchema.safeParse(input);
  if (!parsed.success) {
    return err({
      code: "VALIDATION_ERROR",
      message: parsed.error.issues[0].message,
      suggestedFix: "Check the metadata attribute fields.",
    });
  }
  return ok(parsed.data);
}

export async function listMetadataAttributes(
  tenantId: string,
  target?: "field" | "entity",
  db: Pick<Prisma.TransactionClient, "metadataAttributeDefinition"> = prisma,
): Promise<Result<MetadataAttributeRecord[]>> {
  const rows = await db.metadataAttributeDefinition.findMany({
    where: { tenantId, ...(target ? { targets: { has: target satisfies MetadataAttributeTarget } } : {}) },
    orderBy: { key: "asc" },
  });
  return ok(rows.map(toRecord));
}

/** The Protobuf option numbers metadata attributes get: in the range protobuf reserves for an organization's own extensions. */
export const PROTOBUF_OPTION_NUMBER_MIN = 50000;
export const PROTOBUF_OPTION_NUMBER_MAX = 99999;

/** Thrown inside the insert's transaction (rolling it back) when the tenant has handed out every option number. */
export class ProtobufOptionNumbersExhausted extends Error {
  constructor(readonly tenantId: string) {
    super(`Tenant ${tenantId} has used every Protobuf option number up to ${PROTOBUF_OPTION_NUMBER_MAX}`);
  }
}

export function optionNumbersExhausted() {
  return err({
    code: "PROTOBUF_OPTION_NUMBERS_EXHAUSTED",
    message: `This tenant has used every Protobuf option number (${PROTOBUF_OPTION_NUMBER_MIN}–${PROTOBUF_OPTION_NUMBER_MAX}); numbers are never reused, so no more metadata attributes can be created`,
    suggestedFix: "Reuse an existing metadata attribute instead of creating a new one.",
  });
}

/**
 * The next Protobuf option number of `tenantId`, taken from its high-water mark (`metadata_attribute_counters`) in ONE statement: the
 * counter row is created on first use (starting past any number already held) or incremented, and its row lock serializes concurrent
 * creates until `tx` ends. Call it inside the transaction that inserts the attribute, so a rolled-back insert gives the number back and a
 * committed one never sees it again, not even after a delete. Throws {@link ProtobufOptionNumbersExhausted} past 99999.
 */
export async function takeProtobufOptionNumber(tx: Pick<Prisma.TransactionClient, "$queryRaw">, tenantId: string): Promise<number> {
  const rows = await tx.$queryRaw<Array<{ taken: number }>>`
    INSERT INTO "metadata_attribute_counters" ("tenantId", "nextProtobufOption")
    VALUES (
      ${tenantId},
      GREATEST(
        ${PROTOBUF_OPTION_NUMBER_MIN}::integer,
        COALESCE((SELECT MAX("protobufOptionNumber") + 1 FROM "metadata_attribute_definitions" WHERE "tenantId" = ${tenantId}), 0)
      ) + 1
    )
    ON CONFLICT ("tenantId") DO UPDATE SET "nextProtobufOption" = "metadata_attribute_counters"."nextProtobufOption" + 1
    RETURNING "nextProtobufOption" - 1 AS "taken"`;
  const taken = Number(rows[0]?.taken);
  if (!Number.isInteger(taken) || taken > PROTOBUF_OPTION_NUMBER_MAX) throw new ProtobufOptionNumbersExhausted(tenantId);
  return taken;
}

export async function createMetadataAttribute(
  tenantId: string,
  input: unknown,
): Promise<Result<MetadataAttributeRecord>> {
  const parsed = parseDefinition(input);
  if (!parsed.success) return parsed;
  const d = parsed.data;
  const existing = await prisma.metadataAttributeDefinition.findUnique({ where: { tenantId_key: { tenantId, key: d.key } } });
  if (existing) return duplicate(d.key);
  try {
    const row = await prisma.$transaction(async (tx) => {
      const protobufOptionNumber = await takeProtobufOptionNumber(tx, tenantId);
      return tx.metadataAttributeDefinition.create({
        data: {
          tenantId,
          key: d.key,
          label: d.label,
          description: d.description,
          valueSchema: d.valueSchema as unknown as Prisma.InputJsonValue,
          targets: d.targets,
          scope: d.scope,
          placement: d.placement,
          derive: d.derive ? (d.derive as Prisma.InputJsonValue) : Prisma.DbNull,
          requiredWhen: d.requiredWhen,
          pack: d.pack ?? null,
          protobufOptionNumber,
        },
      });
    });
    return ok(toRecord(row));
  } catch (e) {
    if (e instanceof ProtobufOptionNumbersExhausted) return optionNumbersExhausted();
    if (e instanceof Prisma.PrismaClientKnownRequestError && e.code === "P2002") return duplicate(d.key);
    throw e;
  }
}

function duplicate(key: string) {
  return err({
    code: "DUPLICATE_KEY",
    message: `Metadata attribute "${key}" already exists`,
    suggestedFix: "Choose a different key.",
  });
}

function notFound() {
  return err({ code: "NOT_FOUND", message: "Metadata attribute not found", suggestedFix: "Refresh and try again." });
}

function packOwned(pack: string) {
  return err({
    code: "PACK_OWNED",
    message: `This attribute is owned by the "${pack}" pack and cannot be changed`,
    suggestedFix: "Uninstall the pack to remove it.",
  });
}

export async function updateMetadataAttribute(
  tenantId: string,
  id: string,
  patch: Partial<MetadataAttributeDefinition>,
): Promise<Result<MetadataAttributeRecord>> {
  const row = await prisma.metadataAttributeDefinition.findFirst({ where: { id, tenantId } });
  if (!row) return notFound();
  if (row.pack) return packOwned(row.pack);
  const current = toRecord(row);
  const merged = {
    key: current.key,
    label: current.label,
    description: current.description,
    valueSchema: current.valueSchema,
    targets: current.targets,
    scope: current.scope,
    placement: current.placement,
    derive: current.derive,
    requiredWhen: current.requiredWhen,
    pack: current.pack,
    ...patch,
  };
  const parsed = parseDefinition(merged);
  if (!parsed.success) return parsed;
  const d = parsed.data;
  if (d.key !== row.key) {
    const clash = await prisma.metadataAttributeDefinition.findUnique({ where: { tenantId_key: { tenantId, key: d.key } } });
    if (clash) return duplicate(d.key);
  }
  const updated = await prisma.metadataAttributeDefinition.update({
    where: { id },
    data: {
      key: d.key,
      label: d.label,
      description: d.description,
      valueSchema: d.valueSchema as unknown as Prisma.InputJsonValue,
      targets: d.targets,
      scope: d.scope,
      placement: d.placement,
      derive: d.derive ? (d.derive as Prisma.InputJsonValue) : Prisma.DbNull,
      requiredWhen: d.requiredWhen,
    },
  });
  return ok(toRecord(updated));
}

export async function deleteMetadataAttribute(tenantId: string, id: string): Promise<Result<{ id: string }>> {
  const row = await prisma.metadataAttributeDefinition.findFirst({ where: { id, tenantId } });
  if (!row) return notFound();
  if (row.pack) return packOwned(row.pack);
  await prisma.metadataAttributeDefinition.delete({ where: { id } });
  return ok({ id });
}
