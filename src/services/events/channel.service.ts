import type { Prisma } from "@/generated/prisma/client";
import type { ScopeTarget } from "@/lib/asset-scope";
import type { LevelScope } from "@/lib/levels";
import { normalizeCatalogName, normalizeFormatProfile, normalizeProtocol } from "@/lib/events/inputs";
import { parseChannelSpec, readChannelSpec } from "@/lib/events/catalog-specs";
import type { ChannelDetail, ChannelSpec, JsonSchemaDialect, PayloadFormat } from "@/lib/events/types";
import { createInScope, writeWithUniqueName } from "@/services/scoped-create.service";
import { auditedWrite } from "@/services/events/audited";
import {
  guardRead, loadOwnedRow, optionalString, parseIdList, parseScopeTarget, requireId, requireString,
} from "@/services/events/service-guards";
import { ok, err, type Result } from "@/types/result";
import type { ServiceContext } from "@/types/service-context";

export interface ChannelInput {
  name: string;
  address: string | null;
  protocol: string;
  format: string;
  formatDialect?: string | null;
  spec?: ChannelSpec;
}

const CHANNEL_SELECT = {
  id: true, name: true, address: true, protocol: true, format: true, formatDialect: true, spec: true,
  tenantId: true, domainId: true, productId: true,
  messages: { select: { messageId: true }, orderBy: { messageId: "asc" } },
} satisfies Prisma.ChannelSelect;
type ChannelRow = Prisma.ChannelGetPayload<{ select: typeof CHANNEL_SELECT }>;

function toDetail(row: ChannelRow): ChannelDetail {
  return {
    id: row.id, name: row.name, address: row.address, protocol: row.protocol,
    format: row.format as PayloadFormat, formatDialect: (row.formatDialect as JsonSchemaDialect | null) ?? null,
    spec: readChannelSpec(row.spec), tenantId: row.tenantId, domainId: row.domainId, productId: row.productId,
    allowedMessageIds: row.messages.map((m) => m.messageId),
  };
}

interface NormalizedChannel {
  name: string;
  address: string | null;
  protocol: string;
  format: PayloadFormat;
  formatDialect: JsonSchemaDialect | null;
  spec: ChannelSpec;
}

/** Input arrives from the client at runtime: check shapes before any string method runs on a field. */
function normalizeChannel(input: unknown): Result<NormalizedChannel> {
  if (typeof input !== "object" || input === null || Array.isArray(input)) {
    return err({ code: "VALIDATION_ERROR", message: "Channel input must be an object" });
  }
  const raw = input as Record<string, unknown>;
  const rawName = requireString(raw.name, "Channel name");
  if (!rawName.success) return rawName;
  const rawProtocol = requireString(raw.protocol, "Protocol");
  if (!rawProtocol.success) return rawProtocol;
  const rawFormat = requireString(raw.format, "Format");
  if (!rawFormat.success) return rawFormat;
  const rawAddress = optionalString(raw.address, "Address");
  if (!rawAddress.success) return rawAddress;
  const rawDialect = optionalString(raw.formatDialect, "Format dialect");
  if (!rawDialect.success) return rawDialect;

  const name = normalizeCatalogName(rawName.data, "Channel");
  if (!name.success) return name;
  const protocol = normalizeProtocol(rawProtocol.data);
  if (!protocol.success) return protocol;
  const profile = normalizeFormatProfile(rawFormat.data, rawDialect.data);
  if (!profile.success) return profile;
  const spec = parseChannelSpec(raw.spec ?? {});
  if (!spec.success) return spec;
  const address = rawAddress.data?.trim() ? rawAddress.data.trim() : null;
  return ok({ name: name.data, address, protocol: protocol.data, ...profile.data, spec: spec.data });
}

function columns(n: NormalizedChannel) {
  return { name: n.name, address: n.address, protocol: n.protocol, format: n.format, formatDialect: n.formatDialect, spec: n.spec as unknown as Prisma.InputJsonValue };
}

/** Validates the id + owner shapes, then reads the row and checks ownership; a DB throw becomes DB_ERROR. */
async function loadOwned(ctx: ServiceContext, id: unknown, owner: unknown): Promise<Result<{ row: ChannelRow; scope: LevelScope }>> {
  const channelId = requireId(id, "Channel id");
  if (!channelId.success) return channelId;
  const target = parseScopeTarget(owner);
  if (!target.success) return target;
  // Labelled by the caller's own id, never `row.name`: the row may belong to another product or tenant.
  return loadOwnedRow(ctx.prisma, {
    kind: "Channel", id: channelId.data, owner: target.data,
    load: (rowId) => ctx.prisma.channel.findUnique({ where: { id: rowId }, select: CHANNEL_SELECT }),
  });
}

