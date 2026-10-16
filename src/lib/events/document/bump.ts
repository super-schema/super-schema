// src/lib/events/document/bump.ts
// Event-level bump rules (spec 2026-10-15-events-self-contained-design §5). Pure — client-safe.
// Reuses the Message / Event Spec building blocks (`comparePin`, `compareTraitHeaders`, `decide`) from `../bump-rules`.
import { comparePin, compareTraitHeaders, decide, stableStringify, type BumpDecision, type BumpTraitHeadersPin } from "@/lib/events/bump-rules";
import type { PayloadFormat } from "@/lib/event-specs/types";
import type { EntityPin, ResolvedPin } from "@/lib/events/types";
import { describeRepresentation } from "./representation";
import { isLibraryTrait, type DocComponents, type DocOperation, type DocTrait, type EventDocument } from "./types";

/** What a pinned entityVersionId identifies. */
export type EventBumpPinFact = Omit<ResolvedPin, "entityVersionId">; // { entityId, entityName, label, major }

export interface EventBumpSide {
  doc: EventDocument;
  /** facts per pinned entityVersionId (every pin in the doc must have one when it is non-null) */
  pins: Readonly<Record<string, EventBumpPinFact>>;
  /** per library trait id: its frozen headers pin (null = none) */
  libraryHeaders: Readonly<Record<string, BumpTraitHeadersPin | null>>;
  /** per external-ref eventVersionId: the referenced version's major number */
  externalMajors: Readonly<Record<string, number>>;
  /**
   * The EFFECTIVE representation of each message, by message key (`effectiveRepresentationFormats`: the message's own choice, else
   * the channel's explicit format, else its entity's recorded format, else the protocol default). A message present on both sides
   * whose effective format differs is MAJOR. Absent = unknown: a changed `message.representation` then fails closed as MAJOR.
   */
  representations?: Readonly<Record<string, PayloadFormat>>;
}

interface Ctx {
  prev: EventBumpSide;
  next: EventBumpSide;
  major: string[];
  minor: string[];
}

const same = (a: unknown, b: unknown) => stableStringify(a) === stableStringify(b);
/** Document keys are user input: never read a prototype member through a lookup record. */
const own = <T>(record: Readonly<Record<string, T>>, key: string): T | undefined => (Object.prototype.hasOwnProperty.call(record, key) ? record[key] : undefined);
const byKey = <T extends { key: string }>(items: readonly T[]): Map<string, T> => new Map(items.map((item) => [item.key, item]));
const withoutOrigin = (item: object): object => Object.fromEntries(Object.entries(item).filter(([name]) => name !== "origin"));
/** Members of `from` that `other` lacks, in `from`'s order. */
const missingFrom = (from: readonly string[], other: readonly string[]): string[] => {
  const present = new Set(other);
  return [...new Set(from)].filter((key) => !present.has(key));
};
const channelText = (key: string | undefined) => (key === undefined ? "(none)" : `"${key}"`);

/** Message lists compare as sets (order is not a change). `where` completes "removed from …" / "added to …". */
function compareKeyList(c: Ctx, where: string, prev: readonly string[], next: readonly string[]): void {
  for (const key of missingFrom(prev, next)) c.major.push(`Message "${key}" removed from ${where}`);
  for (const key of missingFrom(next, prev)) c.minor.push(`Message "${key}" added to ${where}`);
}

/** The facts behind a pin. `null` = no pin or an unpinned one; `undefined` = a pinned version nobody supplied facts for. */
function pinFacts(side: EventBumpSide, pin: EntityPin | undefined): ResolvedPin | null | undefined {
  if (!pin || pin.entityVersionId === null) return null;
  const facts = own(side.pins, pin.entityVersionId);
  return facts ? { ...facts, entityVersionId: pin.entityVersionId } : undefined;
}

function comparePinRole(c: Ctx, role: string, prev: EntityPin | undefined, next: EntityPin | undefined): void {
  if (prev?.entityId === next?.entityId && prev?.entityVersionId === next?.entityVersionId) return; // the very same pin
  const before = pinFacts(c.prev, prev);
  const after = pinFacts(c.next, next);
  if (before === undefined || after === undefined) {
    c.major.push(`${role}: entity version facts unavailable (treated as breaking)`); // fail closed: a moved pin we cannot read
    return;
  }
  // `comparePin` calls a newly added pin MINOR (D6, whole-Message rule); at event level spec §5 makes any added pin MAJOR.
  if (!before && after) {
    c.major.push(`${role} added: ${after.entityName} v${after.label}`);
    return;
  }
  comparePin(role, before, after, c.major, c.minor);
}

