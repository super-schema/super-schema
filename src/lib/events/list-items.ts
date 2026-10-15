// src/lib/events/list-items.ts
import { formatVersionLabel } from "@/lib/entity-versioning/version-math";
import type { VersionNumber } from "@/lib/entity-versioning/types";
import { readChannelSpec, readMessageSpec } from "./catalog-specs";
import { isJsonObject } from "./inputs";
import type { ChannelListItem, EventSpecListItem, MessageListItem, PayloadFormat, TraitKind, TraitListItem } from "./types";

function summaryOf(spec: { summary?: unknown; description?: unknown }): string {
  const text = typeof spec.summary === "string" && spec.summary ? spec.summary : typeof spec.description === "string" ? spec.description : "";
  return text.slice(0, 200);
}
const label = (v: VersionNumber | null) => (v ? formatVersionLabel(v) : null);

export function channelListItem(row: { id: string; name: string; address: string | null; protocol: string; format: string; spec: unknown; updatedAt: Date }): ChannelListItem {
  return {
    id: row.id, name: row.name, summary: summaryOf(readChannelSpec(row.spec)), updatedAt: row.updatedAt.toISOString(),
    address: row.address, protocol: row.protocol, format: row.format as PayloadFormat,
  };
}

export function messageListItem(row: {
  id: string; name: string; spec: unknown; hasUnpublishedChanges: boolean; updatedAt: Date;
  latestVersion: VersionNumber | null; payloadEntity: { name: string };
}): MessageListItem {
  return {
    id: row.id, name: row.name, summary: summaryOf(readMessageSpec(row.spec)), updatedAt: row.updatedAt.toISOString(),
    latestVersionLabel: label(row.latestVersion), hasUnpublishedChanges: row.hasUnpublishedChanges, payloadEntityName: row.payloadEntity.name,
  };
}

export function eventSpecListItem(row: {
  id: string; name: string; document: unknown; hasUnpublishedChanges: boolean; updatedAt: Date; latestVersion: VersionNumber | null;
}): EventSpecListItem {
  const doc = isJsonObject(row.document) ? row.document : {};
  const info = isJsonObject(doc.info) ? doc.info : {};
  return {
    id: row.id, name: row.name, summary: summaryOf(info), updatedAt: row.updatedAt.toISOString(),
    latestVersionLabel: label(row.latestVersion), hasUnpublishedChanges: row.hasUnpublishedChanges,
    operationCount: Array.isArray(doc.operations) ? doc.operations.length : 0,
  };
}

export function traitListItem(row: { id: string; name: string; kind: string; spec: unknown; updatedAt: Date }): TraitListItem {
  return {
    id: row.id, name: row.name, kind: row.kind as TraitKind,
    summary: summaryOf(isJsonObject(row.spec) ? row.spec : {}), updatedAt: row.updatedAt.toISOString(),
  };
}