export async function createChannel(productId: string, input: ChannelInput, ctx: ServiceContext): Promise<Result<ChannelDetail>> {
  const product = requireId(productId, "productId");
  if (!product.success) return product;
  const n = normalizeChannel(input);
  if (!n.success) return n;
  return auditedWrite({
    action: "CREATE", entityType: "Channel", entityId: "pending", userId: ctx.userId,
    run: async () => {
      const created = await createInScope(ctx.prisma, {
        kind: "channel",
        target: { level: "PRODUCT", productId: product.data },
        name: n.data.name,
        write: (tx, scope) => tx.channel.create({ data: { ...columns(n.data), ...scope }, select: CHANNEL_SELECT }),
      });
      return created.success ? ok(toDetail(created.data)) : created;
    },
  });
}

/**
 * Full replace of the editable columns: `name`, `address`, `protocol`, `format`, `formatDialect` and `spec` all
 * take the input's value, so an omitted `address` becomes null, an omitted `spec` resets to `{}`, and an omitted
 * `formatDialect` on a JSON Schema channel falls back to the default dialect (`draft-07`).
 * Preserved: the id, the level columns (tenant / domain / product) and the allowed messages — those change only
 * through `setChannelMessages`.
 */
export async function updateChannel(id: string, input: ChannelInput, owner: ScopeTarget, ctx: ServiceContext): Promise<Result<ChannelDetail>> {
  const n = normalizeChannel(input);
  if (!n.success) return n;
  const owned = await loadOwned(ctx, id, owner);
  if (!owned.success) return owned;
  return auditedWrite({
    action: "UPDATE", entityType: "Channel", entityId: id, userId: ctx.userId, beforeState: toDetail(owned.data.row),
    run: () =>
      writeWithUniqueName(ctx.prisma, {
        scope: owned.data.scope,
        name: n.data.name,
        exclude: { kind: "channel", id },
        write: async (tx) => toDetail(await tx.channel.update({ where: { id }, data: columns(n.data), select: CHANNEL_SELECT })),
      }),
  });
}

/**
 * Replace the channel's allowed-message set. `messageIds` must be an array of at most 200 non-empty strings
 * (duplicates collapse); every id must be a message of the channel's tenant (messages of other products in
 * the tenant are fine, other tenants' are "unknown"). A failed call changes nothing. A successful one also
 * bumps the channel's `updatedAt` (the set lives in a join table, so the row would otherwise look unchanged).
 */
export async function setChannelMessages(id: string, messageIds: string[], owner: ScopeTarget, ctx: ServiceContext): Promise<Result<ChannelDetail>> {
  const ids = parseIdList(messageIds, "messageIds");
  if (!ids.success) return ids;
  const owned = await loadOwned(ctx, id, owner);
  if (!owned.success) return owned;
  const unique = ids.data;
  const found = await guardRead(async () =>
    ok(await ctx.prisma.message.findMany({ where: { id: { in: unique }, tenantId: owned.data.row.tenantId }, select: { id: true } }))
  );
  if (!found.success) return found;
  const missing = unique.filter((m) => !found.data.some((f) => f.id === m));
  if (missing.length > 0) {
    return err({ code: "VALIDATION_ERROR", message: `Unknown message(s): ${missing.join(", ")}`, details: { problems: missing.map((m) => `Message "${m}" not found`) } });
  }
  return auditedWrite({
    action: "UPDATE", entityType: "Channel", entityId: id, userId: ctx.userId, beforeState: toDetail(owned.data.row),
    run: async () =>
      ok(
        toDetail(
          await ctx.prisma.$transaction(async (tx) => {
            await tx.channelMessage.deleteMany({ where: { channelId: id } });
            if (unique.length > 0) await tx.channelMessage.createMany({ data: unique.map((messageId) => ({ channelId: id, messageId })) });
            await tx.channel.update({ where: { id }, data: { updatedAt: new Date() } });
            return tx.channel.findUniqueOrThrow({ where: { id }, select: CHANNEL_SELECT });
          })
        )
      ),
  });
}

export async function deleteChannel(id: string, owner: ScopeTarget, ctx: ServiceContext): Promise<Result<{ id: string }>> {
  const owned = await loadOwned(ctx, id, owner);
  if (!owned.success) return owned;
  return auditedWrite({
    action: "DELETE", entityType: "Channel", entityId: id, userId: ctx.userId, beforeState: toDetail(owned.data.row),
    run: async () => {
      await ctx.prisma.channel.delete({ where: { id } });
      return ok({ id });
    },
  });
}

export async function getChannel(id: string, ctx: ServiceContext): Promise<Result<ChannelDetail>> {
  const channelId = requireId(id, "Channel id");
  if (!channelId.success) return channelId;
  return guardRead(async () => {
    const row = await ctx.prisma.channel.findUnique({ where: { id: channelId.data }, select: CHANNEL_SELECT });
    return row ? ok(toDetail(row)) : err({ code: "NOT_FOUND", message: `Channel "${channelId.data}" not found` });
  });
}

/** Read-side reuse by the page loaders (Task 15). */
export { CHANNEL_SELECT, toDetail as toChannelDetail };
