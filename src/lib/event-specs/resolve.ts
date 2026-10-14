import { ok, err, type Result } from "@/types/result";
import type {
  EventSpecDocument,
  ResolvedChannel,
  ResolvedEventSpec,
  ResolvedMessage,
  ResolvedOperation,
  ResolvedTrait,
  TraitKind,
} from "./types";
import { jsonPointer } from "./json-pointer";

/**
 * Spec §7.2 step 2 (pure part): map a stored `EventSpecDocument` (IDs) plus an
 * in-memory catalog snapshot onto the assembler's `ResolvedEventSpec`.
 *
 * Mapping:
 * - info + options.version → info (version = `MAJOR.MINOR`)
 * - defaultContentType, servers, components → copied
 * - operations[].channelId → operations[].channelRef (+ channels[])
 * - operations[].messageVersionIds → operations[].messageRefs (+ messages[])
 * - operations[].traitIds → operations[].traitRefs (+ traits[], kind OPERATION)
 * - operations[].reply.{channelId, messageVersionIds} → reply.{channelRef, messageRefs}
 * - catalog message.traitRefs → traits[] (kind MESSAGE)
 *
 * Only referenced catalog items are carried over, in first-reference order.
 * Every unresolved reference is reported together (spec §10).
 */

export type EventSpecCatalog = {
  channels: ResolvedChannel[];
  messages: ResolvedMessage[];
  traits: ResolvedTrait[];
};

export type ResolveOptions = { productSlug: string; version: string };

export type ResolveProblem = { pointer: string; message: string };

export function resolveEventSpecDocument(
  doc: EventSpecDocument,
  catalog: EventSpecCatalog,
  options: ResolveOptions,
): Result<ResolvedEventSpec> {
  const channelsById = new Map(catalog.channels.map((c) => [c.id, c]));
  const messagesById = new Map(catalog.messages.map((m) => [m.id, m]));
  const traitsById = new Map(catalog.traits.map((t) => [t.id, t]));

  const problems: ResolveProblem[] = [];
  const channels = new Map<string, ResolvedChannel>();
  const messages = new Map<string, ResolvedMessage>();
  const traits = new Map<string, ResolvedTrait>();

  const takeChannel = (id: string, pointer: string) => {
    const channel = channelsById.get(id);
    if (!channel) problems.push({ pointer, message: `Channel "${id}" not found` });
    else if (!channels.has(id)) channels.set(id, channel);
  };
  const takeTrait = (id: string, kind: TraitKind, pointer: string, context = "") => {
    const trait = traitsById.get(id);
    if (!trait) problems.push({ pointer, message: `${context}Trait "${id}" not found` });
    else if (trait.kind !== kind) {
      problems.push({ pointer, message: `${context}Trait "${id}" is a ${trait.kind} trait, expected ${kind}` });
    } else if (!traits.has(id)) traits.set(id, trait);
  };
  const takeMessage = (id: string, pointer: string) => {
    const message = messagesById.get(id);
    if (!message) {
      problems.push({ pointer, message: `Message version "${id}" not found` });
      return;
    }
    if (messages.has(id)) return;
    messages.set(id, message);
    for (const traitId of message.traitRefs) takeTrait(traitId, "MESSAGE", pointer, `Message version "${id}": `);
  };

  const operations: ResolvedOperation[] = doc.operations.map((op, index) => {
    const base = jsonPointer("operations", index);
    takeChannel(op.channelId, `${base}/channelId`);
    op.messageVersionIds.forEach((id, i) => takeMessage(id, `${base}/messageVersionIds/${i}`));
    op.traitIds.forEach((id, i) => takeTrait(id, "OPERATION", `${base}/traitIds/${i}`));
    if (op.reply?.channelId) takeChannel(op.reply.channelId, `${base}/reply/channelId`);
    op.reply?.messageVersionIds?.forEach((id, i) => takeMessage(id, `${base}/reply/messageVersionIds/${i}`));

    const resolved: ResolvedOperation = {
      key: op.key,
      action: op.action,
      channelRef: op.channelId,
      messageRefs: [...op.messageVersionIds],
      traitRefs: [...op.traitIds],
    };
    if (op.summary !== undefined) resolved.summary = op.summary;
    if (op.description !== undefined) resolved.description = op.description;
    if (op.bindings !== undefined) resolved.bindings = structuredClone(op.bindings);
    if (op.reply) {
      resolved.reply = {};
      if (op.reply.channelId !== undefined) resolved.reply.channelRef = op.reply.channelId;
      if (op.reply.messageVersionIds !== undefined) resolved.reply.messageRefs = [...op.reply.messageVersionIds];
    }
    return resolved;
  });

  if (problems.length > 0) {
    return err({
      code: "UNRESOLVED_REFERENCES",
      message: `${problems.length} reference(s) in the event spec could not be resolved`,
      details: { problems },
    });
  }

  const spec: ResolvedEventSpec = {
    productSlug: options.productSlug,
    info: { ...structuredClone(doc.info), version: options.version },
    servers: structuredClone(doc.servers),
    operations,
    channels: [...channels.values()],
    messages: [...messages.values()],
    traits: [...traits.values()],
    components: structuredClone(doc.components ?? {}),
  };
  if (doc.defaultContentType !== undefined) spec.defaultContentType = doc.defaultContentType;
  return ok(spec);
}
