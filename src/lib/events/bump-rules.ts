import type { BumpKind } from "@/lib/entity-versioning/types";
import type { EventSpecDocument, EventSpecOperation } from "@/lib/event-specs/types";
import { jsonPointer } from "@/lib/event-specs/json-pointer";
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
  // Traits are compared as sets: reordering `traitIds` is deliberately not a change.
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
  /** Trait id → name, used only to word operation-trait reasons (falls back to the id). */
  traitNames?: Record<string, string>;
}

/** A message-version id an operation uses that the side's `messageVersions` cannot explain. */
export interface UnresolvedMessageVersion {
  side: "previous" | "current";
  /** Operation key; reply entries read `<key> reply`. */
  operation: string;
  id: string;
  /** RFC 6901 pointer into that side's document. */
  pointer: string;
}

const versionInfo = (side: EventSpecBumpSide, id: string): MessageVersionInfo | undefined =>
  Object.prototype.hasOwnProperty.call(side.messageVersions, id) ? side.messageVersions[id] : undefined;

/** Every message-id list of an operation with its label and pointer (the operation's own, then its reply's). */
function messageLists(operation: EventSpecOperation, index: number): Array<{ label: string; ids: string[]; pointer: string }> {
  const lists = [{ label: operation.key, ids: operation.messageVersionIds, pointer: jsonPointer("operations", index, "messageVersionIds") }];
  if (operation.reply?.messageVersionIds) {
    lists.push({
      label: `${operation.key} reply`,
      ids: operation.reply.messageVersionIds,
      pointer: jsonPointer("operations", index, "reply", "messageVersionIds"),
    });
  }
  return lists;
}

/**
 * Message-version ids the bump rules cannot interpret, so a caller can fail closed instead of
 * inferring "message removed / unchanged" from missing data.
 * - previous side: every unknown id (the frozen side must always resolve);
 * - current side: unknown ids that are not a known draft message (`draftMessageIds` = unpublished
 *   Message ids, which D4 allows in `messageVersionIds` for previews).
 */
export function findUnresolvedMessageVersions(
  prev: EventSpecBumpSide | null,
  next: EventSpecBumpSide,
  draftMessageIds: Iterable<string> = []
): UnresolvedMessageVersion[] {
  const drafts = new Set(draftMessageIds);
  const found: UnresolvedMessageVersion[] = [];
  const scan = (side: EventSpecBumpSide, name: UnresolvedMessageVersion["side"]) => {
    side.document.operations.forEach((operation, index) => {
      for (const list of messageLists(operation, index)) {
        list.ids.forEach((id, i) => {
          if (versionInfo(side, id)) return;
          if (name === "current" && drafts.has(id)) return;
          found.push({ side: name, operation: list.label, id, pointer: `${list.pointer}/${i}` });
        });
      }
    });
  };
  if (prev) scan(prev, "previous");
  scan(next, "current");
  return found;
}

interface MessageGroup {
  name: string;
  versions: Map<string, MessageVersionInfo>;
}

const compareLabels = (a: string, b: string): number => {
  const pa = a.split(".").map(Number);
  const pb = b.split(".").map(Number);
  for (let i = 0; i < Math.max(pa.length, pb.length); i += 1) {
    const diff = (pa[i] ?? 0) - (pb[i] ?? 0);
    if (Number.isNaN(diff)) return a.localeCompare(b);
    if (diff !== 0) return diff;
  }
  return 0;
};

/** Version ids grouped per Message (order and duplicates in `ids` do not matter). */
function groupByMessage(ids: string[], side: EventSpecBumpSide): Map<string, MessageGroup> {
  const groups = new Map<string, MessageGroup>();
  for (const id of ids) {
    const info = versionInfo(side, id);
    if (!info) continue;
    const group = groups.get(info.messageId) ?? { name: info.messageName, versions: new Map<string, MessageVersionInfo>() };
    group.versions.set(id, info);
    groups.set(info.messageId, group);
  }
  return groups;
}

/** Deterministic iteration: by message name, then message id. */
const sortedGroups = (groups: Map<string, MessageGroup>): Array<[string, MessageGroup]> =>
  [...groups.entries()].sort(([ida, a], [idb, b]) => a.name.localeCompare(b.name) || ida.localeCompare(idb));

const describeVersions = (group: MessageGroup): string =>
  [...group.versions.values()]
    .sort((a, b) => a.major - b.major || compareLabels(a.label, b.label))
    .map((v) => `v${v.label}`)
    .join(", ");