/** Everything about an operation that is neither its wire contract (action, channel, messages, reply routing) nor its trait list. */
const operationDetails = (o: DocOperation) => ({
  title: o.title, summary: o.summary, description: o.description, security: o.security, tags: o.tags, externalDocs: o.externalDocs, bindings: o.bindings,
});

function compareOperations(c: Ctx): void {
  const nextOps = byKey(c.next.doc.operations);
  const prevOps = byKey(c.prev.doc.operations);
  for (const p of c.prev.doc.operations) {
    const n = nextOps.get(p.key);
    if (!n) {
      c.major.push(`Operation "${p.key}" removed`);
      continue;
    }
    if (p.action !== n.action) c.major.push(`Operation "${p.key}" action changed from ${p.action} to ${n.action}`);
    if (p.channelKey !== n.channelKey) c.major.push(`Operation "${p.key}" moved from channel "${p.channelKey}" to "${n.channelKey}"`);
    compareKeyList(c, `operation "${p.key}"`, p.messageKeys, n.messageKeys);
    if (p.reply && !n.reply) c.major.push(`Operation "${p.key}" reply removed`);
    else if (!p.reply && n.reply) c.minor.push(`Operation "${p.key}" reply added`);
    else if (p.reply && n.reply) {
      if (p.reply.channelKey !== n.reply.channelKey) {
        c.major.push(`Operation "${p.key}" reply moved from channel ${channelText(p.reply.channelKey)} to ${channelText(n.reply.channelKey)}`);
      }
      compareKeyList(c, `the reply of operation "${p.key}"`, p.reply.messageKeys ?? [], n.reply.messageKeys ?? []);
      if (!same(p.reply.address, n.reply.address)) c.minor.push(`Operation "${p.key}" reply address changed`);
    }
    for (const key of missingFrom(p.traitKeys, n.traitKeys)) c.minor.push(`Operation "${p.key}" trait "${key}" removed`);
    for (const key of missingFrom(n.traitKeys, p.traitKeys)) c.minor.push(`Operation "${p.key}" trait "${key}" added`);
    if (!same(operationDetails(p), operationDetails(n))) c.minor.push(`Operation "${p.key}" details changed`);
  }
  for (const n of c.next.doc.operations) if (!prevOps.has(n.key)) c.minor.push(`Operation "${n.key}" added`);
}

type ChannelDoc = EventDocument["channels"][number];
/** Everything about a channel that is neither its wire contract (compared above) nor its key list. `origin` is ignored (§5). */
const channelDetails = (ch: ChannelDoc) => ({
  serverKeys: [...ch.serverKeys].sort(), bindings: ch.bindings, title: ch.title, summary: ch.summary, description: ch.description,
  parameters: ch.parameters, tags: ch.tags, externalDocs: ch.externalDocs,
});

function compareChannels(c: Ctx): void {
  const nextChannels = byKey(c.next.doc.channels);
  const prevChannels = byKey(c.prev.doc.channels);
  for (const p of c.prev.doc.channels) {
    const n = nextChannels.get(p.key);
    if (!n) {
      c.major.push(`Channel "${p.key}" removed`);
      continue;
    }
    compareKeyList(c, `channel "${p.key}"`, p.messageKeys, n.messageKeys);
    // R78: the channel's address and wire profile are the consumer-visible contract.
    if (p.address !== n.address) c.major.push(`Channel "${p.key}" address changed from "${p.address ?? "(none)"}" to "${n.address ?? "(none)"}"`);
    if (p.protocol !== n.protocol) c.major.push(`Channel "${p.key}" protocol changed from ${p.protocol} to ${n.protocol}`);
    if (p.format !== n.format) {
      // An explicit format is optional (absent = Auto). Between two explicit formats it is the wire contract; switching to or from
      // Auto only matters through what each message ends up as, which the effective representations say — unless they are unknown.
      if (p.format !== undefined && n.format !== undefined) c.major.push(`Channel "${p.key}" format changed from ${p.format} to ${n.format}`);
      else if (!c.prev.representations || !c.next.representations) c.major.push(`Channel "${p.key}" format changed from ${p.format ?? "(auto)"} to ${n.format ?? "(auto)"}`);
    } else if (p.formatDialect !== n.formatDialect) {
      c.major.push(`Channel "${p.key}" formatDialect changed from ${p.formatDialect ?? "(none)"} to ${n.formatDialect ?? "(none)"}`);
    }
    if (!same(channelDetails(p), channelDetails(n))) c.minor.push(`Channel "${p.key}" details changed`);
  }
  for (const n of c.next.doc.channels) if (!prevChannels.has(n.key)) c.minor.push(`Channel "${n.key}" added`);
}

