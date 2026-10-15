import type { BumpKind } from "@/lib/entity-versioning/types";
import type { EventSpecDocument, EventSpecOperation } from "@/lib/event-specs/types";
import type { MessageResolvedSpec, MessageSpec, ResolvedPin } from "./types";

export interface BumpDecision {
  bump: BumpKind;
  reasons: string[];
}

/** Key-order independent JSON (undefined members dropped) for structural equality. */
export function stableStringify(value: unknown): string {
  if (Array.isArray(value)) return `[${value.map(stableStringify).join(",")}]`;
  if (value !== null && typeof value === "object") {
    const record = value as Record<string, unknown>;
    return `{${Object.keys(record)
      .filter((k) => record[k] !== undefined)
      .sort()
      .map((k) => `${JSON.stringify(k)}:${stableStringify(record[k])}`)
      .join(",")}}`;
  }
  return JSON.stringify(value) ?? "null";
}

const same = (a: unknown, b: unknown) => stableStringify(a) === stableStringify(b);
const decide = (major: string[], minor: string[]): BumpDecision =>
  major.length > 0 ? { bump: "MAJOR", reasons: [...major, ...minor] } : { bump: "MINOR", reasons: minor };

function comparePin(role: string, prev: ResolvedPin | null, next: ResolvedPin | null, major: string[], minor: string[]): void {
  if (!prev && !next) return;
  if (prev && !next) {
    major.push(`${role} removed (was ${prev.entityName} v${prev.label})`);
    return;
  }
  if (!prev && next) {
    minor.push(`${role} added: ${next.entityName} v${next.label}`);
    return;
  }
  const p = prev as ResolvedPin;
  const n = next as ResolvedPin;
  if (p.entityId !== n.entityId) major.push(`${role} now references ${n.entityName} instead of ${p.entityName}`);
  else if (p.major !== n.major) major.push(`${role} pin moved from ${p.entityName} v${p.label} to v${n.label} (new major)`);
  else if (p.entityVersionId !== n.entityVersionId) minor.push(`${role} pin moved from v${p.label} to v${n.label}`);
}

const docsOf = (s: MessageSpec) => ({ title: s.title, summary: s.summary, description: s.description, tags: s.tags, externalDocs: s.externalDocs });

/** Spec §6.1 Message bump rules + D6. */
export function classifyMessageBump(prev: MessageResolvedSpec, next: MessageResolvedSpec, traitNames: Record<string, string> = {}): BumpDecision {
  const major: string[] = [];
  const minor: string[] = [];
  const traitName = (id: string) => traitNames[id] ?? id;
  comparePin("Payload", prev.payload, next.payload, major, minor);
  comparePin("Headers", prev.headers, next.headers, major, minor);
  comparePin("Kafka key", prev.key, next.key, major, minor);
  for (const id of prev.spec.traitIds) if (!next.spec.traitIds.includes(id)) major.push(`Trait ${traitName(id)} removed`);
  for (const id of next.spec.traitIds) if (!prev.spec.traitIds.includes(id)) minor.push(`Trait ${traitName(id)} added`);
  if ((prev.spec.contentType ?? "") !== (next.spec.contentType ?? "")) {
    major.push(`contentType changed from "${prev.spec.contentType ?? "(default)"}" to "${next.spec.contentType ?? "(default)"}"`);
  }
  if (!same(prev.spec.correlationId, next.spec.correlationId)) major.push("correlationId changed");
  if (prev.name !== next.name) minor.push(`Renamed from ${prev.name} to ${next.name}`);
  if (!same(docsOf(prev.spec), docsOf(next.spec))) minor.push("Documentation changed");
  if (!same(prev.spec.examples, next.spec.examples)) minor.push("Examples changed");
  if (!same(prev.spec.bindings, next.spec.bindings)) minor.push("Bindings changed");
  return decide(major, minor);
}

export interface MessageVersionInfo {
  messageId: string;
  messageName: string;
  major: number;
  label: string;
}