const majorsOf = (group: MessageGroup): Set<number> => new Set([...group.versions.values()].map((v) => v.major));

function compareMessages(
  label: string,
  prevIds: string[],
  nextIds: string[],
  prev: EventSpecBumpSide,
  next: EventSpecBumpSide,
  drafts: ReadonlySet<string>,
  major: string[],
  minor: string[]
): void {
  // A previous (frozen) id we cannot resolve hides what the operation used to allow → fail closed.
  for (const id of new Set(prevIds)) {
    if (!versionInfo(prev, id)) major.push(`Previous version of "${label}" references unknown message version "${id}" (treated as breaking)`);
  }
  // Draft Message ids (D4) have no version yet: they are neither "removed" nor "added".
  const pendingMessageIds = new Set(nextIds.filter((id) => !versionInfo(next, id) && drafts.has(id)));

  const p = groupByMessage(prevIds, prev);
  const n = groupByMessage(nextIds, next);
  for (const [messageId, before] of sortedGroups(p)) {
    if (pendingMessageIds.has(messageId)) continue;
    const after = n.get(messageId);
    if (!after) {
      major.push(`Message ${before.name} removed from operation "${label}"`);
      continue;
    }
    const beforeIds = [...before.versions.keys()];
    if (beforeIds.length === after.versions.size && beforeIds.every((id) => after.versions.has(id))) continue;
    const beforeMajors = majorsOf(before);
    const afterMajors = majorsOf(after);
    const text = `Message ${before.name} moved from ${describeVersions(before)} to ${describeVersions(after)}`;
    if ([...afterMajors].some((m) => !beforeMajors.has(m))) major.push(`${text} (new major) in "${label}"`);
    else if ([...beforeMajors].some((m) => !afterMajors.has(m))) major.push(`${text} (major version dropped) in "${label}"`);
    else minor.push(`${text} in "${label}"`);
  }
  for (const [messageId, after] of sortedGroups(n)) {
    if (!p.has(messageId)) minor.push(`Message ${after.name} added to "${label}"`);
  }
}

const opDetails = (o: EventSpecOperation) => ({ summary: o.summary, description: o.description, bindings: o.bindings });

export interface EventSpecBumpOptions {
  /** Unpublished Message ids present in the current document (D4 drafts): excluded from removal inference. */
  draftMessageIds?: Iterable<string>;
}

/** Spec §6.1 Event Spec bump rules + D6. */
export function classifyEventSpecBump(prev: EventSpecBumpSide, next: EventSpecBumpSide, options: EventSpecBumpOptions = {}): BumpDecision {
  const major: string[] = [];
  const minor: string[] = [];
  const drafts = new Set(options.draftMessageIds ?? []);
  const nextOps = new Map(next.document.operations.map((o) => [o.key, o]));
  const prevKeys = new Set(prev.document.operations.map((o) => o.key));
  const traitName = (id: string) => next.traitNames?.[id] ?? prev.traitNames?.[id] ?? id;

  for (const p of prev.document.operations) {
    const n = nextOps.get(p.key);
    if (!n) {
      major.push(`Operation "${p.key}" removed`);
      continue;
    }
    if (p.action !== n.action) major.push(`Operation "${p.key}" action changed from ${p.action} to ${n.action}`);
    if (p.channelId !== n.channelId) major.push(`Operation "${p.key}" moved to another channel`);
    compareMessages(p.key, p.messageVersionIds, n.messageVersionIds, prev, next, drafts, major, minor);
    if (p.reply && !n.reply) major.push(`Operation "${p.key}" reply removed`);
    else if (p.reply && n.reply) {
      if ((p.reply.channelId ?? null) !== (n.reply.channelId ?? null)) major.push(`Operation "${p.key}" reply moved to another channel`);
      compareMessages(`${p.key} reply`, p.reply.messageVersionIds ?? [], n.reply.messageVersionIds ?? [], prev, next, drafts, major, minor);
    } else if (!p.reply && n.reply) minor.push(`Operation "${p.key}" reply added`);
    // Operation traits are MINOR either way, but named explicitly; reordering is deliberately ignored.
    const prevTraits = p.traitIds ?? [];
    const nextTraits = n.traitIds ?? [];
    for (const id of prevTraits) if (!nextTraits.includes(id)) minor.push(`Operation "${p.key}" trait ${traitName(id)} removed`);
    for (const id of nextTraits) if (!prevTraits.includes(id)) minor.push(`Operation "${p.key}" trait ${traitName(id)} added`);
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
