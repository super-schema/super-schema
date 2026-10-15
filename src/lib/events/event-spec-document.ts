// src/lib/events/event-spec-document.ts
import { ok, err, type Result } from "@/types/result";
import type {
  EventSpecDocument,
  EventSpecLocalComponents,
  EventSpecOperation,
  EventSpecServer,
  JsonObject,
} from "@/lib/event-specs/types";
import { isJsonObject } from "./inputs";
import { isReservedKey } from "@/lib/event-specs/own-property";

export const COMPONENT_KEY_PATTERN = /^[A-Za-z0-9._-]+$/;

/**
 * A server / operation key becomes a key of the AsyncAPI document, so it must match the component-key pattern AND not
 * be one of the names that collide with `Object.prototype` (`__proto__`, `constructor`, `prototype`): `__proto__`
 * matches the pattern but, assigned onto a plain object, silently vanishes instead of becoming an entry.
 */
function keyProblem(kind: "Server" | "Operation", key: string): string | undefined {
  if (!COMPONENT_KEY_PATTERN.test(key)) return `${kind} key "${key}" must match ^[A-Za-z0-9._-]+$`;
  if (isReservedKey(key)) return `${kind} key "${key}" is reserved and cannot be used — choose another key`;
  return undefined;
}
export interface DocumentProblem {
  pointer: string;
  message: string;
}
export interface DocumentRefs {
  channelIds: string[];
  messageRefIds: string[];
  traitIds: string[];
}

export function emptyEventSpecDocument(title: string, description?: string): EventSpecDocument {
  return { info: description ? { title, description } : { title }, servers: [], operations: [] };
}

type Bag = Record<string, unknown>;
const asBag = (v: unknown): Bag => (isJsonObject(v) ? v : {});

function optString(src: Bag, key: string, pointer: string, problems: DocumentProblem[]): string | undefined {
  const v = src[key];
  if (v === undefined || v === null || v === "") return undefined;
  if (typeof v === "string") return v;
  problems.push({ pointer: `${pointer}/${key}`, message: `${key} must be a string` });
  return undefined;
}

function optObject(src: Bag, key: string, pointer: string, problems: DocumentProblem[]): JsonObject | undefined {
  const v = src[key];
  if (v === undefined || v === null) return undefined;
  if (isJsonObject(v)) return v;
  problems.push({ pointer: `${pointer}/${key}`, message: `${key} must be an object` });
  return undefined;
}

function stringList(src: Bag, key: string, pointer: string, problems: DocumentProblem[]): string[] {
  const v = src[key];
  if (v === undefined || v === null) return [];
  if (Array.isArray(v) && v.every((x) => typeof x === "string" && x.length > 0)) return [...(v as string[])];
  problems.push({ pointer: `${pointer}/${key}`, message: `${key} must be an array of ids` });
  return [];
}

function compact<T extends object>(value: T): T {
  return Object.fromEntries(Object.entries(value).filter(([, v]) => v !== undefined)) as T;
}

function parseServers(raw: unknown, problems: DocumentProblem[]): EventSpecServer[] {
  if (raw === undefined || raw === null) return [];
  if (!Array.isArray(raw)) {
    problems.push({ pointer: "/servers", message: "servers must be an array" });
    return [];
  }
  const keys = new Set<string>();
  return raw.map((item, i) => {
    const p = `/servers/${i}`;
    const s = asBag(item);
    const key = typeof s.key === "string" ? s.key.trim() : "";
    const keyIssue = keyProblem("Server", key);
    if (keyIssue) problems.push({ pointer: `${p}/key`, message: keyIssue });
    else if (keys.has(key)) problems.push({ pointer: `${p}/key`, message: `Duplicate server key "${key}"` });
    keys.add(key);
    const protocol = typeof s.protocol === "string" ? s.protocol.trim() : "";
    if (!protocol) problems.push({ pointer: `${p}/protocol`, message: "Server protocol is required" });
    const host = typeof s.host === "string" ? s.host.trim() : "";
    if (!host) problems.push({ pointer: `${p}/host`, message: "Server host is required" });
    return compact<EventSpecServer>({
      key,
      protocol,
      host,
      pathname: optString(s, "pathname", p, problems),
      protocolVersion: optString(s, "protocolVersion", p, problems),
      description: optString(s, "description", p, problems),
      externalRef: optString(s, "externalRef", p, problems),
    });
  });
}