export interface EventSpecBumpSide {
  document: EventSpecDocument;
  /** Channel id → address (frozen copy for the previous side, live for the current side). */
  channelAddresses: Record<string, string | null>;
  channelNames: Record<string, string>;
  /** MessageVersion id → info, for every version id used by this side. */
  messageVersions: Record<string, MessageVersionInfo>;
}

function compareMessages(label: string, prevIds: string[], nextIds: string[], prev: EventSpecBumpSide, next: EventSpecBumpSide, major: string[], minor: string[]): void {
  const byMessage = (ids: string[], side: EventSpecBumpSide) => {
    const map = new Map<string, MessageVersionInfo>();
    for (const id of ids) {
      const info = side.messageVersions[id];
      if (info) map.set(info.messageId, info);
    }
    return map;
  };
  const p = byMessage(prevIds, prev);
  const n = byMessage(nextIds, next);
  for (const [messageId, before] of p) {
    const after = n.get(messageId);
    if (!after) major.push(`Message ${before.messageName} removed from operation "${label}"`);
    else if (after.major !== before.major) major.push(`Message ${before.messageName} moved from v${before.label} to v${after.label} (new major) in "${label}"`);
    else if (after.label !== before.label) minor.push(`Message ${before.messageName} moved from v${before.label} to v${after.label} in "${label}"`);
  }
  for (const [messageId, after] of n) if (!p.has(messageId)) minor.push(`Message ${after.messageName} added to "${label}"`);
}

const opDetails = (o: EventSpecOperation) => ({ summary: o.summary, description: o.description, bindings: o.bindings, traitIds: o.traitIds });

/** Spec §6.1 Event Spec bump rules + D6. */
export function classifyEventSpecBump(prev: EventSpecBumpSide, next: EventSpecBumpSide): BumpDecision {
  const major: string[] = [];
  const minor: string[] = [];
  const nextOps = new Map(next.document.operations.map((o) => [o.key, o]));
  const prevKeys = new Set(prev.document.operations.map((o) => o.key));

  for (const p of prev.document.operations) {
    const n = nextOps.get(p.key);
    if (!n) {
      major.push(`Operation "${p.key}" removed`);
      continue;
    }
    if (p.action !== n.action) major.push(`Operation "${p.key}" action changed from ${p.action} to ${n.action}`);
    if (p.channelId !== n.channelId) major.push(`Operation "${p.key}" moved to another channel`);
    compareMessages(p.key, p.messageVersionIds, n.messageVersionIds, prev, next, major, minor);
    if (p.reply && !n.reply) major.push(`Operation "${p.key}" reply removed`);
    else if (p.reply && n.reply) {
      if ((p.reply.channelId ?? null) !== (n.reply.channelId ?? null)) major.push(`Operation "${p.key}" reply moved to another channel`);
      compareMessages(`${p.key} reply`, p.reply.messageVersionIds ?? [], n.reply.messageVersionIds ?? [], prev, next, major, minor);
    } else if (!p.reply && n.reply) minor.push(`Operation "${p.key}" reply added`);
    if (!same(opDetails(p), opDetails(n))) minor.push(`Operation "${p.key}" details changed`);
  }
  for (const n of next.document.operations) if (!prevKeys.has(n.key)) minor.push(`Operation "${n.key}" added`);

  for (const [id, before] of Object.entries(prev.channelAddresses)) {
    if (!(id in next.channelAddresses)) continue;
    const after = next.channelAddresses[id];
    if (after !== before) major.push(`Channel ${next.channelNames[id] ?? prev.channelNames[id] ?? id} address changed from "${before}" to "${after}"`);
  }

  const shell = (d: EventSpecDocument) => ({ info: d.info, servers: d.servers, defaultContentType: d.defaultContentType, components: d.components });
  if (!same(shell(prev.document), shell(next.document))) minor.push("Info, servers or components changed");
  return decide(major, minor);
}
