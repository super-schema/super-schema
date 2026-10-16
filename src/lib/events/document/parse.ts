// src/lib/events/document/parse.ts
// One pure parser for the v2 event document — runs in the browser (inline validation) and on the server (save/publish).
import { err, ok, type Result } from "@/types/result";
import type { EntityPin } from "@/lib/events/types";
import type { EventSpecInfo, JsonObject, JsonSchemaDialect, OperationAction, PayloadFormat, TraitKind } from "@/lib/event-specs/types";
import { isReservedKey } from "@/lib/event-specs/own-property";
import {
  DOCUMENT_VERSION, KEY_MAX_LENGTH, KEY_PATTERN,
  type DocChannel, type DocComponents, type DocExternalRef, type DocMessage, type DocOperation, type DocServer, type DocTrait,
  type DocumentProblem, type EventDocument, type Origin,
} from "./types";
import { createObjectReaders, isBag, ptr, type Bad, type Bag } from "./parse-objects";

/** A parsed array item plus what the cross-reference pass needs to know about it. */
type Entry<T, X extends object = object> = { value: T; keyOk: boolean } & X;

const FORMATS: readonly PayloadFormat[] = ["avro", "json-schema", "protobuf"];
const DIALECTS: readonly JsonSchemaDialect[] = ["draft-07", "2020-12"];
const ACTIONS: readonly OperationAction[] = ["send", "receive"];
const TRAIT_KINDS: readonly TraitKind[] = ["MESSAGE", "OPERATION"];
// What the user calls a trait. The UI's words live in `features/events/builder/labels.ts`, which `src/lib` does not import, so they are
// repeated here; tests/unit/lib/events/document/parse-wording.test.ts fails if they drift. Problem text never says "trait".
const propertiesNoun = (kind: TraitKind): string => `${kind.toLowerCase()} properties`;
const ANY_PROPERTIES = "message or operation properties";
const REF_KINDS: readonly DocExternalRef["kind"][] = ["channel", "message"];
const oneOf = <T extends string>(list: readonly T[], v: unknown): T | undefined => list.find((x) => x === v);
const compact = <T extends object>(v: T): T => Object.fromEntries(Object.entries(v).filter(([, x]) => x !== undefined)) as T;
const hasOwn = (o: object, k: string) => Object.prototype.hasOwnProperty.call(o, k);

