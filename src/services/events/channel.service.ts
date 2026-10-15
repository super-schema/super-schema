import type { Prisma } from "@/generated/prisma/client";
import { resolveScope, type ScopeTarget } from "@/lib/asset-scope";
import type { LevelScope } from "@/lib/levels";
import { normalizeCatalogName, normalizeFormatProfile, normalizeProtocol } from "@/lib/events/inputs";
import { parseChannelSpec, readChannelSpec } from "@/lib/events/catalog-specs";
import { assertOwnedBy } from "@/lib/events/ownership";
import type { ChannelDetail, ChannelSpec, JsonSchemaDialect, PayloadFormat } from "@/lib/events/types";
import { createInScope, writeWithUniqueName } from "@/services/scoped-create.service";
import { auditedWrite } from "@/services/events/audited";
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

function normalizeChannel(input: ChannelInput): Result<NormalizedChannel> {
  const name = normalizeCatalogName(input.name, "Channel");
  if (!name.success) return name;
  const protocol = normalizeProtocol(input.protocol);
  if (!protocol.success) return protocol;
  const profile = normalizeFormatProfile(input.format, input.formatDialect);
  if (!profile.success) return profile;
  const spec = parseChannelSpec(input.spec ?? {});
  if (!spec.success) return spec;
  const address = input.address?.trim() ? input.address.trim() : null;
  return ok({ name: name.data, address, protocol: protocol.data, ...profile.data, spec: spec.data });
}

function columns(n: NormalizedChannel) {
  return { name: n.name, address: n.address, protocol: n.protocol, format: n.format, formatDialect: n.formatDialect, spec: n.spec as unknown as Prisma.InputJsonValue };
}

async function loadOwned(ctx: ServiceContext, id: string, owner: ScopeTarget): Promise<Result<{ row: ChannelRow; scope: LevelScope }>> {
  const scope = await resolveScope(ctx.prisma, owner);
  if (!scope.success) return scope;
  const row = await ctx.prisma.channel.findUnique({ where: { id }, select: CHANNEL_SELECT });
  if (!row) return err({ code: "NOT_FOUND", message: `Channel "${id}" not found` });
  const owned = assertOwnedBy(row, scope.data, `Channel "${row.name}"`);
  if (!owned.success) return owned;
  return ok({ row, scope: scope.data });
}

export async function createChannel(productId: string, input: ChannelInput, ctx: ServiceContext): Promise<Result<ChannelDetail>> {
  const n = normalizeChannel(input);
  if (!n.success) return n;
  return auditedWrite({
    action: "CREATE", entityType: "Channel", entityId: "pending", userId: ctx.userId,
    run: async () => {
      const created = await createInScope(ctx.prisma, {
        kind: "channel",
        target: { level: "PRODUCT", productId },
        name: n.data.name,
        write: (tx, scope) => tx.channel.create({ data: { ...columns(n.data), ...scope }, select: CHANNEL_SELECT }),
      });
      return created.success ? ok(toDetail(created.data)) : created;
    },
  });
}

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

export async function setChannelMessages(id: string, messageIds: string[], owner: ScopeTarget, ctx: ServiceContext): Promise<Result<ChannelDetail>> {
  const owned = await loadOwned(ctx, id, owner);
  if (!owned.success) return owned;
  const unique = [...new Set(messageIds)];
  const found = await ctx.prisma.message.findMany({ where: { id: { in: unique }, tenantId: owned.data.row.tenantId }, select: { id: true } });
  const missing = unique.filter((m) => !found.some((f) => f.id === m));
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
  const row = await ctx.prisma.channel.findUnique({ where: { id }, select: CHANNEL_SELECT });
  return row ? ok(toDetail(row)) : err({ code: "NOT_FOUND", message: `Channel "${id}" not found` });
}

/** Read-side reuse by the page loaders (Task 15). */
export { CHANNEL_SELECT, toDetail as toChannelDetail };
