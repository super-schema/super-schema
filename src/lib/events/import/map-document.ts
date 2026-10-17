// src/lib/events/import/map-document.ts
// An AsyncAPI 3.0 document → an event document: the INVERSE of the assembler (`src/lib/event-specs/assemble.ts`). Pure — client-safe.
//
// What the event document stores BY KEY (messages, traits, security schemes, channels, servers, operations) keeps the key the file gives it
// (`components.messages.X` is message `X`); what it stores INLINE (schemas excepted, those become entities) is read with every `$ref`
// replaced by its target. Everything is read with the document's own readers (`sanitize.ts`), so the result always parses: what the model
// rejects is removed and reported, never copied through, and a document that still cannot be made valid fails with the parser's problems.
import { err, ok, type Result, type ServiceError } from "@/types/result";
import { jsonPointer } from "@/lib/event-specs/json-pointer";
import { setOwn } from "@/lib/event-specs/own-property";
import type { EventSpecInfo, JsonObject, TraitKind } from "@/lib/event-specs/types";
import { slugKey } from "@/lib/events/document/keys";
import type { Reader } from "@/lib/events/document/parse-objects";
import { parseEventDocument } from "@/lib/events/document/parse";
import {
  SECURITY_SCHEME_TYPES,
  type DocChannel, type DocChannelParameter, type DocComponents, type DocOperation, type DocSecurityScheme, type DocServer, type DocTrait,
  type EventDocument,
} from "@/lib/events/document/types";
import { ANY_PROPERTIES, propertiesSet } from "@/lib/events/document/wording";
import type { EntityPin } from "@/lib/events/types";
import { boundChain, boundPointer, boundText, CHAIN_ENTRY_LENGTH, createWarningSink, MAX_CHAIN_ENTRIES } from "./bound";
import { detectBuiltInTrait } from "./builtin-traits";
import { assignKeys, suggestTraitKey, uniqueIn, type KeyRequest } from "./keys";
import { entriesOf, indexMessages, isBag, type IndexedMessage, type MessageIndex } from "./message-index";
import { describeMessageSchemas, type PayloadDescription } from "./payloads";
import { createRefResolver, isRef, refTargetPointer, refTargetSegments } from "./refs";
import { createSanitizer } from "./sanitize";
import { assertDocumentBounds } from "./source";
import type { ImportWarning, ImportWarningCode, MapContext, RawAsyncApi3 } from "./types";

const ROOT_KEYS = new Set(["asyncapi", "info", "servers", "defaultContentType", "channels", "operations", "components"]);
const INFO_KEYS = new Set(["title", "version", "description", "termsOfService", "contact", "license", "tags", "externalDocs"]);
const SERVER_KEYS = new Set(["host", "protocol", "protocolVersion", "pathname", "title", "summary", "description", "variables", "security", "tags", "externalDocs", "bindings"]);
const CHANNEL_KEYS = new Set(["address", "messages", "title", "summary", "description", "servers", "parameters", "tags", "externalDocs", "bindings"]);
const MESSAGE_KEYS = new Set(["headers", "payload", "correlationId", "contentType", "name", "title", "summary", "description", "tags", "externalDocs", "bindings", "examples", "traits", "deprecated"]);
const OPERATION_KEYS = new Set(["action", "channel", "title", "summary", "description", "security", "tags", "externalDocs", "bindings", "traits", "messages", "reply"]);
const REPLY_KEYS = new Set(["address", "channel", "messages"]);
/** The components sections the event document keeps (by key). */
const KEPT_COMPONENTS = ["messages", "messageTraits", "operationTraits", "parameters", "correlationIds", "securitySchemes"] as const;
/** The components sections the document has no place for: they are read wherever something refers to them (inlined) and reported when nothing does. */
const INLINED_COMPONENTS = [
  "schemas", "servers", "channels", "operations", "replies", "replyAddresses", "serverVariables", "tags", "externalDocs",
  "serverBindings", "channelBindings", "operationBindings", "messageBindings",
] as const;
const COMPONENT_KEYS = new Set<string>([...KEPT_COMPONENTS, ...INLINED_COMPONENTS]);

/** What the bindings and the assembler's protocol rules call a protocol, for the secure and alternative spellings of a server's. */
const PROTOCOL_ALIASES: Readonly<Record<string, string>> = {
  "kafka-secure": "kafka", mqtts: "mqtt", "secure-mqtt": "mqtt", amqps: "amqp", https: "http", wss: "ws", websocket: "ws", websockets: "ws",
};
const DEFAULT_CHANNEL_PROTOCOL = "kafka";
/** Most of the parser's problems an error carries in its details (the message names the first and counts the rest). */
const MAX_PROBLEMS = 20;
const channelProtocolName = (protocol: string): string => {
  const name = protocol.trim().toLowerCase();
  return Object.hasOwn(PROTOCOL_ALIASES, name) ? PROTOCOL_ALIASES[name] : name;
};

const compactList = <T>(list: T[]): T[] | undefined => (list.length > 0 ? list : undefined);
const nonEmptyRecord = <T extends object>(record: T): T | undefined => (Object.keys(record).length > 0 ? record : undefined);

