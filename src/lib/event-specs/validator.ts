import { ok, err, type Result } from "@/types/result";
import type { Diagnostic } from "./types";
import { diagnostic, normalizeDiagnostics } from "./diagnostics";
import { jsonPointer, parseLocalRef, resolveLocalRef } from "./json-pointer";

/**
 * Pluggable document validation (spec §7.1 `validate`, §7.2 step 6).
 *
 * `StructuralAsyncApi3Validator` is the built-in, dependency-free check. The
 * `@asyncapi/parser`-backed validator (Story 18.5, registry-blocked) will be a
 * second `EventSpecValidator` passed to `AsyncApi3Adapter`; it maps parser
 * diagnostics (`path: (string|number)[]`, severity 0–3) onto `Diagnostic`.
 */
export interface EventSpecValidator {
  /** Stable identifier, e.g. "structural" or "asyncapi-parser". */
  readonly name: string;
  /** Never throws; an infrastructure failure is an `err` Result, document problems are diagnostics. */
  validate(document: object): Promise<Result<Diagnostic[]>>;
}

/** The only text a crashed validator puts in a failure Result: the browser, REST clients and forms never see parser / driver text. */
export const GENERIC_VALIDATION_FAILURE = "The event spec could not be validated. Try again; if it keeps failing, contact an administrator.";

/**
 * An infrastructure failure of a validator (it threw, or `@asyncapi/parser` itself crashed) as an `err` Result: the original
 * (raw exception text can carry connection strings, file paths, schema content) is logged server-side under `source`, and
 * the Result keeps `code` with the generic message, so it can flow through `emitDraft` / `toActionResult` unchanged.
 */
export function validatorFailure(code: string, source: string, cause: unknown): Result<never> {
  console.error(`[event-specs] ${source} failed (${code}):`, cause);
  return err({ code, message: GENERIC_VALIDATION_FAILURE });
}

export class StructuralAsyncApi3Validator implements EventSpecValidator {
  readonly name = "structural";

  async validate(document: object): Promise<Result<Diagnostic[]>> {
    return ok(validateAsyncApi3Structure(document));
  }
}

type Obj = Record<string, unknown>;

const isObject = (v: unknown): v is Obj => typeof v === "object" && v !== null && !Array.isArray(v);
const isNonEmptyString = (v: unknown): v is string => typeof v === "string" && v.trim().length > 0;

/** AsyncAPI 3 components map keys. */
const COMPONENT_KEY = /^[a-zA-Z0-9.\-_]+$/;
const COMPONENT_MAPS = [
  "schemas",
  "servers",
  "channels",
  "operations",
  "messages",
  "securitySchemes",
  "serverVariables",
  "parameters",
  "correlationIds",
  "replies",
  "replyAddresses",
  "externalDocs",
  "tags",
  "operationTraits",
  "messageTraits",
  "serverBindings",
  "channelBindings",
  "operationBindings",
  "messageBindings",
];

function entries(value: unknown): Array<[string, unknown]> {
  return isObject(value) ? Object.entries(value) : [];
}

function addressParameters(address: unknown): string[] {
  if (typeof address !== "string") return [];
  return [...address.matchAll(/\{([^{}]+)\}/g)].map((m) => m[1]);
}

/** Every `$ref` must be local and resolve inside the document. */
function checkRefs(root: Obj, node: unknown, path: Array<string | number>, out: Diagnostic[]): void {
  if (Array.isArray(node)) {
    node.forEach((item, i) => checkRefs(root, item, [...path, i], out));
    return;
  }
  if (!isObject(node)) return;
  const refValue = node.$ref;
  if (typeof refValue === "string") {
    const pointer = jsonPointer(...path);
    if (!refValue.startsWith("#")) {
      out.push(diagnostic("error", "REMOTE_REF", `Only local references are allowed, got "${refValue}"`, pointer));
    } else if (!resolveLocalRef(root, refValue).found) {
      out.push(
        diagnostic("error", "UNRESOLVED_REF", `Reference "${refValue}" does not resolve in this document`, pointer),
      );
    }
  }
  for (const [key, value] of Object.entries(node)) {
    if (key !== "$ref") checkRefs(root, value, [...path, key], out);
  }
}

