// src/lib/events/document/parse-objects.ts
// Readers for the AsyncAPI 3.0 objects nested inside the event document (info, server variables, parameters, tags, examples,
// correlation ids, reply addresses, trait specs, security schemes). Pure — client-safe; used by `parse.ts`.
//
// Contract shared by every reader: `null`/`undefined`/blank = absent (returns `undefined`); an invalid value reports ONE problem at
// its own pointer and returns `undefined`; objects come back with their keys in AUTHORED order, which the assembler emits
// verbatim; unknown properties are problems except `x-…` extensions, which are kept as written.
import { isReservedKey } from "@/lib/event-specs/own-property";
import type { AsyncApiContact, AsyncApiLicense, JsonObject, JsonValue, TraitKind } from "@/lib/event-specs/types";
import type {
  DocChannelParameter, DocCorrelationId, DocExternalDocs, DocMessageExample, DocReplyAddress, DocSecurityScheme, DocServerVariable, DocTag,
} from "./types";
import { KEY_PATTERN, SECURITY_SCHEME_TYPES } from "./types";

export type Bag = Record<string, unknown>;
export type Bad = (pointer: string, message: string) => void;
/** Reads one raw value found at pointer `at`. */
export type Reader<T> = (value: unknown, at: string) => T | undefined;

export const isBag = (v: unknown): v is Bag => typeof v === "object" && v !== null && !Array.isArray(v);
/** RFC 6901 pointer from path parts. */
export const ptr = (...parts: Array<string | number>) => parts.map((p) => `/${String(p).replace(/~/g, "~0").replace(/\//g, "~1")}`).join("");
const hasOwn = (o: object, k: string) => Object.prototype.hasOwnProperty.call(o, k);

const EMAIL = /^[^\s@]+@[^\s@]+\.[^\s@]+$/;
/** `$message.header#/…` or `$message.payload#/…` with a valid RFC 6901 pointer (`~` only as `~0` / `~1`). */
const RUNTIME_EXPRESSION = /^\$message\.(header|payload)#(\/([^/~]|~[01])*)+$/;

export function isHttpUrl(value: string): boolean {
  if (/\s/.test(value)) return false;
  try {
    const url = new URL(value);
    return (url.protocol === "http:" || url.protocol === "https:") && url.hostname !== "";
  } catch {
    return false;
  }
}

const isAbsentOrBlank = (v: unknown) => v === undefined || v === null || (typeof v === "string" && v.trim() === "");
/** The last pointer segment, unescaped: the property name a problem message talks about. */
const leaf = (at: string) => at.slice(at.lastIndexOf("/") + 1).replace(/~1/g, "/").replace(/~0/g, "~");