/** Field readers. Each one reports its own problems through `bad` and returns a safe fallback. */
function createReaders(bad: Bad) {
  /** An array element that must be an object. */
  const item = (v: unknown, pointer: string, label: string): Bag => {
    if (isBag(v)) return v;
    bad(pointer, `${label} must be an object`);
    return {};
  };
  const array = (src: Bag, key: string, pointer: string): unknown[] => {
    const v = src[key];
    if (v === undefined || v === null) return [];
    if (Array.isArray(v)) return v;
    bad(`${pointer}/${key}`, `${key} must be an array`);
    return [];
  };
  /** Optional trimmed string; blank = absent. */
  const opt = (src: Bag, key: string, pointer: string): string | undefined => {
    const v = src[key];
    if (v === undefined || v === null) return undefined;
    if (typeof v !== "string") { bad(`${pointer}/${key}`, `${key} must be a string`); return undefined; }
    const t = v.trim();
    return t === "" ? undefined : t;
  };
  const req = (src: Bag, key: string, pointer: string): string | undefined => {
    const v = src[key];
    if (typeof v !== "string" || v.trim() === "") { bad(`${pointer}/${key}`, `${key} is required`); return undefined; }
    return v.trim();
  };
  const obj = (src: Bag, key: string, pointer: string): JsonObject | undefined => {
    const v = src[key];
    if (v === undefined || v === null) return undefined;
    if (isBag(v)) return v as JsonObject;
    bad(`${pointer}/${key}`, `${key} must be an object`);
    return undefined;
  };
  const record = (src: Bag, key: string, pointer: string): Record<string, JsonObject> | undefined => {
    const v = src[key];
    if (v === undefined || v === null) return undefined;
    if (!isBag(v)) { bad(`${pointer}/${key}`, `${key} must be an object`); return undefined; }
    let allObjects = true;
    for (const [name, x] of Object.entries(v)) {
      if (!isBag(x)) { allObjects = false; bad(`${pointer}/${key}${ptr(name)}`, `${key} values must be objects`); }
    }
    return allObjects ? (Object.fromEntries(Object.entries(v)) as Record<string, JsonObject>) : undefined;
  };
  const list = (src: Bag, key: string, pointer: string): string[] => {
    const v = src[key];
    if (v === undefined || v === null) return [];
    if (!Array.isArray(v)) { bad(`${pointer}/${key}`, `${key} must be an array of keys`); return []; }
    const out: string[] = [];
    v.forEach((x, j) => {
      if (typeof x === "string" && x.trim() !== "") out.push(x.trim());
      else bad(`${pointer}/${key}/${j}`, `${key} entries must be non-empty strings`);
    });
    return out;
  };
  const pin = (src: Bag, key: string, pointer: string, required: boolean): EntityPin | undefined => {
    const at = `${pointer}/${key}`;
    const v = src[key];
    if (v === undefined || v === null) {
      if (required) bad(at, `${key} is required`);
      return undefined;
    }
    if (!isBag(v)) { bad(at, `${key} must be an object`); return undefined; }
    const entityId = typeof v.entityId === "string" ? v.entityId.trim() : "";
    if (!entityId) bad(`${at}/entityId`, "entityId is required");
    const version = v.entityVersionId;
    let entityVersionId: string | null = null;
    if (typeof version === "string" && version.trim() !== "") entityVersionId = version.trim();
    else if (version !== null) bad(`${at}/entityVersionId`, "entityVersionId must be a non-empty string, or null when not pinned yet");
    return { entityId, entityVersionId };
  };
  const origin = (src: Bag, pointer: string): Origin | undefined => {
    const v = src.origin;
    if (v === undefined || v === null) return undefined;
    if (!isBag(v)) { bad(`${pointer}/origin`, "origin must be an object"); return undefined; }
    const at = `${pointer}/origin`;
    const provider = req(v, "provider", at);
    const ref = req(v, "ref", at);
    const syncedAt = req(v, "syncedAt", at);
    return provider && ref && syncedAt ? { provider, ref, syncedAt } : undefined;
  };
  /** Local key: trimmed, `KEY_PATTERN`, ≤ `KEY_MAX_LENGTH`, never an `Object.prototype` name. `keyOk` = safe to use. */
  const docKey = (src: Bag, pointer: string): { key: string; keyOk: boolean } => {
    const at = `${pointer}/key`;
    const raw = src.key;
    if (typeof raw !== "string" || raw.trim() === "") { bad(at, "key is required"); return { key: "", keyOk: false }; }
    const key = raw.trim();
    if (key.length > KEY_MAX_LENGTH) bad(at, `Key must be at most ${KEY_MAX_LENGTH} characters`);
    else if (!KEY_PATTERN.test(key)) bad(at, `Key "${key}" may only contain letters, digits, ".", "_" and "-"`);
    else if (isReservedKey(key)) bad(at, `Key "${key}" is reserved — choose another key`);
    else return { key, keyOk: true };
    return { key, keyOk: false };
  };
  return { item, array, opt, req, obj, record, list, pin, origin, docKey };
}