function checkRoot(doc: Obj, out: Diagnostic[]): void {
  if (doc.asyncapi === undefined) {
    out.push(diagnostic("error", "REQUIRED_FIELD", "asyncapi is required", "/asyncapi"));
  } else if (doc.asyncapi !== "3.0.0") {
    out.push(
      diagnostic(
        "error",
        "UNSUPPORTED_ASYNCAPI_VERSION",
        `Expected asyncapi 3.0.0, got ${JSON.stringify(doc.asyncapi)}`,
        "/asyncapi",
      ),
    );
  }
  if (!isObject(doc.info)) {
    out.push(diagnostic("error", "REQUIRED_FIELD", "info is required", "/info"));
    return;
  }
  if (!isNonEmptyString(doc.info.title))
    out.push(diagnostic("error", "REQUIRED_FIELD", "info.title is required", "/info/title"));
  if (!isNonEmptyString(doc.info.version))
    out.push(diagnostic("error", "REQUIRED_FIELD", "info.version is required", "/info/version"));
}

function checkServers(doc: Obj, out: Diagnostic[]): void {
  for (const [key, server] of entries(doc.servers)) {
    if (!isObject(server)) continue;
    for (const field of ["host", "protocol"]) {
      if (!isNonEmptyString(server[field])) {
        out.push(
          diagnostic(
            "error",
            "REQUIRED_FIELD",
            `servers.${key}.${field} is required`,
            jsonPointer("servers", key, field),
          ),
        );
      }
    }
  }
}

function checkChannels(doc: Obj, out: Diagnostic[]): void {
  for (const [key, channel] of entries(doc.channels)) {
    if (!isObject(channel)) continue;
    const inAddress = addressParameters(channel.address);
    const declared = entries(channel.parameters).map(([name]) => name);
    for (const name of inAddress) {
      if (!declared.includes(name)) {
        out.push(
          diagnostic(
            "error",
            "CHANNEL_PARAMETER_MISSING",
            `Address parameter "{${name}}" has no entry in parameters`,
            jsonPointer("channels", key, "address"),
          ),
        );
      }
    }
    for (const name of declared) {
      if (!inAddress.includes(name)) {
        out.push(
          diagnostic(
            "warning",
            "CHANNEL_PARAMETER_UNUSED",
            `Parameter "${name}" does not appear in the channel address`,
            jsonPointer("channels", key, "parameters", name),
          ),
        );
      }
    }
  }
}

/** `#/channels/<key>` → `<key>`; anything else → null. */
function channelKeyOf(value: unknown): string | null {
  if (!isObject(value) || typeof value.$ref !== "string") return null;
  const segments = parseLocalRef(value.$ref);
  return segments && segments.length === 2 && segments[0] === "channels" ? segments[1] : null;
}

/** True when `value` is `{ $ref: "#/channels/<channelKey>/messages/<name>" }`. */
function isChannelMessageRef(value: unknown, channelKey: string): boolean {
  if (!isObject(value) || typeof value.$ref !== "string") return false;
  const segments = parseLocalRef(value.$ref);
  return (
    !!segments &&
    segments.length === 4 &&
    segments[0] === "channels" &&
    segments[1] === channelKey &&
    segments[2] === "messages"
  );
}