/** Thrown inside the mapper to leave early with a `ServiceError`; never escapes `mapAsyncApiToEventDocument`. */
class Stop extends Error {
  constructor(readonly error: ServiceError) {
    super(error.message);
  }
}
const must = <T>(result: Result<T>): T => {
  if (!result.success) throw new Stop(result.error);
  return result.data;
};

interface TraitDef { key: string; kind: TraitKind; pointer: string; node: Record<string, unknown> }

/**
 * AsyncAPI 3.0 → event document + what had to change. `ctx.payloadPins` holds the entity pin of every message payload / headers schema
 * (`extractPayloads` lists them, the persisting step creates the entities); a message without a payload pin is an error, headers without
 * one are left out with a warning. Never throws.
 */
export function mapAsyncApiToEventDocument(raw: RawAsyncApi3, ctx: MapContext): Result<{ document: EventDocument; warnings: ImportWarning[] }> {
  try {
    return mapDocument(raw, ctx);
  } catch (e) {
    if (e instanceof Stop) return err(e.error);
    return err({ code: "IMPORT_FAILED", message: "The AsyncAPI document could not be processed; it is probably too large or too deeply nested.", details: { reason: boundText(e instanceof Error ? e.message : e, 200) } });
  }
}

function mapDocument(raw: RawAsyncApi3, ctx: MapContext): Result<{ document: EventDocument; warnings: ImportWarning[] }> {
  const bounds = assertDocumentBounds(raw); // the caller normally parsed the text with `parseAsyncApiSource`; an object handed over directly is checked here
  if (!bounds.success) return bounds;
  // Everything document-controlled that goes into a message is bounded (`bound.ts`), and so is the number of warnings kept.
  const sink = createWarningSink();
  const warn = (pointer: string, code: ImportWarningCode, message: string): void => { sink.add({ pointer, code, message }); };

  const refs = createRefResolver(raw);
  // a recursive SCHEMA is reported per payload (`describeMessageSchemas`); a loop anywhere else fails when the part that holds it is read
  const checked = refs.check({ tolerateCycles: true });
  if (!checked.success) return err(checked.error);
  const inline = (value: unknown, at: string): unknown => must(refs.inline(value, at));
  const { ax, read, readEach } = createSanitizer(sink.add);

  const at = (base: string, key: string): string => `${base}${jsonPointer(key)}`;
  /** `node[key]`, refs inlined, read with `reader`; anything the document would reject is removed and reported. */
  const field = <T>(node: Record<string, unknown>, key: string, base: string, reader: Reader<T>): T | undefined => {
    if (!Object.hasOwn(node, key)) return undefined;
    const pointer = at(base, key);
    return read(reader, inline(node[key], pointer), pointer);
  };
  const listField = <T>(node: Record<string, unknown>, key: string, base: string, item: Reader<T>): T[] | undefined => {
    if (!Object.hasOwn(node, key)) return undefined;
    const pointer = at(base, key);
    return readEach(item, inline(node[key], pointer), pointer);
  };
  const noteUnknown = (node: Record<string, unknown>, known: ReadonlySet<string>, base: string, what: string): void => {
    for (const key of Object.keys(node)) {
      if (known.has(key)) continue;
      if (key.startsWith("x-")) warn(at(base, key), "UNSUPPORTED_EXTENSION", `The extension "${boundText(key)}" on ${what} has no place in an event, so it was not imported`);
      else warn(at(base, key), "DROPPED_CONSTRUCT", `"${boundText(key)}" is not a property of ${what}, so it was not imported`);
    }
  };
  /** The entry of a map (a server, a channel, an operation, …): a `$ref` to a component is followed. Not an object = left out. */
  const definitions = (value: unknown, base: string, what: string): Array<{ sourceKey: string; pointer: string; node: Record<string, unknown> }> => {
    const out: Array<{ sourceKey: string; pointer: string; node: Record<string, unknown> }> = [];
    for (const [sourceKey, entry] of entriesOf(value)) {
      const target = must(refs.deref(entry, at(base, sourceKey)));
      if (!isBag(target.value)) {
        warn(at(base, sourceKey), "SANITIZED_VALUE", `${what} "${boundText(sourceKey)}" is not an object, so it was left out of the import`);
        continue;
      }
      out.push({ sourceKey, pointer: target.pointer, node: target.value });
    }
    return out;
  };

  const components = isBag(raw.components) ? raw.components : {};
  noteUnknown(raw, ROOT_KEYS, "", "an AsyncAPI document");
  noteUnknown(components, COMPONENT_KEYS, "/components", "components");
  for (const key of ["servers", "channels", "operations", "components"] as const) {
    if (raw[key] !== undefined && raw[key] !== null && !isBag(raw[key])) warn(`/${key}`, "SANITIZED_VALUE", `${key} must be an object, so it was left out of the import`);
  }

  // ── info ──
  const rawInfo = isBag(raw.info) ? raw.info : {};
  noteUnknown(rawInfo, INFO_KEYS, "/info", "info"); // `info.version` is not read: the app assigns versions at publish
  const info = Object.fromEntries(Object.entries({
    title: field(rawInfo, "title", "/info", ax.str) ?? "",
    description: field(rawInfo, "description", "/info", ax.str),
    termsOfService: field(rawInfo, "termsOfService", "/info", ax.url),
    contact: field(rawInfo, "contact", "/info", ax.contact),
    license: field(rawInfo, "license", "/info", ax.license),
    tags: listField(rawInfo, "tags", "/info", ax.tag),
    externalDocs: field(rawInfo, "externalDocs", "/info", ax.externalDocs),
  }).filter(([, value]) => value !== undefined)) as EventSpecInfo;

  // ── security schemes (by key; also the ones written in place under `security`) ──
  const schemes: Record<string, DocSecurityScheme> = {};
  const schemeKeyOf = new Map<string, string>(); // key in the file → document key
  const takenSchemeKeys = new Set<string>();
  const schemeKeyByContent = new Map<string, string>();

  const readScheme = (node: unknown, pointer: string, label: string): DocSecurityScheme | undefined => {
    if (!isBag(node)) {
      warn(pointer, "DROPPED_CONSTRUCT", `The security scheme ${label} is not an object, so it was not imported`);
      return undefined;
    }
    if (!SECURITY_SCHEME_TYPES.some((type) => type === node.type)) {
      warn(pointer, "DROPPED_CONSTRUCT", `The security scheme ${label} has the type ${boundText(typeof node.type === "string" ? `"${node.type}"` : node.type)}, which events do not support, so it was not imported`);
      return undefined;
    }
    const scheme = read(ax.securityScheme, node, pointer);
    if (!scheme) warn(pointer, "DROPPED_CONSTRUCT", `The security scheme ${label} is not valid, so it was not imported`);
    return scheme;
  };

  const validSchemes: Array<{ sourceKey: string; pointer: string; scheme: DocSecurityScheme }> = [];
  for (const [sourceKey, value] of entriesOf(components.securitySchemes)) {
    const pointer = jsonPointer("components", "securitySchemes", sourceKey);
    const scheme = readScheme(inline(value, pointer), pointer, `"${boundText(sourceKey)}"`);
    if (scheme) validSchemes.push({ sourceKey, pointer, scheme });
  }
  const assignedSchemeKeys = assignKeys(validSchemes.map((s): KeyRequest => ({ id: s.sourceKey, key: s.sourceKey, pointer: s.pointer })), takenSchemeKeys, "security scheme", sink.add);
  for (const { sourceKey, scheme } of validSchemes) {
    const key = assignedSchemeKeys.get(sourceKey) as string;
    schemeKeyOf.set(sourceKey, key);
    setOwn(schemes, key, scheme);
  }

  /** `security: [{ $ref: '#/components/securitySchemes/X' }]` → the keys of the schemes that were imported. */
  const securityKeys = (value: unknown, base: string): string[] | undefined => {
    if (value === undefined || value === null) return undefined;
    if (!Array.isArray(value)) {
      warn(base, "SANITIZED_VALUE", "security must be a list, so it was left out of the import");
      return undefined;
    }
    const out: string[] = [];
    const listed = new Set<string>(); // a list can name thousands of schemes: a Set, never `includes` on the growing list
    const add = (key: string): void => { if (!listed.has(key)) { listed.add(key); out.push(key); } };
    value.forEach((entry, i) => {
      const entryAt = `${base}/${i}`;
      const segments = refTargetSegments(entry);
      if (segments && segments.length === 3 && segments[0] === "components" && segments[1] === "securitySchemes") {
        const key = schemeKeyOf.get(segments[2]);
        if (key) add(key);
        else warn(entryAt, "DROPPED_CONSTRUCT", `The reference to the security scheme "${boundText(segments[2])}" was left out: that scheme was not imported`);
        return;
      }
      // a scheme written in place (or a reference to somewhere else): store it as a component so it can be referenced by key
      const scheme = readScheme(inline(entry, entryAt), entryAt, "written here");
      if (!scheme) return;
      const content = JSON.stringify(scheme);
      let key = schemeKeyByContent.get(content);
      if (key === undefined) {
        key = uniqueIn(slugKey(String(scheme.type)), takenSchemeKeys);
        takenSchemeKeys.add(key);
        setOwn(schemes, key, scheme);
        schemeKeyByContent.set(content, key);
        warn(entryAt, "KEY_ADJUSTED", `The security scheme written here was stored as securitySchemes."${key}" so it can be referenced by key`);
      }
      add(key);
    });
    return compactList(out);
  };

  // ── message traits and operation traits: one key space for both kinds ──
  const traitDefs: TraitDef[] = [];
  const traitByPointer = new Map<string, TraitDef>();
  const takenTraitKeys = new Set<string>();
  const inlineTraitByContent = new Map<string, TraitDef>();
  const traitRequests: KeyRequest[] = [];
  for (const [kind, section] of [["MESSAGE", "messageTraits"], ["OPERATION", "operationTraits"]] as const) {
    const entries = entriesOf(components[section]);
    // an alias (`X: { $ref: '#/components/messageTraits/Y' }`) is read after the entries that hold a trait themselves, so `Y` keeps the key `Y`
    for (const [sourceKey, value] of [...entries.filter(([, v]) => !isRef(v)), ...entries.filter(([, v]) => isRef(v))]) {
      const pointer = jsonPointer("components", section, sourceKey);
      const target = must(refs.deref(value, pointer));
      let def = traitByPointer.get(target.pointer);
      if (!def) {
        if (!isBag(target.value)) {
          warn(pointer, "SANITIZED_VALUE", `The ${propertiesSet(kind)} "${boundText(sourceKey)}" is not an object, so it was left out of the import`);
          continue;
        }
        def = { key: "", kind, pointer: target.pointer, node: target.value };
        traitByPointer.set(target.pointer, def);
        traitDefs.push(def);
        traitRequests.push({ id: target.pointer, key: sourceKey, pointer });
      }
      traitByPointer.set(pointer, def);
    }
  }
  const assignedTraitKeys = assignKeys(traitRequests, takenTraitKeys, ANY_PROPERTIES, sink.add);
  for (const def of traitDefs) def.key = assignedTraitKeys.get(def.pointer) as string;

  /** Properties written in place in a `traits` list get a generated key (from their name or title); equal ones share it. */
  const inlineTrait = (kind: TraitKind, node: Record<string, unknown>, pointer: string): TraitDef => {
    const content = `${kind}:${JSON.stringify(node)}`;
    const known = inlineTraitByContent.get(content);
    if (known) return known;
    const key = suggestTraitKey(node, takenTraitKeys);
    takenTraitKeys.add(key);
    const def: TraitDef = { key, kind, pointer, node };
    traitDefs.push(def);
    inlineTraitByContent.set(content, def);
    return def;
  };
  /** A `traits` list → the keys of those traits (kind-checked, deduplicated). */
  const traitKeysOf = (value: unknown, base: string, kind: TraitKind): string[] => {
    if (value === undefined || value === null) return [];
    if (!Array.isArray(value)) {
      warn(base, "SANITIZED_VALUE", "traits must be a list, so it was left out of the import");
      return [];
    }
    const out: string[] = [];
    const listed = new Set<string>();
    value.forEach((entry, i) => {
      const entryAt = `${base}/${i}`;
      let def: TraitDef | undefined;
      if (isRef(entry)) {
        const target = must(refs.deref(entry, entryAt));
        const named = refTargetPointer(entry);
        def = (named === null ? undefined : traitByPointer.get(named)) ?? traitByPointer.get(target.pointer);
        if (!def && isBag(target.value)) def = inlineTrait(kind, target.value, target.pointer);
      } else if (isBag(entry)) def = inlineTrait(kind, entry, entryAt);
      if (!def) {
        warn(entryAt, "SANITIZED_VALUE", `Each entry of a traits list must be a reference or an object, so this one was left out of the import`);
        return;
      }
      if (def.kind !== kind) {
        warn(entryAt, "DROPPED_CONSTRUCT", `"${def.key}" is a ${propertiesSet(def.kind)}, not a ${propertiesSet(kind)}, so it was left out here`);
        return;
      }
      if (!listed.has(def.key)) { listed.add(def.key); out.push(def.key); }
    });
    return out;
  };
  const buildTrait = (def: TraitDef): DocTrait => {
    const node: Record<string, unknown> = { ...(inline(def.node, def.pointer) as Record<string, unknown>) };
    if (def.kind === "OPERATION" && Object.hasOwn(def.node, "security")) {
      const keys = securityKeys(def.node.security, at(def.pointer, "security"));
      if (keys) node.security = keys;
      else delete node.security;
    }
    const spec = read(ax.traitSpec(def.kind), node, def.pointer) ?? {};
    const match = def.kind === "MESSAGE" ? detectBuiltInTrait(spec) : null;
    const libraryTraitId = match?.kind === "cloudEvents" ? ctx.builtInTraitIds.cloudEvents : match?.kind === "traceContext" ? ctx.builtInTraitIds.traceContext : undefined;
    if (match && libraryTraitId) {
      const dropped = Object.keys(spec).filter((key) => key !== "headers");
      const lost = dropped.length > 0 ? `; its own ${boundChain(dropped, MAX_CHAIN_ENTRIES, 40, ", ")} ${dropped.length === 1 ? "was" : "were"} not kept` : "";
      warn(def.pointer, "BUILTIN_TRAIT_MAPPED", `The ${propertiesSet("MESSAGE")} "${def.key}" match the built-in "${match.name}" and were replaced by it${lost}`);
      return { key: def.key, kind: "MESSAGE", libraryTraitId };
    }
    return { key: def.key, kind: def.kind, spec: spec as JsonObject };
  };

  // ── servers ──
  const serverDefs = definitions(raw.servers, "/servers", "The server");
  const assignedServerKeys = assignKeys(serverDefs.map((d): KeyRequest => ({ id: d.sourceKey, key: d.sourceKey, pointer: jsonPointer("servers", d.sourceKey) })), new Set(), "server", sink.add);
  const serverKeyOf = new Map<string, string>();
  const protocolOfServer = new Map<string, string>(); // by document key
  const servers: DocServer[] = [];
  const sources = { servers: [] as string[], channels: [] as string[], messages: [] as string[], traits: [] as string[], operations: [] as string[] };
  for (const def of serverDefs) {
    const key = assignedServerKeys.get(def.sourceKey) as string;
    serverKeyOf.set(def.sourceKey, key);
    const { node, pointer } = def;
    noteUnknown(node, SERVER_KEYS, pointer, "a server");
    const host = field(node, "host", pointer, ax.str) ?? "";
    let pathname = field(node, "pathname", pointer, ax.str);
    if (pathname !== undefined && !pathname.startsWith("/")) {
      pathname = `/${pathname}`;
      warn(at(pointer, "pathname"), "SANITIZED_VALUE", `A pathname must start with "/", so "${boundText(pathname)}" is imported`);
    }
    let variables = field(node, "variables", pointer, ax.variables);
    if (variables) {
      const used = new Set([...`${host}${pathname ?? ""}`.matchAll(/\{([^{}]+)\}/g)].map((m) => m[1]));
      const kept: Record<string, NonNullable<typeof variables>[string]> = {};
      for (const [name, variable] of Object.entries(variables)) {
        if (used.has(name)) setOwn(kept, name, variable);
        else warn(at(at(pointer, "variables"), name), "SANITIZED_VALUE", `The variable "${boundText(name)}" does not appear as {${boundText(name)}} in the host or the pathname, so it was left out of the import`);
      }
      variables = nonEmptyRecord(kept);
    }
    servers.push({
      key, host, protocol: field(node, "protocol", pointer, ax.str) ?? "", pathname,
      protocolVersion: field(node, "protocolVersion", pointer, ax.str), description: field(node, "description", pointer, ax.str),
      title: field(node, "title", pointer, ax.str), summary: field(node, "summary", pointer, ax.str), variables,
      security: securityKeys(node.security, at(pointer, "security")), tags: listField(node, "tags", pointer, ax.tag),
      externalDocs: field(node, "externalDocs", pointer, ax.externalDocs), bindings: field(node, "bindings", pointer, ax.jsonObject),
    });
    protocolOfServer.set(key, servers[servers.length - 1].protocol);
    sources.servers.push(pointer);
  }

  // ── channels ──
  const messageIndex: MessageIndex = must(indexMessages(raw, refs));
  for (const warning of messageIndex.warnings) sink.add(warning);
  // the protocols the document's servers use, worked out once (every channel that names no server needs them)
  let protocolsOfDocument: string[] | undefined;
  const documentProtocols = (): string[] => (protocolsOfDocument ??= [...new Set(servers.map((server) => channelProtocolName(server.protocol)))]);
  const channelDefs = definitions(raw.channels, "/channels", "The channel");
  const assignedChannelKeys = assignKeys(channelDefs.map((d): KeyRequest => ({ id: d.sourceKey, key: d.sourceKey, pointer: jsonPointer("channels", d.sourceKey) })), new Set(), "channel", sink.add);
  const channelKeyOf = new Map<string, string>();
  const channelMessageKeys = new Map<string, Set<string>>();
  const channels: DocChannel[] = [];
  for (const def of channelDefs) {
    const key = assignedChannelKeys.get(def.sourceKey) as string;
    channelKeyOf.set(def.sourceKey, key);
    const { node, pointer } = def;
    noteUnknown(node, CHANNEL_KEYS, pointer, "a channel");

    let address: string | null = null;
    if (node.address !== undefined && node.address !== null) {
      if (typeof node.address === "string") address = node.address;
      else warn(at(pointer, "address"), "SANITIZED_VALUE", "address must be a string or null, so it was left out of the import");
    }
    const serverKeys: string[] = [];
    const listedServers = new Set<string>();
    const serverProtocols: string[] = [];
    if (Array.isArray(node.servers)) {
      node.servers.forEach((entry, i) => {
        const segments = refTargetSegments(entry);
        const serverKey = segments && segments.length === 2 && segments[0] === "servers" ? serverKeyOf.get(segments[1]) : undefined;
        if (serverKey === undefined) {
          warn(`${at(pointer, "servers")}/${i}`, "DROPPED_CONSTRUCT", "A channel's servers must be references to #/servers/…; this one was left out of the import");
          return;
        }
        if (!listedServers.has(serverKey)) {
          listedServers.add(serverKey);
          serverKeys.push(serverKey);
        }
        serverProtocols.push(protocolOfServer.get(serverKey) ?? "");
      });
    } else if (node.servers !== undefined && node.servers !== null) {
      warn(at(pointer, "servers"), "SANITIZED_VALUE", "servers must be a list, so it was left out of the import");
    }

    const bindings = field(node, "bindings", pointer, ax.jsonObject);
    // A document channel has no protocol; the event document needs one. Evidence, best first: the channel's own servers, its bindings, the
    // document's servers. A guess (several protocols to choose from, or nothing at all) is reported so the user checks it.
    const channelServerProtocols = serverProtocols.filter((p) => p !== "");
    const distinct = (list: string[]): string[] => [...new Set(list.map(channelProtocolName))];
    const bindingProtocol = Object.keys(bindings ?? {})[0];
    let protocolSource: string;
    if (channelServerProtocols.length > 0) {
      protocolSource = channelServerProtocols[0];
      const different = distinct(channelServerProtocols);
      if (different.length > 1) warn(pointer, "SANITIZED_VALUE", `This channel is on servers with different protocols (${boundChain(different, MAX_CHAIN_ENTRIES, 40, ", ")}) but an event channel has one; "${boundText(different[0], 40)}" was used. Check the channel's protocol.`);
    } else if (bindingProtocol !== undefined) {
      protocolSource = bindingProtocol;
    } else if (servers.length > 0) {
      protocolSource = servers[0].protocol;
      const different = documentProtocols();
      if (different.length > 1) warn(pointer, "SANITIZED_VALUE", `This channel names no server and the document's servers use different protocols (${boundChain(different, MAX_CHAIN_ENTRIES, 40, ", ")}); the first server's, "${boundText(different[0], 40)}", was assumed. Check the channel's protocol.`);
    } else {
      protocolSource = DEFAULT_CHANNEL_PROTOCOL;
      warn(pointer, "SANITIZED_VALUE", `Nothing in the document tells the protocol of this channel (it names no server and has no bindings); "${DEFAULT_CHANNEL_PROTOCOL}" was assumed. Check the channel's protocol.`);
    }

    let parameters = field(node, "parameters", pointer, ax.parameters);
    if (address !== null) {
      const missing = new Set<string>();
      for (const match of address.matchAll(/\{([^{}]*)\}/g)) {
        const name = match[1].trim();
        if (name !== "" && !(parameters && Object.hasOwn(parameters, name))) missing.add(name);
      }
      if (missing.size > 0) {
        parameters = { ...(parameters ?? {}) }; // one copy, not one per missing name
        for (const name of missing) {
          setOwn(parameters, name, {} as DocChannelParameter);
          warn(at(pointer, "parameters"), "SANITIZED_VALUE", `The address uses {${boundText(name)}} but defines no parameter for it, so an empty one was added`);
        }
      }
    }

    const channelMessages = new Set<string>(); // insertion-ordered and unique: a channel can hold tens of thousands of messages
    for (const message of messageIndex.channels.get(def.sourceKey)?.values() ?? []) channelMessages.add(message.key);
    const messageKeys = [...channelMessages];
    channelMessageKeys.set(key, channelMessages);

    channels.push({
      key, address, protocol: channelProtocolName(protocolSource), serverKeys, bindings,
      title: field(node, "title", pointer, ax.str), summary: field(node, "summary", pointer, ax.str), description: field(node, "description", pointer, ax.str),
      parameters, tags: listField(node, "tags", pointer, ax.tag), externalDocs: field(node, "externalDocs", pointer, ax.externalDocs), messageKeys,
    });
    sources.channels.push(pointer);
  }

  // ── messages ──
  const messages = messageIndex.messages.map((message) => {
    const { node, pointer, key } = message;
    noteUnknown(node, MESSAGE_KEYS, pointer, "a message");
    const schemas = must(describeMessageSchemas(refs, message));
    const noteSchema = (role: "payload" | "headers", description: PayloadDescription): void => {
      const place = at(pointer, role);
      if (description.recursive) {
        warn(place, "UNSUPPORTED_PAYLOAD_FORMAT", `The ${role} of "${key}" refers to itself (${boundChain(description.recursive, MAX_CHAIN_ENTRIES, CHAIN_ENTRY_LENGTH)}) and cannot be imported; an empty entity was created instead`);
      } else if (description.format === "unsupported") {
        const written = description.schemaFormat !== undefined ? `is written as ${boundText(description.schemaFormat)}` : "is not a schema object";
        warn(place, "UNSUPPORTED_PAYLOAD_FORMAT", `The ${role} of "${key}" ${written}, which events cannot import; an entity with no fields stands in for it, describe it there`);
      } else if (description.format === "none" && role === "payload") {
        warn(place, "NO_PAYLOAD", `"${key}" has no payload; a message needs one, so an entity with no fields stands in for it`);
      }
    };
    noteSchema("payload", schemas.payload);
    const payload: EntityPin | undefined = ctx.payloadPins.get(`${key}:payload`);
    if (!payload) {
      throw new Stop({
        code: "MISSING_PAYLOAD_PIN", message: `No entity was given for the payload of message "${key}" (${key}:payload); create the entities before mapping the document`,
        details: { pin: `${key}:payload`, pointer: boundPointer(at(pointer, "payload")) },
      });
    }
    let headers: EntityPin | undefined;
    if (schemas.headers && schemas.headers.format !== "none") {
      noteSchema("headers", schemas.headers);
      headers = ctx.payloadPins.get(`${key}:headers`);
      if (!headers) warn(at(pointer, "headers"), "DROPPED_CONSTRUCT", `No entity was given for the headers of "${key}", so they were left out of the import`);
    }
    sources.messages.push(pointer);
    return {
      key, name: field(node, "name", pointer, ax.str), title: field(node, "title", pointer, ax.str), summary: field(node, "summary", pointer, ax.str),
      description: field(node, "description", pointer, ax.str), contentType: field(node, "contentType", pointer, ax.str),
      correlationId: field(node, "correlationId", pointer, ax.correlationId), tags: listField(node, "tags", pointer, ax.tag),
      externalDocs: field(node, "externalDocs", pointer, ax.externalDocs), deprecated: field(node, "deprecated", pointer, ax.bool),
      bindings: field(node, "bindings", pointer, ax.jsonObject), examples: listField(node, "examples", pointer, ax.example),
      payload: { ...payload }, headers: headers ? { ...headers } : undefined, traitKeys: traitKeysOf(node.traits, at(pointer, "traits"), "MESSAGE"),
    };
  });

  // ── operations ──
  /** `{ $ref: '#/channels/X' }` → the channel's document key. */
  const channelRef = (value: unknown): { sourceKey: string; key: string } | undefined => {
    const segments = refTargetSegments(value);
    const key = segments && segments.length === 2 && segments[0] === "channels" ? channelKeyOf.get(segments[1]) : undefined;
    return segments && key !== undefined ? { sourceKey: segments[1], key } : undefined;
  };
  /** A list of message refs (`#/channels/C/messages/k`) → document keys of messages the channel allows. */
  const messageKeysOf = (value: unknown, base: string, channel: { sourceKey: string; key: string } | undefined): string[] => {
    if (value === undefined || value === null) return [];
    if (!Array.isArray(value)) {
      warn(base, "SANITIZED_VALUE", "messages must be a list, so it was left out of the import");
      return [];
    }
    const allowed = channel ? channelMessageKeys.get(channel.key) : undefined;
    const out: string[] = [];
    const listed = new Set<string>();
    value.forEach((entry, i) => {
      const entryAt = `${base}/${i}`;
      const segments = refTargetSegments(entry);
      let message: IndexedMessage | undefined;
      if (segments && segments.length === 4 && segments[0] === "channels" && segments[2] === "messages") {
        if (channel && segments[1] !== channel.sourceKey) {
          warn(entryAt, "DROPPED_CONSTRUCT", `This message belongs to channel "${boundText(segments[1])}", not to the channel of this operation, so it was left out of the import`);
          return;
        }
        message = messageIndex.channels.get(segments[1])?.get(segments[3]);
      } else if (segments && segments.length === 3 && segments[0] === "components" && segments[1] === "messages") {
        message = messageIndex.byComponentKey.get(segments[2]);
      }
      if (!message || (allowed && !allowed.has(message.key))) {
        warn(entryAt, "DROPPED_CONSTRUCT", "This does not point at a message of the operation's channel, so it was left out of the import");
        return;
      }
      if (!listed.has(message.key)) { listed.add(message.key); out.push(message.key); }
    });
    return out;
  };

  const operationDefs = definitions(raw.operations, "/operations", "The operation");
  const assignedOperationKeys = assignKeys(operationDefs.map((d): KeyRequest => ({ id: d.sourceKey, key: d.sourceKey, pointer: jsonPointer("operations", d.sourceKey) })), new Set(), "operation", sink.add);
  const operations: DocOperation[] = [];
  for (const def of operationDefs) {
    const { node, pointer } = def;
    noteUnknown(node, OPERATION_KEYS, pointer, "an operation");
    const channel = channelRef(node.channel);
    if (!channel) {
      throw new Stop({
        code: "VALIDATION_ERROR", message: `The operation "${boundText(def.sourceKey)}" does not name a channel of this document (${boundText(at(pointer, "channel"), 200)} must be a reference like #/channels/…)`,
        details: { pointer: boundPointer(at(pointer, "channel")) },
      });
    }
    let reply: DocOperation["reply"];
    if (node.reply !== undefined && node.reply !== null) {
      const target = must(refs.deref(node.reply, at(pointer, "reply")));
      if (isBag(target.value)) {
        noteUnknown(target.value, REPLY_KEYS, target.pointer, "a reply");
        const replyChannel = target.value.channel === undefined ? undefined : channelRef(target.value.channel);
        if (target.value.channel !== undefined && !replyChannel) warn(at(target.pointer, "channel"), "DROPPED_CONSTRUCT", "The reply channel must be a reference like #/channels/…, so it was left out of the import");
        let replyMessages = messageKeysOf(target.value.messages, at(target.pointer, "messages"), replyChannel);
        if (replyMessages.length > 0 && !replyChannel) {
          warn(at(target.pointer, "messages"), "DROPPED_CONSTRUCT", "Reply messages need a reply channel, so they were left out of the import");
          replyMessages = [];
        }
        const built = {
          address: field(target.value, "address", target.pointer, ax.replyAddress), channelKey: replyChannel?.key,
          messageKeys: compactList(replyMessages),
        };
        const present = Object.fromEntries(Object.entries(built).filter(([, v]) => v !== undefined));
        if (Object.keys(present).length > 0) reply = present as DocOperation["reply"];
      } else warn(at(pointer, "reply"), "SANITIZED_VALUE", "A reply must be an object, so it was left out of the import");
    }
    operations.push({
      key: assignedOperationKeys.get(def.sourceKey) as string, action: node.action as DocOperation["action"], channelKey: channel.key,
      messageKeys: messageKeysOf(node.messages, at(pointer, "messages"), channel), traitKeys: traitKeysOf(node.traits, at(pointer, "traits"), "OPERATION"),
      title: field(node, "title", pointer, ax.str), summary: field(node, "summary", pointer, ax.str), description: field(node, "description", pointer, ax.str),
      security: securityKeys(node.security, at(pointer, "security")), tags: listField(node, "tags", pointer, ax.tag),
      externalDocs: field(node, "externalDocs", pointer, ax.externalDocs), bindings: field(node, "bindings", pointer, ax.jsonObject), reply,
    });
    sources.operations.push(pointer);
  }

  // ── traits (last: operations and messages may have added some written in place) ──
  const traits = traitDefs.map(buildTrait);
  for (const def of traitDefs) sources.traits.push(def.pointer);

  // ── the components the document keeps next to what refers to them ──
  const keptRecord = (section: "parameters" | "correlationIds", item: Reader<Record<string, unknown>>): Record<string, JsonObject> | undefined => {
    const out: Record<string, JsonObject> = {};
    for (const [key, value] of entriesOf(components[section])) {
      const pointer = jsonPointer("components", section, key);
      const read1 = read(item, inline(value, pointer), pointer);
      if (read1) setOwn(out, key, read1);
    }
    return nonEmptyRecord(out);
  };
  const documentComponents: DocComponents = {};
  const correlationIds = keptRecord("correlationIds", ax.correlationId as Reader<Record<string, unknown>>);
  const parameters = keptRecord("parameters", ax.parameter as Reader<Record<string, unknown>>);
  if (correlationIds) documentComponents.correlationIds = correlationIds;
  if (parameters) documentComponents.parameters = parameters;
  if (Object.keys(schemes).length > 0) documentComponents.securitySchemes = schemes;

  // A component the document has no place for is read where something refers to it. What nothing refers to (or only itself, or only other
  // unused components) is reported once per section.
  const inlinedEntry = (pointer: string): boolean => INLINED_COMPONENTS.some((section) => pointer.startsWith(`/components/${section}/`));
  const reached = new Set<string>();
  const pending: string[] = [];
  const reach = (target: string): void => {
    if (!inlinedEntry(target) || reached.has(target)) return;
    reached.add(target);
    pending.push(target);
  };
  for (const [owner, targets] of refs.edges) if (!inlinedEntry(owner)) for (const target of targets) reach(target);
  for (let owner = pending.pop(); owner !== undefined; owner = pending.pop()) for (const target of refs.edges.get(owner) ?? []) reach(target);
  for (const section of INLINED_COMPONENTS) {
    const unused = entriesOf(components[section]).map(([key]) => key).filter((key) => !reached.has(jsonPointer("components", section, key)));
    if (unused.length === 0) continue;
    const shown = boundChain(unused, MAX_CHAIN_ENTRIES, 40, ", ");
    warn(jsonPointer("components", section), "DROPPED_CONSTRUCT", `components.${section} has ${unused.length} ${unused.length === 1 ? "entry" : "entries"} that nothing refers to (${shown}), so ${unused.length === 1 ? "it was" : "they were"} not imported`);
  }

  // ── the document, and proof that it is one ──
  const candidate = {
    documentVersion: 2, info, defaultContentType: field(raw, "defaultContentType", "", ax.str),
    servers, channels, messages, traits, operations, externalRefs: [],
    ...(nonEmptyRecord(documentComponents) && { components: documentComponents }),
  };
  const parsed = parseEventDocument(candidate);
  if (!parsed.success) {
    const found = (parsed.error.details as { problems?: Array<{ pointer: string; message: string }> } | undefined)?.problems ?? [];
    // the parser's text can echo document text too: the first MAX_PROBLEMS problems are kept, each one bounded
    const problems = found.slice(0, MAX_PROBLEMS).map((problem) => {
      const m = /^\/(servers|channels|messages|traits|operations)\/(\d+)(\/.*)?$/.exec(problem.pointer);
      const base = m ? sources[m[1] as keyof typeof sources][Number(m[2])] : undefined;
      return {
        pointer: boundPointer(problem.pointer), message: boundText(problem.message, 300),
        sourcePointer: boundPointer(base !== undefined ? `${base}${m?.[3] ?? ""}` : problem.pointer),
      };
    });
    const first = problems[0];
    return err({
      code: "VALIDATION_ERROR",
      message: `The AsyncAPI document cannot become an event: ${first ? `${first.message} (at ${first.sourcePointer === "" ? "the document" : boundText(first.sourcePointer, 200)})` : "it is not valid"}${found.length > 1 ? `, and ${found.length - 1} more problem${found.length > 2 ? "s" : ""}` : ""}`,
      details: { problems, ...(found.length > problems.length && { omitted: found.length - problems.length }) },
      suggestedFix: "Fix the document and import it again.",
    });
  }
  // nothing in the result may be shared with the file the caller still holds
  return ok({ document: structuredClone(parsed.data), warnings: sink.finish() });
}