type MessageDoc = EventDocument["messages"][number];
const messageDocs = (m: MessageDoc) => ({ title: m.title, summary: m.summary, description: m.description, tags: m.tags, externalDocs: m.externalDocs });

/**
 * A changed EFFECTIVE representation is MAJOR: consumers decode the payload with it. Compared only for a message present on both
 * sides, and only through the effective formats both sides supply; without them the message's own `representation` is all there is
 * to compare, and a change there fails closed.
 */
function compareRepresentation(c: Ctx, p: MessageDoc, n: MessageDoc): void {
  const before = c.prev.representations ? own(c.prev.representations, p.key) : undefined;
  const after = c.next.representations ? own(c.next.representations, n.key) : undefined;
  if (before !== undefined && after !== undefined) {
    if (before !== after) c.major.push(`Message "${p.key}": representation ${describeRepresentation({ format: before })} → ${describeRepresentation({ format: after })}`);
    return;
  }
  if (p.representation !== n.representation) c.major.push(`Message "${p.key}": representation changed (effective formats unavailable, treated as breaking)`);
}

function compareMessages(c: Ctx): void {
  const nextMessages = byKey(c.next.doc.messages);
  const prevMessages = byKey(c.prev.doc.messages);
  for (const p of c.prev.doc.messages) {
    const n = nextMessages.get(p.key);
    if (!n) {
      c.major.push(`Message "${p.key}" removed`);
      continue;
    }
    compareRepresentation(c, p, n);
    comparePinRole(c, `Message "${p.key}" payload`, p.payload, n.payload);
    comparePinRole(c, `Message "${p.key}" headers`, p.headers, n.headers);
    comparePinRole(c, `Message "${p.key}" key`, p.keyPin, n.keyPin);
    // Traits compare as sets: reordering `traitKeys` is not a change.
    for (const key of missingFrom(p.traitKeys, n.traitKeys)) c.major.push(`Message "${p.key}" trait "${key}" removed`);
    for (const key of missingFrom(n.traitKeys, p.traitKeys)) c.minor.push(`Message "${p.key}" trait "${key}" added`);
    if ((p.contentType ?? "") !== (n.contentType ?? "")) {
      c.major.push(`Message "${p.key}" contentType changed from "${p.contentType ?? "(default)"}" to "${n.contentType ?? "(default)"}"`);
    }
    if (!same(p.correlationId, n.correlationId)) c.major.push(`Message "${p.key}" correlationId changed`);
    if (!same(messageDocs(p), messageDocs(n))) c.minor.push(`Message "${p.key}" documentation changed`);
    if (!same(p.name, n.name)) c.minor.push(`Message "${p.key}" name changed`);
    if (!same(p.deprecated, n.deprecated)) c.minor.push(`Message "${p.key}" deprecation changed`);
    if (!same(p.examples, n.examples)) c.minor.push(`Message "${p.key}" examples changed`);
    if (!same(p.bindings, n.bindings)) c.minor.push(`Message "${p.key}" bindings changed`);
  }
  for (const n of c.next.doc.messages) if (!prevMessages.has(n.key)) c.minor.push(`Message "${n.key}" added`);
}

/** A trait's headers pin as the bump rules read it. `undefined` = unknown (the facts for it were not supplied). */
function traitHeaders(side: EventBumpSide, trait: DocTrait): BumpTraitHeadersPin | null | undefined {
  if (isLibraryTrait(trait)) return own(side.libraryHeaders, trait.libraryTraitId);
  if (!trait.headers || trait.headers.entityVersionId === null) return null;
  const facts = own(side.pins, trait.headers.entityVersionId);
  return facts
    ? { entityId: facts.entityId, entityName: facts.entityName, entityVersionId: trait.headers.entityVersionId, major: facts.major, label: facts.label }
    : undefined;
}
/** Identity of what a trait's headers come from, to tell "unchanged" from "changed, facts missing". */
const traitHeadersRef = (t: DocTrait): string =>
  isLibraryTrait(t) ? `library:${t.libraryTraitId}` : t.headers ? `${t.headers.entityId}@${t.headers.entityVersionId}` : "none";
const traitContent = (t: DocTrait) => (isLibraryTrait(t) ? { kind: t.kind, libraryTraitId: t.libraryTraitId } : { kind: t.kind, spec: t.spec });

