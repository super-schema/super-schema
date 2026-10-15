// src/lib/events/catalog-specs.ts
import { ok, err, type Result } from "@/types/result";
import type { JsonObject } from "@/lib/event-specs/types";
import type { ChannelSpec, MessageSpec } from "./types";
import { isJsonObject } from "./inputs";

/** Reads typed fields off an unknown object, collecting one problem per bad field (spec §10: report together). */
class FieldReader {
  readonly problems: string[] = [];
  private readonly src: Record<string, unknown>;

  constructor(value: unknown, label: string) {
    if (value === undefined || value === null) this.src = {};
    else if (isJsonObject(value)) this.src = value;
    else {
      this.src = {};
      this.problems.push(`${label} must be an object`);
    }
  }

  string(key: string): string | undefined {
    const v = this.src[key];
    if (v === undefined || v === null || v === "") return undefined;
    if (typeof v !== "string") return this.fail(`${key} must be a string`);
    return v;
  }

  object(key: string): JsonObject | undefined {
    const v = this.src[key];
    if (v === undefined || v === null) return undefined;
    return isJsonObject(v) ? v : this.fail(`${key} must be an object`);
  }

  objects(key: string): JsonObject[] | undefined {
    const v = this.src[key];
    if (v === undefined || v === null) return undefined;
    return Array.isArray(v) && v.every(isJsonObject) ? (v as JsonObject[]) : this.fail(`${key} must be an array of objects`);
  }

  objectMap(key: string): Record<string, JsonObject> | undefined {
    const v = this.object(key);
    if (v === undefined) return undefined;
    return Object.values(v).every(isJsonObject) ? (v as Record<string, JsonObject>) : this.fail(`${key} values must be objects`);
  }

  /** Lenient: keeps the string entries; a non-array is a problem. */
  strings(key: string): string[] {
    const v = this.src[key];
    if (v === undefined || v === null) return [];
    if (!Array.isArray(v)) return this.fail(`${key} must be an array of strings`) ?? [];
    const kept = v.filter((x): x is string => typeof x === "string" && x.length > 0);
    if (kept.length !== v.length) this.problems.push(`${key} must contain only non-empty strings`);
    return kept;
  }

  private fail(problem: string): undefined {
    this.problems.push(problem);
    return undefined;
  }
}

function compact<T extends object>(value: T): T {
  return Object.fromEntries(Object.entries(value).filter(([, v]) => v !== undefined)) as T;
}

function readChannel(value: unknown): { spec: ChannelSpec; problems: string[] } {
  const r = new FieldReader(value, "Channel spec");
  const spec = compact<ChannelSpec>({
    title: r.string("title"),
    summary: r.string("summary"),
    description: r.string("description"),
    parameters: r.objectMap("parameters"),
    bindings: r.object("bindings"),
    tags: r.objects("tags"),
    externalDocs: r.object("externalDocs"),
  });
  return { spec, problems: r.problems };
}

function readMessage(value: unknown): { spec: MessageSpec; problems: string[] } {
  const r = new FieldReader(value, "Message spec");
  const spec = compact<MessageSpec>({
    title: r.string("title"),
    summary: r.string("summary"),
    description: r.string("description"),
    contentType: r.string("contentType"),
    correlationId: r.object("correlationId"),
    tags: r.objects("tags"),
    externalDocs: r.object("externalDocs"),
    bindings: r.object("bindings"),
    examples: r.objects("examples"),
    traitIds: r.strings("traitIds"),
  });
  return { spec, problems: r.problems };
}

const invalidSpec = (label: string, problems: string[]) =>
  err({ code: "VALIDATION_ERROR", message: `Invalid ${label}: ${problems.join("; ")}`, details: { problems } });

export function parseChannelSpec(value: unknown): Result<ChannelSpec> {
  const { spec, problems } = readChannel(value);
  return problems.length > 0 ? invalidSpec("channel spec", problems) : ok(spec);
}

export function readChannelSpec(value: unknown): ChannelSpec {
  return readChannel(value).spec;
}

export function parseMessageSpec(value: unknown): Result<MessageSpec> {
  const { spec, problems } = readMessage(value);
  return problems.length > 0 ? invalidSpec("message spec", problems) : ok(spec);
}

export function readMessageSpec(value: unknown): MessageSpec {
  return readMessage(value).spec;
}

const EXAMPLE_KEYS = new Set(["name", "summary", "headers", "payload"]);
const CORRELATION_PREFIXES = ["$message.header#", "$message.payload#"];

// RFC 9110 §8.3.1 media-type = type "/" subtype *( OWS ";" OWS parameter ); parameter = token "=" ( token / quoted-string ).
const TOKEN = "[!#$%&'*+.^_`|~0-9A-Za-z-]+";
const QUOTED_STRING = '"(?:[\\t \\x21\\x23-\\x5B\\x5D-\\x7E\\x80-\\xFF]|\\\\[\\t \\x21-\\x7E\\x80-\\xFF])*"';
const PARAMETER = `${TOKEN}=(?:${TOKEN}|${QUOTED_STRING})`;
const MEDIA_TYPE = new RegExp(`^${TOKEN}/${TOKEN}(?:[\\t ]*;[\\t ]*${PARAMETER})*$`);

/** True for `type/subtype` with optional `; name=value` parameters (quoted values allowed). */
export function isMediaType(value: string): boolean {
  return MEDIA_TYPE.test(value);
}

/** Semantic checks a structurally valid MessageSpec must also pass before publish. */
export function validateMessageSpec(spec: MessageSpec): string[] {
  const problems: string[] = [];
  if (spec.contentType !== undefined && !isMediaType(spec.contentType)) {
    problems.push(`contentType "${spec.contentType}" is not a valid media type (expected type/subtype with optional "; name=value" parameters)`);
  }
  if (spec.correlationId !== undefined) {
    const location = spec.correlationId.location;
    if (typeof location !== "string" || !CORRELATION_PREFIXES.some((p) => location.startsWith(p))) {
      problems.push('correlationId.location must start with "$message.header#" or "$message.payload#"');
    }
  }
  spec.examples?.forEach((example, i) => {
    for (const key of Object.keys(example)) {
      if (!EXAMPLE_KEYS.has(key)) problems.push(`examples[${i}] has unsupported key "${key}" (allowed: name, summary, headers, payload)`);
    }
  });
  const seen = new Set<string>();
  for (const id of spec.traitIds) {
    if (seen.has(id)) problems.push(`trait "${id}" is listed more than once`);
    seen.add(id);
  }
  return problems;
}