export function createObjectReaders(bad: Bad) {
  // ── scalars ──
  const str: Reader<string> = (v, at) => {
    if (v === undefined || v === null) return undefined;
    if (typeof v !== "string") { bad(at, `${leaf(at)} must be a string`); return undefined; }
    const t = v.trim();
    return t === "" ? undefined : t;
  };
  const url: Reader<string> = (v, at) => {
    const s = str(v, at);
    if (s !== undefined && !isHttpUrl(s)) { bad(at, `${leaf(at)} must be an absolute http(s) URL`); return undefined; }
    return s;
  };
  const email: Reader<string> = (v, at) => {
    const s = str(v, at);
    if (s !== undefined && !EMAIL.test(s)) { bad(at, `${leaf(at)} must be a valid email address`); return undefined; }
    return s;
  };
  const bool: Reader<boolean> = (v, at) => {
    if (v === undefined || v === null) return undefined;
    if (typeof v !== "boolean") { bad(at, `${leaf(at)} must be true or false`); return undefined; }
    return v;
  };
  /** `$message.header#/…` / `$message.payload#/…`. */
  const expression: Reader<string> = (v, at) => {
    const s = str(v, at);
    if (s !== undefined && !RUNTIME_EXPRESSION.test(s)) {
      bad(at, `${leaf(at)} must be a runtime expression starting with $message.header#/ or $message.payload#/`);
      return undefined;
    }
    return s;
  };
  /** A list of non-empty strings; `unique` reports a repeated entry. */
  const strings = (unique = false): Reader<string[]> => (v, at) => {
    if (v === undefined || v === null) return undefined;
    if (!Array.isArray(v)) { bad(at, `${leaf(at)} must be an array of strings`); return undefined; }
    const out: string[] = [];
    v.forEach((x, j) => {
      if (typeof x !== "string" || x.trim() === "") { bad(`${at}/${j}`, `${leaf(at)} entries must be non-empty strings`); return; }
      const t = x.trim();
      if (unique && out.includes(t)) bad(`${at}/${j}`, `Duplicate value "${t}" in ${leaf(at)}`);
      else out.push(t);
    });
    return out;
  };
  /** An object kept exactly as written (bindings, headers). */
  const jsonObject: Reader<JsonObject> = (v, at) => {
    if (v === undefined || v === null) return undefined;
    if (!isBag(v)) { bad(at, `${leaf(at)} must be an object`); return undefined; }
    return v as JsonObject;
  };
  /** Any JSON value, `null` included (an example payload may be `null`). */
  const anyJson: Reader<JsonValue> = (v) => (v === undefined ? undefined : (v as JsonValue));

  // ── combinators ──
  /**
   * An AsyncAPI object with the given properties. Keys come back in authored order; `required` lists properties that must be
   * present and non-blank; any other key is a problem unless it is an `x-…` extension (kept verbatim).
   */
  function shape<T>(label: string, fields: Record<string, Reader<unknown>>, required: readonly string[] = []): Reader<T> {
    return (raw, at) => {
      if (raw === undefined || raw === null) return undefined;
      if (!isBag(raw)) { bad(at, `${label} must be an object`); return undefined; }
      const out: Bag = {};
      for (const [key, value] of Object.entries(raw)) {
        const field = hasOwn(fields, key) ? fields[key] : undefined;
        if (field) {
          const read = field(value, `${at}${ptr(key)}`);
          if (read !== undefined) out[key] = read;
        } else if (key.startsWith("x-")) out[key] = value;
        else bad(`${at}${ptr(key)}`, `"${key}" is not a property of ${label}`);
      }
      for (const key of required) if (out[key] === undefined && isAbsentOrBlank(raw[key])) bad(`${at}${ptr(key)}`, `${key} is required`);
      return out as T;
    };
  }
  /** An array whose entries are read by `item`; an invalid entry is reported and left out. */
  const list = <T>(item: Reader<T>, noun: string): Reader<T[]> => (v, at) => {
    if (v === undefined || v === null) return undefined;
    if (!Array.isArray(v)) { bad(at, `${leaf(at)} must be an array of ${noun}`); return undefined; }
    const out: T[] = [];
    v.forEach((x, j) => {
      if (x === undefined || x === null) { bad(`${at}/${j}`, `${leaf(at)} entries must be ${noun}`); return; }
      const read = item(x, `${at}/${j}`);
      if (read !== undefined) out.push(read);
    });
    return out;
  };
  /** A map keyed by user-chosen names, entries read by `item`, keys kept in authored order. */
  const record = <T>(item: Reader<T>): Reader<Record<string, T>> => (v, at) => {
    if (v === undefined || v === null) return undefined;
    if (!isBag(v)) { bad(at, `${leaf(at)} must be an object`); return undefined; }
    const out: Record<string, T> = {};
    for (const [name, x] of Object.entries(v)) {
      const read = item(x, `${at}${ptr(name)}`);
      if (read !== undefined) Object.defineProperty(out, name, { value: read, enumerable: true, writable: true, configurable: true });
    }
    return out;
  };

  // ── shared AsyncAPI objects ──
  const externalDocs: Reader<DocExternalDocs> = shape("externalDocs", { url, description: str }, ["url"]);
  const tag: Reader<DocTag> = shape("a tag", { name: str, description: str, externalDocs }, ["name"]);
  const tags: Reader<DocTag[]> = list(tag, "objects");
  const contact: Reader<AsyncApiContact> = shape("contact", { name: str, url, email });
  const license: Reader<AsyncApiLicense> = shape("license", { name: str, url }, ["name"]);
  const correlationId: Reader<DocCorrelationId> = shape("correlationId", { location: expression, description: str }, ["location"]);
  const replyAddress: Reader<DocReplyAddress> = shape("a reply address", { location: expression, description: str }, ["location"]);
  const parameter: Reader<DocChannelParameter> = shape("a channel parameter", {
    description: str, enum: strings(), default: str, examples: strings(), location: expression,
  });
  const serverVariable: Reader<DocServerVariable> = shape("a server variable", { enum: strings(true), default: str, description: str, examples: strings() });
  const example: Reader<DocMessageExample> = (raw, at) => {
    const out = shape<DocMessageExample>("an example", { name: str, summary: str, headers: jsonObject, payload: anyJson })(raw, at);
    // AsyncAPI: an example carries headers, a payload, or both (`payload: null` counts)
    if (out && isBag(raw) && isAbsentOrBlank(raw.headers) && raw.payload === undefined) bad(at, "An example needs headers or a payload");
    return out;
  };
  const examples: Reader<DocMessageExample[]> = list(example, "objects");

  // ── security schemes ──
  const scopes: Reader<Record<string, string>> = (v, at) => {
    if (v === undefined || v === null) return undefined;
    if (!isBag(v)) { bad(at, `${leaf(at)} must be an object of scope descriptions`); return undefined; }
    const out: Record<string, string> = {};
    for (const [name, description] of Object.entries(v)) {
      if (typeof description === "string") out[name] = description;
      else bad(`${at}${ptr(name)}`, "A scope description must be a string");
    }
    return out;
  };
  const FLOWS = {
    implicit: { required: ["authorizationUrl", "availableScopes"], forbidden: ["tokenUrl"] },
    password: { required: ["tokenUrl", "availableScopes"], forbidden: ["authorizationUrl"] },
    clientCredentials: { required: ["tokenUrl", "availableScopes"], forbidden: ["authorizationUrl"] },
    authorizationCode: { required: ["authorizationUrl", "tokenUrl", "availableScopes"], forbidden: [] as string[] },
  } as const;
  const flow = (name: keyof typeof FLOWS): Reader<JsonObject> => (raw, at) => {
    const out = shape<JsonObject>(`the ${name} flow`, { authorizationUrl: url, tokenUrl: url, refreshUrl: url, availableScopes: scopes }, FLOWS[name].required)(raw, at);
    if (out && isBag(raw)) {
      for (const key of FLOWS[name].forbidden) if (!isAbsentOrBlank(raw[key])) bad(`${at}${ptr(key)}`, `${key} does not apply to the ${name} flow`);
    }
    return out;
  };
  const flows: Reader<JsonObject> = (raw, at) => {
    const out = shape<JsonObject>("flows", Object.fromEntries((Object.keys(FLOWS) as Array<keyof typeof FLOWS>).map((name) => [name, flow(name)])))(raw, at);
    if (out && isBag(raw) && !Object.keys(out).some((key) => !key.startsWith("x-"))) {
      bad(at, "flows needs at least one flow: implicit, password, clientCredentials or authorizationCode");
    }
    return out;
  };
  const SCHEME_FIELDS: Record<string, { fields: Record<string, Reader<unknown>>; required: string[] }> = {
    apiKey: { fields: { in: oneOfValues(["user", "password"]) }, required: ["in"] },
    httpApiKey: { fields: { name: str, in: oneOfValues(["header", "query", "cookie"]) }, required: ["name", "in"] },
    http: { fields: { scheme: str, bearerFormat: str }, required: ["scheme"] },
    oauth2: { fields: { flows, scopes: strings() }, required: ["flows"] },
    openIdConnect: { fields: { openIdConnectUrl: url, scopes: strings() }, required: ["openIdConnectUrl"] },
  };
  function oneOfValues(values: readonly string[]): Reader<string> {
    return (v, at) => {
      const s = str(v, at);
      if (s !== undefined && !values.includes(s)) { bad(at, `${leaf(at)} must be one of ${values.join(", ")}`); return undefined; }
      return s;
    };
  }
  const securityScheme: Reader<DocSecurityScheme> = (raw, at) => {
    if (!isBag(raw)) { bad(at, "A security scheme must be an object"); return undefined; }
    const type = SECURITY_SCHEME_TYPES.find((t) => t === raw.type);
    if (!type) { bad(`${at}/type`, `type must be one of ${SECURITY_SCHEME_TYPES.join(", ")}`); return undefined; }
    const specific = SCHEME_FIELDS[type] ?? { fields: {}, required: [] };
    const out = shape<Bag>(`a ${type} security scheme`, { type: str, description: str, ...specific.fields }, specific.required)(raw, at);
    if (out && type === "http" && out.bearerFormat !== undefined && out.scheme !== "bearer") {
      bad(`${at}/bearerFormat`, 'bearerFormat only applies when scheme is "bearer"');
    }
    return out as DocSecurityScheme | undefined;
  };
  /** `components.securitySchemes`: every key must be usable in a `$ref` (the components key rule, no reserved name). */
  const securitySchemes: Reader<Record<string, DocSecurityScheme>> = (v, at) => {
    if (v === undefined || v === null) return undefined;
    if (!isBag(v)) { bad(at, "securitySchemes must be an object"); return undefined; }
    const out: Record<string, DocSecurityScheme> = {};
    for (const [key, raw] of Object.entries(v)) {
      const entryAt = `${at}${ptr(key)}`;
      let keyOk = true;
      if (!KEY_PATTERN.test(key)) { bad(entryAt, `Security scheme key "${key}" may only contain letters, digits, ".", "_" and "-"`); keyOk = false; }
      else if (isReservedKey(key)) { bad(entryAt, `Security scheme key "${key}" is reserved — choose another key`); keyOk = false; }
      const scheme = securityScheme(raw, entryAt);
      if (scheme && keyOk) out[key] = scheme;
    }
    return out;
  };

  // ── local trait specs ──
  const messageTraitSpec = shape<JsonObject>("a message trait", {
    name: str, title: str, summary: str, description: str, contentType: str, correlationId, tags, externalDocs, deprecated: bool, examples,
    bindings: jsonObject, headers: jsonObject,
  });
  const operationTraitSpec = shape<JsonObject>("an operation trait", {
    title: str, summary: str, description: str, security: strings(), tags, externalDocs, bindings: jsonObject,
  });
  /** A local trait's `spec`, checked against the properties AsyncAPI defines for the trait's kind. */
  const traitSpec = (kind: TraitKind): Reader<JsonObject> => (kind === "MESSAGE" ? messageTraitSpec : operationTraitSpec);

  /** Reads `src[key]` with `reader`, at `pointer/key`. */
  const read = <T>(src: Bag, key: string, pointer: string, reader: Reader<T>): T | undefined => reader(src[key], `${pointer}${ptr(key)}`);

  return {
    read, str, url, email, bool, strings, expression, jsonObject, shape, list, record,
    externalDocs, tag, tags, contact, license, correlationId, replyAddress, parameter, serverVariable, example, examples,
    securityScheme, securitySchemes, traitSpec,
    /** Parameters of a channel and variables of a server: maps keyed by the `{name}` they fill. */
    parameters: record(parameter), variables: record(serverVariable),
  };
}