function compareTraits(c: Ctx): void {
  const nextTraits = byKey(c.next.doc.traits);
  const prevTraits = byKey(c.prev.doc.traits);
  for (const p of c.prev.doc.traits) {
    const n = nextTraits.get(p.key);
    if (!n) {
      c.minor.push(`Trait "${p.key}" removed`); // a message that used it already carries the MAJOR "trait removed"
      continue;
    }
    const before = traitHeaders(c.prev, p);
    const after = traitHeaders(c.next, n);
    if (before !== undefined && after !== undefined) compareTraitHeaders(`"${p.key}"`, before, after, c.major, c.minor);
    else if (traitHeadersRef(p) !== traitHeadersRef(n)) c.major.push(`Trait "${p.key}": headers entity version facts unavailable (treated as breaking)`);
    if (!same(traitContent(p), traitContent(n))) c.minor.push(`Trait "${p.key}" changed`);
  }
  for (const n of c.next.doc.traits) if (!prevTraits.has(n.key)) c.minor.push(`Trait "${n.key}" added`);
}

function compareExternalRefs(c: Ctx): void {
  const nextRefs = byKey(c.next.doc.externalRefs);
  const prevRefs = byKey(c.prev.doc.externalRefs);
  for (const p of c.prev.doc.externalRefs) {
    const n = nextRefs.get(p.key);
    if (!n) {
      c.major.push(`External reference "${p.key}" removed`);
      continue;
    }
    if (p.kind !== n.kind || p.itemKey !== n.itemKey) {
      c.major.push(`External reference "${p.key}" now points at ${n.kind} "${n.itemKey}" instead of ${p.kind} "${p.itemKey}"`);
    }
    if (p.eventVersionId === n.eventVersionId) continue;
    const before = own(c.prev.externalMajors, p.eventVersionId);
    const after = own(c.next.externalMajors, n.eventVersionId);
    if (before === undefined || after === undefined) c.major.push(`External reference "${p.key}": referenced version major unavailable (treated as breaking)`);
    else if (after > before) c.major.push(`External reference "${p.key}" moved to a new major (v${before} to v${after})`);
    else if (after < before) c.major.push(`External reference "${p.key}" moved to an older major (v${before} to v${after})`);
    else c.minor.push(`External reference "${p.key}" moved to another version of the same major (v${after})`);
  }
  for (const n of c.next.doc.externalRefs) if (!prevRefs.has(n.key)) c.minor.push(`External reference "${n.key}" added`);
}

const componentsOf = (components: DocComponents | undefined) =>
  components && {
    ...components,
    securitySchemes: components.securitySchemes && Object.fromEntries(Object.entries(components.securitySchemes).map(([name, scheme]) => [name, withoutOrigin(scheme)])),
  };

/** The document shell: `info`, `servers` and `components` are always MINOR. `origin` is ignored (§5). */
function compareShell(c: Ctx): void {
  if (!same(c.prev.doc.info, c.next.doc.info)) c.minor.push("Info changed");
  const nextServers = byKey(c.next.doc.servers);
  const prevServers = byKey(c.prev.doc.servers);
  for (const p of c.prev.doc.servers) {
    const n = nextServers.get(p.key);
    if (!n) c.minor.push(`Server "${p.key}" removed`);
    else if (!same(withoutOrigin(p), withoutOrigin(n))) c.minor.push(`Server "${p.key}" changed`);
  }
  for (const n of c.next.doc.servers) if (!prevServers.has(n.key)) c.minor.push(`Server "${n.key}" added`);
  if (!same(componentsOf(c.prev.doc.components), componentsOf(c.next.doc.components))) c.minor.push("Components changed");
}

/**
 * Event-level bump rules (spec §5). Operations, channels, messages, traits, external references and the document shell
 * are diffed by key, so a key rename is a removal plus an addition. Facts the rules cannot read for a changed pin (a version
 * id without `pins` / `externalMajors` facts) fail closed as MAJOR; an unchanged pin never does.
 */
export function classifyEventBump(prev: EventBumpSide, next: EventBumpSide): BumpDecision {
  const c: Ctx = { prev, next, major: [], minor: [] };
  compareOperations(c);
  compareChannels(c);
  compareMessages(c);
  compareTraits(c);
  compareExternalRefs(c);
  // Like a message's contentType, the document default decides how every message without its own is decoded (R78).
  if ((prev.doc.defaultContentType ?? "") !== (next.doc.defaultContentType ?? "")) {
    c.major.push(`defaultContentType changed from "${prev.doc.defaultContentType ?? "(none)"}" to "${next.doc.defaultContentType ?? "(none)"}"`);
  }
  compareShell(c);
  return decide(c.major, c.minor);
}