function checkOperations(doc: Obj, out: Diagnostic[]): void {
  for (const [key, op] of entries(doc.operations)) {
    if (!isObject(op)) continue;
    if (op.action === undefined) {
      out.push(
        diagnostic(
          "error",
          "REQUIRED_FIELD",
          `operations.${key}.action is required`,
          jsonPointer("operations", key, "action"),
        ),
      );
    } else if (op.action !== "send" && op.action !== "receive") {
      out.push(
        diagnostic(
          "error",
          "INVALID_ACTION",
          `action must be "send" or "receive"`,
          jsonPointer("operations", key, "action"),
        ),
      );
    }

    let channelKey: string | null = null;
    if (op.channel === undefined) {
      out.push(
        diagnostic(
          "error",
          "REQUIRED_FIELD",
          `operations.${key}.channel is required`,
          jsonPointer("operations", key, "channel"),
        ),
      );
    } else {
      channelKey = channelKeyOf(op.channel);
      if (channelKey === null) {
        out.push(
          diagnostic(
            "error",
            "OPERATION_CHANNEL_REF",
            "channel must be a $ref to #/channels/<key>",
            jsonPointer("operations", key, "channel"),
          ),
        );
      }
    }

    if (Array.isArray(op.messages) && channelKey !== null) {
      op.messages.forEach((message, i) => {
        if (!isChannelMessageRef(message, channelKey as string)) {
          out.push(
            diagnostic(
              "error",
              "OPERATION_MESSAGE_NOT_IN_CHANNEL",
              `Operation messages must reference #/channels/${channelKey}/messages/<name>`,
              jsonPointer("operations", key, "messages", i),
            ),
          );
        }
      });
    }

    if (isObject(op.reply)) {
      const replyKey = op.reply.channel === undefined ? null : channelKeyOf(op.reply.channel);
      if (op.reply.channel !== undefined && replyKey === null) {
        out.push(
          diagnostic(
            "error",
            "OPERATION_CHANNEL_REF",
            "reply.channel must be a $ref to #/channels/<key>",
            jsonPointer("operations", key, "reply", "channel"),
          ),
        );
      }
      if (Array.isArray(op.reply.messages)) {
        op.reply.messages.forEach((message, i) => {
          if (replyKey === null || !isChannelMessageRef(message, replyKey)) {
            out.push(
              diagnostic(
                "error",
                "REPLY_MESSAGE_NOT_IN_CHANNEL",
                "Reply messages must reference messages of the reply channel",
                jsonPointer("operations", key, "reply", "messages", i),
              ),
            );
          }
        });
      }
    }
  }
}

/** Headers (inline, `$ref` or multi-format) must be an object schema. */
function checkHeaders(root: Obj, headers: unknown, pointer: string, out: Diagnostic[]): void {
  if (headers === undefined) return;
  let target: unknown = headers;
  if (isObject(headers) && typeof headers.$ref === "string") {
    const resolved = resolveLocalRef(root, headers.$ref);
    if (!resolved.found) return; // reported as UNRESOLVED_REF
    target = resolved.value;
  }
  const schema = isObject(target) && "schemaFormat" in target && "schema" in target ? target.schema : target;
  if (!isObject(schema) || schema.type !== "object") {
    out.push(diagnostic("error", "HEADERS_NOT_OBJECT_SCHEMA", "headers must be a schema of type object", pointer));
  }
}

function checkComponents(doc: Obj, out: Diagnostic[]): void {
  const components = isObject(doc.components) ? doc.components : {};
  for (const map of COMPONENT_MAPS) {
    for (const [key] of entries(components[map])) {
      if (!COMPONENT_KEY.test(key)) {
        out.push(
          diagnostic(
            "error",
            "COMPONENT_KEY_INVALID",
            `Component key "${key}" must match ${COMPONENT_KEY.source}`,
            jsonPointer("components", map, key),
          ),
        );
      }
    }
  }
  for (const [key, message] of entries(components.messages)) {
    if (isObject(message))
      checkHeaders(doc, message.headers, jsonPointer("components", "messages", key, "headers"), out);
  }
  for (const [key, trait] of entries(components.messageTraits)) {
    if (isObject(trait))
      checkHeaders(doc, trait.headers, jsonPointer("components", "messageTraits", key, "headers"), out);
  }
  for (const [channelKey, channel] of entries(doc.channels)) {
    if (!isObject(channel)) continue;
    for (const [name, message] of entries(channel.messages)) {
      if (isObject(message) && typeof message.$ref !== "string") {
        checkHeaders(doc, message.headers, jsonPointer("channels", channelKey, "messages", name, "headers"), out);
      }
    }
  }
}

/** Pure, synchronous structural check of an AsyncAPI 3.0.0 document. */
export function validateAsyncApi3Structure(document: object): Diagnostic[] {
  const doc = document as Obj;
  const out: Diagnostic[] = [];
  checkRoot(doc, out);
  checkRefs(doc, doc, [], out);
  checkServers(doc, out);
  checkChannels(doc, out);
  checkOperations(doc, out);
  checkComponents(doc, out);
  return normalizeDiagnostics(out);
}