export function parseEventDocument(value: unknown): Result<EventDocument> {
  const problems: DocumentProblem[] = [];
  const bad: Bad = (pointer, message) => { problems.push({ pointer, message }); };
  const fail = () => err({
    code: "VALIDATION_ERROR",
    message: `${problems.length} problem(s) in the event document`,
    details: { problems },
    suggestedFix: "Fix the highlighted fields and save again.",
  });
  if (!isBag(value)) {
    bad("", "Document must be an object");
    return fail();
  }
  const r = createReaders(bad);
  const ax = createObjectReaders(bad);
  /** An optional enum: null / undefined / blank = absent, anything else must be one of `list` (reported at `pointer`). */
  const optionalEnum = <T extends string>(list: readonly T[], raw: unknown, pointer: string, label: string): T | undefined => {
    if (raw === undefined || raw === null || (typeof raw === "string" && raw.trim() === "")) return undefined;
    const hit = typeof raw === "string" ? oneOf(list, raw.trim()) : undefined;
    if (!hit) bad(pointer, `${label} must be one of ${list.join(", ")}`);
    return hit;
  };
  if (value.documentVersion !== DOCUMENT_VERSION) bad("/documentVersion", `documentVersion must be ${DOCUMENT_VERSION}`);

  // ── info ──
  if (!isBag(value.info)) bad("/info", "info must be an object");
  const infoBag: Bag = isBag(value.info) ? value.info : {};
  const info: EventSpecInfo = compact<EventSpecInfo>({
    title: r.req(infoBag, "title", "/info") ?? "",
    description: r.opt(infoBag, "description", "/info"),
    termsOfService: ax.read(infoBag, "termsOfService", "/info", ax.url),
    contact: ax.read(infoBag, "contact", "/info", ax.contact),
    license: ax.read(infoBag, "license", "/info", ax.license),
    tags: ax.read(infoBag, "tags", "/info", ax.tags),
    externalDocs: ax.read(infoBag, "externalDocs", "/info", ax.externalDocs),
  });

  // ── per-item parsing ──
  const rawServers = r.array(value, "servers", "");
  const servers = rawServers.map((raw, i): Entry<DocServer> => {
    const p = `/servers/${i}`;
    const s = r.item(raw, p, "server");
    const { key, keyOk } = r.docKey(s, p);
    const protocol = r.req(s, "protocol", p) ?? "";
    const host = r.req(s, "host", p) ?? "";
    if (host && (/\s/.test(host) || host.includes("://"))) bad(`${p}/host`, "host must be host or host:port — no spaces and no scheme");
    const pathname = r.opt(s, "pathname", p);
    if (pathname !== undefined && !pathname.startsWith("/")) bad(`${p}/pathname`, 'pathname must start with "/"');
    const variables = ax.read(s, "variables", p, ax.variables);
    // Every variable must be substituted somewhere: as `{name}` in the host or the pathname.
    if (isBag(s.variables)) {
      const used = new Set([...`${host}${pathname ?? ""}`.matchAll(/\{([^{}]+)\}/g)].map((m) => m[1]));
      for (const name of Object.keys(s.variables)) {
        if (!used.has(name)) bad(`${p}/variables${ptr(name)}`, `Variable "${name}" does not appear as {${name}} in the host or the pathname`);
      }
    }
    return {
      keyOk,
      value: compact<DocServer>({
        key, protocol, host, pathname,
        protocolVersion: r.opt(s, "protocolVersion", p),
        description: r.opt(s, "description", p),
        externalRef: r.opt(s, "externalRef", p),
        origin: r.origin(s, p),
        title: r.opt(s, "title", p),
        summary: r.opt(s, "summary", p),
        variables,
        security: ax.read(s, "security", p, ax.strings()),
        tags: ax.read(s, "tags", p, ax.tags),
        externalDocs: ax.read(s, "externalDocs", p, ax.externalDocs),
        bindings: r.obj(s, "bindings", p),
      }),
    };
  });

  const channels = r.array(value, "channels", "").map((raw, i): Entry<DocChannel> => {
    const p = `/channels/${i}`;
    const c = r.item(raw, p, "channel");
    const { key, keyOk } = r.docKey(c, p);
    const protocol = r.req(c, "protocol", p) ?? "";
    // An explicit format is optional: absent = the channel follows its messages' representations.
    const format = optionalEnum(FORMATS, c.format, `${p}/format`, "format");
    let formatDialect: JsonSchemaDialect | undefined;
    if (c.formatDialect !== undefined && c.formatDialect !== null) {
      formatDialect = oneOf(DIALECTS, c.formatDialect);
      if (format && format !== "json-schema") { bad(`${p}/formatDialect`, "formatDialect applies to the json-schema format only"); formatDialect = undefined; }
      else if (!formatDialect) bad(`${p}/formatDialect`, `formatDialect must be one of ${DIALECTS.join(", ")}`);
    }
    const parameters = ax.read(c, "parameters", p, ax.parameters);
    const parametersShapeOk = c.parameters === undefined || c.parameters === null || isBag(c.parameters);
    // A definition counts even when its content is invalid (that is reported at the parameter itself).
    const definedParameters = isBag(c.parameters) ? c.parameters : undefined;
    // address: string | null; every {expr} needs a non-empty name and a matching parameter definition
    let address: string | null = null;
    if (c.address !== undefined && c.address !== null) {
      if (typeof c.address !== "string") bad(`${p}/address`, "address must be a string or null");
      else if (c.address.trim() !== "") {
        address = c.address.trim();
        let emptyReported = false;
        const missing = new Set<string>();
        for (const m of address.matchAll(/\{([^{}]*)\}/g)) {
          const name = m[1];
          if (name.trim() === "") {
            if (!emptyReported) { bad(`${p}/address`, 'Address contains an empty expression "{}"'); emptyReported = true; }
          } else if (parametersShapeOk && !(definedParameters && hasOwn(definedParameters, name)) && !missing.has(name)) {
            missing.add(name);
            bad(`${p}/parameters`, `Address expression "{${name}}" needs a parameter definition`);
          }
        }
      }
    }
    return {
      keyOk,
      value: compact<DocChannel>({
        key, address, protocol,
        serverKeys: r.list(c, "serverKeys", p),
        bindings: r.obj(c, "bindings", p),
        origin: r.origin(c, p),
        format,
        formatDialect,
        title: r.opt(c, "title", p),
        summary: r.opt(c, "summary", p),
        description: r.opt(c, "description", p),
        parameters,
        tags: ax.read(c, "tags", p, ax.tags),
        externalDocs: ax.read(c, "externalDocs", p, ax.externalDocs),
        messageKeys: r.list(c, "messageKeys", p),
      }),
    };
  });

  const messages = r.array(value, "messages", "").map((raw, i): Entry<DocMessage> => {
    const p = `/messages/${i}`;
    const m = r.item(raw, p, "message");
    const { key, keyOk } = r.docKey(m, p);
    return {
      keyOk,
      value: compact<DocMessage>({
        key,
        name: r.opt(m, "name", p),
        title: r.opt(m, "title", p),
        summary: r.opt(m, "summary", p),
        description: r.opt(m, "description", p),
        contentType: r.opt(m, "contentType", p),
        correlationId: ax.read(m, "correlationId", p, ax.correlationId),
        tags: ax.read(m, "tags", p, ax.tags),
        externalDocs: ax.read(m, "externalDocs", p, ax.externalDocs),
        deprecated: ax.read(m, "deprecated", p, ax.bool),
        bindings: r.obj(m, "bindings", p),
        examples: ax.read(m, "examples", p, ax.examples),
        representation: optionalEnum(FORMATS, m.representation, `${p}/representation`, "representation"),
        payload: r.pin(m, "payload", p, true) ?? { entityId: "", entityVersionId: null },
        headers: r.pin(m, "headers", p, false),
        keyPin: r.pin(m, "keyPin", p, false),
        traitKeys: r.list(m, "traitKeys", p),
      }),
    };
  });

  const rawTraits = r.array(value, "traits", "");
  const traits = rawTraits.map((raw, i): Entry<DocTrait, { kind: TraitKind | undefined }> => {
    const p = `/traits/${i}`;
    const t = r.item(raw, p, "trait");
    const { key, keyOk } = r.docKey(t, p);
    const kind = oneOf(TRAIT_KINDS, t.kind);
    if (!kind) bad(`${p}/kind`, `kind must be one of ${TRAIT_KINDS.join(", ")}`);
    const hasSpec = t.spec !== undefined && t.spec !== null;
    const hasLibrary = t.libraryTraitId !== undefined && t.libraryTraitId !== null;
    if (hasSpec === hasLibrary) bad(p, "Message properties need exactly one of spec or libraryTraitId");
    if (hasLibrary && !hasSpec) {
      const libraryTraitId = r.req(t, "libraryTraitId", p) ?? "";
      return { keyOk, kind, value: { key, kind: kind ?? "MESSAGE", libraryTraitId } };
    }
    let spec: JsonObject | undefined;
    if (hasSpec) {
      if (!isBag(t.spec)) bad(`${p}/spec`, "spec must be an object");
      else if (kind) spec = ax.read(t, "spec", p, ax.traitSpec(kind)); // unknown kind: already reported, nothing to check the spec against
      else spec = t.spec as JsonObject;
    }
    return { keyOk, kind, value: compact<DocTrait>({ key, kind: kind ?? "MESSAGE", spec: spec ?? {}, headers: r.pin(t, "headers", p, false) }) };
  });

  const rawOperations = r.array(value, "operations", "");
  const operations = rawOperations.map((raw, i): Entry<DocOperation> => {
    const p = `/operations/${i}`;
    const o = r.item(raw, p, "operation");
    const { key, keyOk } = r.docKey(o, p);
    const action = oneOf(ACTIONS, o.action);
    if (!action) bad(`${p}/action`, `action must be one of ${ACTIONS.join(", ")}`);
    let reply: DocOperation["reply"];
    if (o.reply !== undefined && o.reply !== null) {
      if (!isBag(o.reply)) bad(`${p}/reply`, "reply must be an object");
      else {
        reply = compact({
          address: ax.read(o.reply, "address", `${p}/reply`, ax.replyAddress),
          channelKey: r.opt(o.reply, "channelKey", `${p}/reply`),
          messageKeys: o.reply.messageKeys === undefined || o.reply.messageKeys === null ? undefined : r.list(o.reply, "messageKeys", `${p}/reply`),
        });
      }
    }
    return {
      keyOk,
      value: compact<DocOperation>({
        key, action: action ?? "send",
        channelKey: r.req(o, "channelKey", p) ?? "",
        messageKeys: r.list(o, "messageKeys", p),
        traitKeys: r.list(o, "traitKeys", p),
        title: r.opt(o, "title", p),
        summary: r.opt(o, "summary", p),
        description: r.opt(o, "description", p),
        security: ax.read(o, "security", p, ax.strings()),
        tags: ax.read(o, "tags", p, ax.tags),
        externalDocs: ax.read(o, "externalDocs", p, ax.externalDocs),
        bindings: r.obj(o, "bindings", p),
        reply,
      }),
    };
  });

  const externalRefs = r.array(value, "externalRefs", "").map((raw, i): Entry<DocExternalRef, { kind: DocExternalRef["kind"] | undefined }> => {
    const p = `/externalRefs/${i}`;
    const x = r.item(raw, p, "external reference");
    const { key, keyOk } = r.docKey(x, p);
    const kind = oneOf(REF_KINDS, x.kind);
    if (!kind) bad(`${p}/kind`, `kind must be one of ${REF_KINDS.join(", ")}`);
    return {
      keyOk, kind,
      value: { key, kind: kind ?? "message", eventVersionId: r.req(x, "eventVersionId", p) ?? "", itemKey: r.req(x, "itemKey", p) ?? "" },
    };
  });

  let components: DocComponents | undefined;
  if (value.components !== undefined && value.components !== null) {
    if (!isBag(value.components)) bad("/components", "components must be an object");
    else {
      const built = compact<DocComponents>({
        correlationIds: r.record(value.components, "correlationIds", "/components"),
        parameters: r.record(value.components, "parameters", "/components"),
        securitySchemes: ax.read(value.components, "securitySchemes", "/components", ax.securitySchemes),
      });
      if (Object.keys(built).length > 0) components = built;
    }
  }

  const doc: EventDocument = compact<EventDocument>({
    documentVersion: DOCUMENT_VERSION,
    info,
    defaultContentType: r.opt(value, "defaultContentType", ""),
    servers: servers.map((e) => e.value),
    channels: channels.map((e) => e.value),
    messages: messages.map((e) => e.value),
    traits: traits.map((e) => e.value),
    operations: operations.map((e) => e.value),
    externalRefs: externalRefs.map((e) => e.value),
    components,
  });

  // ── cross-reference checks (after parsing, so every problem is reported in one pass) ──
  const flagged = new Set<string>();
  const checkUnique = (label: string, entries: Array<{ key: string; keyOk: boolean; pointer: string }>) => {
    const seen = new Set<string>();
    for (const e of entries) {
      if (!e.keyOk) continue;
      if (seen.has(e.key)) { bad(e.pointer, `Duplicate ${label} key "${e.key}"`); flagged.add(e.pointer); } else seen.add(e.key);
    }
  };
  const at = (base: string) => (e: Entry<{ key: string }>, i: number) => ({ key: e.value.key, keyOk: e.keyOk, pointer: `${base}/${i}/key` });
  const refsOf = (kind: DocExternalRef["kind"]) => externalRefs.map((e, i) => ({ e, i })).filter(({ e }) => e.kind === kind);
  const refEntry = ({ e, i }: { e: Entry<DocExternalRef>; i: number }) => at("/externalRefs")(e, i);

  checkUnique("server", servers.map(at("/servers")));
  checkUnique("channel", [...channels.map(at("/channels")), ...refsOf("channel").map(refEntry)]);
  checkUnique("message", [...messages.map(at("/messages")), ...refsOf("message").map(refEntry)]);
  checkUnique(ANY_PROPERTIES, traits.map(at("/traits"))); // one key space for both kinds
  checkUnique("operation", operations.map(at("/operations")));
  checkUnique("external reference", externalRefs.map(at("/externalRefs")).filter((e) => !flagged.has(e.pointer)));

  const serverKeys = new Set(servers.map((e) => e.value.key));
  const localChannels = new Map<string, DocChannel>();
  channels.forEach((e) => { if (!localChannels.has(e.value.key)) localChannels.set(e.value.key, e.value); });
  const externalChannelKeys = new Set(refsOf("channel").map(({ e }) => e.value.key));
  const messageish = new Set([...messages.map((e) => e.value.key), ...refsOf("message").map(({ e }) => e.value.key)]);
  const traitKinds = new Map<string, TraitKind | undefined>();
  traits.forEach((e) => { if (!traitKinds.has(e.value.key)) traitKinds.set(e.value.key, e.kind); });
  const isChannel = (k: string) => localChannels.has(k) || externalChannelKeys.has(k);

  const checkTraitRefs = (keys: string[], pointer: string, kind: TraitKind) => keys.forEach((k, j) => {
    if (!traitKinds.has(k)) bad(`${pointer}/${j}`, `Unknown ${propertiesNoun(kind)} "${k}"`);
    else if (traitKinds.get(k) !== undefined && traitKinds.get(k) !== kind) bad(`${pointer}/${j}`, `"${k}" is not a set of ${propertiesNoun(kind)}`);
  });
  /** `messageKeys` must resolve and, on a local channel, be allowed by that channel. External channels get no subset check here. */
  const checkMessageRefs = (keys: string[], pointer: string, channelKey: string | undefined) => keys.forEach((k, j) => {
    if (!messageish.has(k)) { bad(`${pointer}/${j}`, `Unknown message "${k}"`); return; }
    const channel = channelKey === undefined ? undefined : localChannels.get(channelKey);
    if (channel && !channel.messageKeys.includes(k)) bad(`${pointer}/${j}`, `Message "${k}" is not allowed on channel "${channel.key}"`);
  });

  channels.forEach((e, i) => {
    const p = `/channels/${i}`;
    e.value.serverKeys.forEach((k, j) => { if (!serverKeys.has(k)) bad(`${p}/serverKeys/${j}`, `Unknown server "${k}"`); });
    e.value.messageKeys.forEach((k, j) => { if (!messageish.has(k)) bad(`${p}/messageKeys/${j}`, `Unknown message "${k}"`); });
  });
  messages.forEach((e, i) => checkTraitRefs(e.value.traitKeys, `/messages/${i}/traitKeys`, "MESSAGE"));
  operations.forEach((e, i) => {
    const p = `/operations/${i}`;
    const op = e.value;
    if (op.channelKey !== "" && !isChannel(op.channelKey)) bad(`${p}/channelKey`, `Unknown channel "${op.channelKey}"`);
    checkMessageRefs(op.messageKeys, `${p}/messageKeys`, op.channelKey);
    checkTraitRefs(op.traitKeys, `${p}/traitKeys`, "OPERATION");
    if (op.reply) {
      const replyMessages = op.reply.messageKeys ?? [];
      if (replyMessages.length > 0 && op.reply.channelKey === undefined) bad(`${p}/reply/channelKey`, "reply.channelKey is required when reply.messageKeys is set");
      if (op.reply.channelKey !== undefined && !isChannel(op.reply.channelKey)) bad(`${p}/reply/channelKey`, `Unknown channel "${op.reply.channelKey}"`);
      checkMessageRefs(replyMessages, `${p}/reply/messageKeys`, op.reply.channelKey);
    }
  });

  // Security requirements name entries of `components.securitySchemes`. Checked against the RAW lists so a pointer never drifts
  // when an earlier entry was invalid. Skipped when the schemes map itself is malformed (already one problem, not one per reference).
  let schemeKeys: Set<string> | undefined = new Set();
  if (value.components !== undefined && value.components !== null) {
    if (!isBag(value.components)) schemeKeys = undefined;
    else if (value.components.securitySchemes !== undefined && value.components.securitySchemes !== null) {
      schemeKeys = isBag(value.components.securitySchemes) ? new Set(Object.keys(value.components.securitySchemes)) : undefined;
    }
  }
  if (schemeKeys) {
    const known = schemeKeys;
    const checkSchemeRefs = (raw: unknown, pointer: string) => {
      if (!Array.isArray(raw)) return;
      raw.forEach((k, j) => {
        if (typeof k === "string" && k.trim() !== "" && !known.has(k.trim())) {
          bad(`${pointer}/${j}`, `Unknown security scheme "${k.trim()}" — define it under components.securitySchemes`);
        }
      });
    };
    const rawSecurity = (raw: unknown): unknown => (isBag(raw) ? raw.security : undefined);
    rawServers.forEach((raw, i) => checkSchemeRefs(rawSecurity(raw), `/servers/${i}/security`));
    rawOperations.forEach((raw, i) => checkSchemeRefs(rawSecurity(raw), `/operations/${i}/security`));
    rawTraits.forEach((raw, i) => {
      if (isBag(raw) && raw.kind === "OPERATION") checkSchemeRefs(rawSecurity(raw.spec), `/traits/${i}/spec/security`);
    });
  }

  return problems.length > 0 ? fail() : ok(doc);
}