function parseOperations(raw: unknown, problems: DocumentProblem[]): EventSpecOperation[] {
  if (raw === undefined || raw === null) return [];
  if (!Array.isArray(raw)) {
    problems.push({ pointer: "/operations", message: "operations must be an array" });
    return [];
  }
  const keys = new Set<string>();
  return raw.map((item, i) => {
    const p = `/operations/${i}`;
    const o = asBag(item);
    const key = typeof o.key === "string" ? o.key.trim() : "";
    const keyIssue = keyProblem("Operation", key);
    if (keyIssue) problems.push({ pointer: `${p}/key`, message: keyIssue });
    else if (keys.has(key)) problems.push({ pointer: `${p}/key`, message: `Duplicate operation key "${key}"` });
    keys.add(key);
    const action = o.action === "send" || o.action === "receive" ? o.action : null;
    if (!action) problems.push({ pointer: `${p}/action`, message: 'Operation action must be "send" or "receive"' });
    const channelId = typeof o.channelId === "string" ? o.channelId.trim() : "";
    if (!channelId) problems.push({ pointer: `${p}/channelId`, message: "Operation channel is required" });

    let reply: EventSpecOperation["reply"];
    if (o.reply !== undefined && o.reply !== null) {
      if (!isJsonObject(o.reply)) problems.push({ pointer: `${p}/reply`, message: "reply must be an object" });
      else {
        const r = o.reply;
        reply = compact({
          channelId: optString(r, "channelId", `${p}/reply`, problems),
          messageVersionIds: r.messageVersionIds === undefined ? undefined : stringList(r, "messageVersionIds", `${p}/reply`, problems),
        });
      }
    }

    return compact<EventSpecOperation>({
      key,
      action: action ?? "send",
      channelId,
      messageVersionIds: stringList(o, "messageVersionIds", p, problems),
      traitIds: stringList(o, "traitIds", p, problems),
      summary: optString(o, "summary", p, problems),
      description: optString(o, "description", p, problems),
      bindings: optObject(o, "bindings", p, problems),
      reply,
    });
  });
}

function parseComponents(raw: unknown, problems: DocumentProblem[]): EventSpecLocalComponents | undefined {
  if (raw === undefined || raw === null) return undefined;
  if (!isJsonObject(raw)) {
    problems.push({ pointer: "/components", message: "components must be an object" });
    return undefined;
  }
  const out: EventSpecLocalComponents = {};
  for (const key of ["correlationIds", "parameters", "securitySchemes", "operationBindings"] as const) {
    const map = optObject(raw, key, "/components", problems);
    if (map === undefined) continue;
    if (!Object.values(map).every(isJsonObject)) {
      problems.push({ pointer: `/components/${key}`, message: `components.${key} values must be objects` });
      continue;
    }
    out[key] = map as Record<string, JsonObject>;
  }
  return Object.keys(out).length > 0 ? out : undefined;
}

/** Validate + normalize a stored or submitted draft (spec §6.1). Unknown keys are dropped. */
export function parseEventSpecDocument(value: unknown): Result<EventSpecDocument> {
  const problems: DocumentProblem[] = [];
  if (!isJsonObject(value)) {
    return err({ code: "VALIDATION_ERROR", message: "The event spec document must be an object", details: { problems: [{ pointer: "", message: "document must be an object" }] } });
  }
  const infoBag = asBag(value.info);
  if (!isJsonObject(value.info)) problems.push({ pointer: "/info", message: "info must be an object" });
  const title = typeof infoBag.title === "string" ? infoBag.title.trim() : "";
  if (!title) problems.push({ pointer: "/info/title", message: "info.title is required" });
  else if (title.length > 200) problems.push({ pointer: "/info/title", message: "info.title must be at most 200 characters" });
  const tags = infoBag.tags;
  if (tags !== undefined && !(Array.isArray(tags) && tags.every(isJsonObject))) problems.push({ pointer: "/info/tags", message: "tags must be an array of objects" });

  const doc: EventSpecDocument = {
    info: compact({
      title,
      description: optString(infoBag, "description", "/info", problems),
      contact: optObject(infoBag, "contact", "/info", problems),
      license: optObject(infoBag, "license", "/info", problems),
      tags: Array.isArray(tags) && tags.every(isJsonObject) ? (tags as JsonObject[]) : undefined,
      externalDocs: optObject(infoBag, "externalDocs", "/info", problems),
    }),
    servers: [],
    operations: [],
  };
  const defaultContentType = optString(value, "defaultContentType", "", problems);
  if (defaultContentType !== undefined) doc.defaultContentType = defaultContentType;
  doc.servers = parseServers(value.servers, problems);
  doc.operations = parseOperations(value.operations, problems);
  const components = parseComponents(value.components, problems);
  if (components) doc.components = components;

  if (problems.length > 0) {
    return err({
      code: "VALIDATION_ERROR",
      message: `The event spec document has ${problems.length} problem(s)`,
      details: { problems },
      suggestedFix: "Fix the highlighted fields and save again.",
    });
  }
  return ok(doc);
}

/** Every referenced id, unique, in first-reference order. */
export function collectDocumentRefs(doc: EventSpecDocument): DocumentRefs {
  const channelIds = new Set<string>();
  const messageRefIds = new Set<string>();
  const traitIds = new Set<string>();
  for (const op of doc.operations) {
    channelIds.add(op.channelId);
    op.messageVersionIds.forEach((id) => messageRefIds.add(id));
    op.traitIds.forEach((id) => traitIds.add(id));
    if (op.reply?.channelId) channelIds.add(op.reply.channelId);
    op.reply?.messageVersionIds?.forEach((id) => messageRefIds.add(id));
  }
  return { channelIds: [...channelIds], messageRefIds: [...messageRefIds], traitIds: [...traitIds] };
}
