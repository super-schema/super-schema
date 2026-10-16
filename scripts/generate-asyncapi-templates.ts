// scripts/generate-asyncapi-templates.ts
// Generates src/lib/events/templates/bindings.generated.ts: one form template per AsyncAPI protocol binding and target,
// read from the JSON Schemas shipped in `@asyncapi/specs` (a transitive dependency of @asyncapi/parser).
//
//   npm run gen:asyncapi-templates
//
// The generated file is committed and plain TypeScript (no runtime dependency on the package); a unit test regenerates it
// in memory and fails while the committed file is stale. This module is also imported by the tests, so everything except
// the final `main()` is side-effect free.
import fs from "node:fs";
import path from "node:path";
import { createRequire } from "node:module";
import { fileURLToPath, pathToFileURL } from "node:url";
import type { BindingTarget, FieldKind, FieldTemplate } from "../src/lib/events/templates/types";

// ---------------------------------------------------------------------------------------------------------------
// JSON Schema -> FieldTemplate
// ---------------------------------------------------------------------------------------------------------------

export interface JsonSchema {
  $ref?: string;
  type?: string | string[];
  description?: string;
  enum?: unknown[];
  const?: unknown;
  default?: unknown;
  examples?: unknown[];
  format?: string;
  properties?: Record<string, JsonSchema>;
  required?: string[];
  additionalProperties?: boolean | JsonSchema;
  items?: JsonSchema;
  oneOf?: JsonSchema[];
  anyOf?: JsonSchema[];
  allOf?: JsonSchema[];
  definitions?: Record<string, JsonSchema>;
  [keyword: string]: unknown;
}

export interface SchemaToFieldsOptions {
  /** The schema `#/definitions/...` references resolve against (default: the schema itself). */
  root?: JsonSchema;
}

interface Ctx {
  root: JsonSchema;
  /** Definitions being expanded on the way down, so a self-referencing definition ends in `json` instead of looping. */
  trail: ReadonlySet<string>;
}

interface Shape {
  kind: FieldKind;
  options?: Array<{ value: string; label: string }>;
  suggestions?: string[];
  fields?: FieldTemplate[];
}

interface Property { schema: JsonSchema; ctx: Ctx }
interface Collected { props: Map<string, Property>; required: Set<string> }

const MAX_HELP = 240;
const MAX_EXAMPLE = 200;
const BASICS_WHEN_NOTHING_REQUIRED = 4;
const ACRONYMS = new Map(["id", "url", "uri", "ttl", "tls", "ssl", "api", "http", "mqtt", "jms", "sns", "sqs", "ip", "aws", "iam", "arn", "dlq"].map((a) => [a, a.toUpperCase()]));
ACRONYMS.set("qos", "QoS");

/** `topicConfiguration` -> "Topic configuration", `clientID` -> "Client ID", `cleanup.policy` -> "Cleanup policy". */
export function humanize(key: string): string {
  const words = key.replace(/([a-z0-9])([A-Z])/g, "$1 $2").split(/[^A-Za-z0-9]+/).filter(Boolean);
  return words
    .map((word, index) => {
      const acronym = ACRONYMS.get(word.toLowerCase());
      if (acronym) return acronym;
      if (word.length > 1 && word === word.toUpperCase() && /[A-Z]/.test(word)) return word;
      const lower = word.toLowerCase();
      return index === 0 ? lower.charAt(0).toUpperCase() + lower.slice(1) : lower;
    })
    .join(" ");
}

/** The spec's description, with markdown links reduced to their text, whitespace collapsed and long text shortened. */
function toHelp(description: string | undefined): string | undefined {
  if (!description) return undefined;
  const text = description.replace(/\[([^\]]+)\]\([^)]*\)/g, "$1").replace(/\s+/g, " ").trim();
  if (!text) return undefined;
  if (text.length <= MAX_HELP) return text;
  const cut = text.slice(0, MAX_HELP - 1);
  const sentenceEnd = cut.lastIndexOf(". ");
  if (sentenceEnd >= 80) return cut.slice(0, sentenceEnd + 1);
  const space = cut.lastIndexOf(" ");
  return `${cut.slice(0, space > 0 ? space : cut.length).trimEnd()}…`;
}

function localDefinitionName(ref: string): string | null {
  const marker = "#/definitions/";
  const at = ref.indexOf(marker);
  return at === -1 ? null : ref.slice(at + marker.length);
}

/**
 * Follows `$ref`s that point into the same file. `null` means "opaque": a reference to the shared AsyncAPI schema or
 * Reference definitions (those are free-form JSON, so the field becomes `json`), an unknown reference, or a cycle.
 */
function deref(schema: JsonSchema, ctx: Ctx): { schema: JsonSchema | null; ctx: Ctx } {
  let current = schema;
  let trail = ctx.trail;
  while (current.$ref !== undefined) {
    const name = localDefinitionName(current.$ref);
    const target = name === null ? undefined : ctx.root.definitions?.[name];
    if (name === null || target === undefined || trail.has(name)) return { schema: null, ctx };
    trail = new Set(trail).add(name);
    current = target;
  }
  return { schema: current, ctx: trail === ctx.trail ? ctx : { ...ctx, trail } };
}

const literalValues = (schema: JsonSchema): unknown[] | null => (Array.isArray(schema.enum) ? schema.enum : schema.const !== undefined ? [schema.const] : null);

function mergeProperty(into: Map<string, Property>, key: string, incoming: Property): void {
  const existing = into.get(key);
  if (!existing) { into.set(key, incoming); return; }
  // Alternatives that differ only by a constant (solace destinationType: queue | topic) become one enum.
  const a = literalValues(existing.schema);
  const b = literalValues(incoming.schema);
  if (a && b) {
    const merged: JsonSchema = { ...existing.schema, enum: [...new Set([...a, ...b])] };
    delete merged.const;
    into.set(key, { ...existing, schema: merged });
  }
}

/**
 * The properties of an object schema, including those contributed through `allOf`, and those that only exist inside
 * `oneOf`/`anyOf` branches. `required` comes from the schema itself and `allOf`, never from a branch: a branch's
 * `required` only applies when that branch is the one that matched.
 */
function collect(schema: JsonSchema, ctx: Ctx, into: Collected, branch: boolean): void {
  const resolved = deref(schema, ctx);
  if (!resolved.schema) return;
  const s = resolved.schema;
  for (const [key, property] of Object.entries(s.properties ?? {})) mergeProperty(into.props, key, { schema: property, ctx: resolved.ctx });
  if (!branch) for (const key of s.required ?? []) into.required.add(key);
  for (const part of s.allOf ?? []) collect(part, resolved.ctx, into, branch);
  for (const part of [...(s.oneOf ?? []), ...(s.anyOf ?? [])]) collect(part, resolved.ctx, into, true);
}

function collectProperties(schema: JsonSchema, ctx: Ctx): Collected {
  const into: Collected = { props: new Map(), required: new Set() };
  collect(schema, ctx, into, false);
  return into;
}

/** JSON `type` as a list without "null". */
function typesOf(schema: JsonSchema): string[] {
  const list = Array.isArray(schema.type) ? schema.type : schema.type === undefined ? [] : [schema.type];
  return list.filter((t) => t !== "null");
}

const SCALAR_KIND: Record<string, FieldKind> = { string: "text", integer: "integer", number: "integer", boolean: "boolean" };
const scalarKind = (type: string): FieldKind | undefined => (Object.hasOwn(SCALAR_KIND, type) ? SCALAR_KIND[type] : undefined);

function mapSchema(raw: JsonSchema, ctx: Ctx, example: unknown): Shape {
  const resolved = deref(raw, ctx);
  if (!resolved.schema) return { kind: "json" };
  const schema = resolved.schema;
  const c = resolved.ctx;
  const hasOwnStructure = schema.type !== undefined || schema.properties !== undefined || schema.allOf !== undefined || literalValues(schema) !== null;
  const choices = schema.oneOf ?? schema.anyOf;

  // A choice between a plain value and "a schema or a reference to one" (MQTT, Kafka, ...) is just the plain value.
  if (!hasOwnStructure && choices) {
    const concrete = choices.map((choice) => deref(choice, c)).filter((r): r is { schema: JsonSchema; ctx: Ctx } => r.schema !== null);
    return concrete.length === 1 ? mapSchema(concrete[0].schema, concrete[0].ctx, example) : { kind: "json" };
  }

  const literals = literalValues(schema);
  if (literals && literals.every((v) => typeof v === "string")) {
    return { kind: "enum", options: (literals as string[]).map((value) => ({ value, label: humanize(value) })) };
  }

  const types = typesOf(schema);
  const inferredObject = types.length === 0 && (schema.properties !== undefined || schema.allOf !== undefined || choices !== undefined);
  if (types.length > 1) {
    // ["integer", "number"] is still an integer field; a mix such as string | boolean | number cannot be one control.
    const kinds = new Set(types.map((t) => scalarKind(t)));
    const only = kinds.size === 1 ? [...kinds][0] : undefined;
    return { kind: only ?? "json" };
  }
  const type = inferredObject ? "object" : types[0];

  if (type !== undefined && scalarKind(type)) return { kind: scalarKind(type)! };
  if (type === "array") return mapArray(schema, c);
  if (type === "object") return mapObject(schema, c, example);
  return { kind: "json" };
}

function mapArray(schema: JsonSchema, ctx: Ctx): Shape {
  if (!schema.items) return { kind: "json" };
  const resolved = deref(schema.items, ctx);
  if (!resolved.schema) return { kind: "json" };
  const item = resolved.schema;
  const itemTypes = typesOf(item);
  if (itemTypes.length === 1 && itemTypes[0] === "string" && !item.oneOf && !item.anyOf) {
    const allowed = literalValues(item);
    return allowed && allowed.every((v) => typeof v === "string") ? { kind: "stringList", suggestions: allowed as string[] } : { kind: "stringList" };
  }
  const collected = collectProperties(item, resolved.ctx);
  if (collected.props.size > 0) return { kind: "list", fields: buildFields(collected, undefined, false) };
  return { kind: "json" };
}

function mapObject(schema: JsonSchema, ctx: Ctx, example: unknown): Shape {
  const collected = collectProperties(schema, ctx);
  if (collected.props.size > 0) return { kind: "object", fields: buildFields(collected, example, false) };
  const extra = schema.additionalProperties;
  if (extra === undefined || extra === true) return { kind: "keyValue" };
  if (extra === false) return { kind: "json" };
  const valueKind = mapSchema(extra, ctx, undefined).kind;
  return valueKind === "text" || valueKind === "integer" || valueKind === "boolean" || valueKind === "enum" ? { kind: "keyValue" } : { kind: "json" };
}

/** A short text for the field's `example`; containers get none (their children carry their own), nor does an example too long to read. */
function exampleText(value: unknown, kind: FieldKind): string | undefined {
  if (value === undefined || value === null || kind === "object" || kind === "list") return undefined;
  const text =
    kind === "json" || kind === "keyValue" ? JSON.stringify(value)
    : kind === "stringList" ? (Array.isArray(value) ? value.map(String).join(", ") : undefined)
    : typeof value === "object" ? undefined : String(value);
  return text !== undefined && text.length <= MAX_EXAMPLE ? text : undefined;
}

function buildFields(collected: Collected, parentExample: unknown, top: boolean): FieldTemplate[] {
  const fields: FieldTemplate[] = [];
  for (const [key, property] of collected.props) {
    if (top && key === "bindingVersion") continue; // set automatically from the version the template was generated from
    const resolved = deref(property.schema, property.ctx);
    const own = resolved.schema;
    const ownExamples = property.schema.examples ?? own?.examples;
    const exampleValue = ownExamples?.[0] ?? (isRecord(parentExample) ? parentExample[key] : undefined);
    const shape = mapSchema(property.schema, property.ctx, exampleValue);
    const help = toHelp(property.schema.description ?? own?.description);
    const fallback = property.schema.default ?? own?.default;
    const example = exampleText(exampleValue, shape.kind);
    fields.push({
      key,
      label: humanize(key),
      kind: shape.kind,
      ...(collected.required.has(key) ? { required: true } : {}),
      ...(help !== undefined ? { help } : {}),
      ...(example !== undefined ? { example } : {}),
      ...(typeof fallback === "string" || typeof fallback === "number" || typeof fallback === "boolean" ? { default: fallback } : {}),
      ...(shape.options ? { options: shape.options } : {}),
      ...(shape.suggestions ? { suggestions: shape.suggestions } : {}),
      ...(shape.fields ? { fields: shape.fields } : {}),
      group: "more",
    });
  }
  // Required keys are the basics; when nothing is required the first few keys are (so the form is not all collapsed).
  const anyRequired = fields.some((f) => f.required);
  fields.forEach((f, index) => { f.group = anyRequired ? (f.required ? "basics" : "more") : index < BASICS_WHEN_NOTHING_REQUIRED ? "basics" : "more"; });
  return fields;
}

const isRecord = (value: unknown): value is Record<string, unknown> => typeof value === "object" && value !== null && !Array.isArray(value);

/** The form fields for an object schema (a binding schema, or any object schema). `bindingVersion` is omitted. */
export function schemaToFields(schema: JsonSchema, options: SchemaToFieldsOptions = {}): FieldTemplate[] {
  const ctx: Ctx = { root: options.root ?? schema, trail: new Set() };
  const resolved = deref(schema, ctx);
  if (!resolved.schema) return [];
  const collected = collectProperties(resolved.schema, resolved.ctx);
  return buildFields(collected, resolved.schema.examples?.[0], true);
}

// ---------------------------------------------------------------------------------------------------------------
// Curated overrides (Kafka, Google Pub/Sub, Pulsar)
// ---------------------------------------------------------------------------------------------------------------

export interface FieldOverride {
  label?: string;
  help?: string;
  group?: "basics" | "more";
  placeholder?: string;
  example?: string;
  suggestions?: string[];
}

/** Canonical key order, so the generated file is stable however a field was assembled. */
function orderField(field: FieldTemplate): FieldTemplate {
  const { key, label, kind, required, help, placeholder, example, default: fallback, options, suggestions, fields, group } = field;
  return {
    key, label, kind,
    ...(required ? { required } : {}),
    ...(help !== undefined ? { help } : {}),
    ...(placeholder !== undefined ? { placeholder } : {}),
    ...(example !== undefined ? { example } : {}),
    ...(fallback !== undefined ? { default: fallback } : {}),
    ...(options ? { options } : {}),
    ...(suggestions ? { suggestions } : {}),
    ...(fields ? { fields: fields.map(orderField) } : {}),
    group,
  };
}

/** Finds `a.b.c` in a field tree. Keys may themselves contain dots (`cleanup.policy`), so every split point is tried. */
function findField(fields: FieldTemplate[], pathText: string): FieldTemplate | undefined {
  for (const field of fields) {
    if (pathText === field.key) return field;
    if (field.fields && pathText.startsWith(`${field.key}.`)) {
      const inner = findField(field.fields, pathText.slice(field.key.length + 1));
      if (inner) return inner;
    }
  }
  return undefined;
}

/**
 * Applies the hand-written overrides for one protocol and target (`protocol.target.key[.nestedKey]`). Returns a copy.
 * An override whose property does not exist throws, so a renamed property can never leave a dead override behind.
 */
export function applyFieldOverrides(fields: FieldTemplate[], overrides: Record<string, FieldOverride>, protocol: string, target: BindingTarget): FieldTemplate[] {
  const next = structuredClone(fields);
  const prefix = `${protocol}.${target}.`;
  for (const [overridePath, override] of Object.entries(overrides)) {
    if (!overridePath.startsWith(prefix)) continue;
    const field = findField(next, overridePath.slice(prefix.length));
    if (!field) throw new Error(`Override "${overridePath}" does not match any ${protocol} ${target} binding property`);
    for (const [key, value] of Object.entries(override)) if (value !== undefined) (field as unknown as Record<string, unknown>)[key] = value;
  }
  return next.map(orderField);
}

/** Hand-written labels, help and groups; everything not listed here is humanised from the schema. */
export const FIELD_OVERRIDES: Record<string, FieldOverride> = {
  // Kafka
  "kafka.server.schemaRegistryUrl": { label: "Schema registry URL", help: "Address of the schema registry used when producing messages, if you use one.", group: "basics", placeholder: "https://schema-registry.example.com" },
  "kafka.server.schemaRegistryVendor": { label: "Schema registry vendor", help: "Which registry product and serializer library clients should use.", group: "basics", suggestions: ["confluent", "apicurio"] },
  "kafka.channel.topic": { label: "Topic name", help: "The Kafka topic, when it differs from the channel address.", group: "basics" },
  "kafka.channel.partitions": { label: "Partitions", help: "How many partitions the topic has.", group: "basics" },
  "kafka.channel.replicas": { label: "Replicas", help: "How many copies of each partition the cluster keeps (the replication factor).", group: "basics" },
  "kafka.channel.topicConfiguration": { label: "Topic settings", help: "Kafka topic settings that matter to the people producing or consuming this topic.", group: "more" },
  "kafka.channel.topicConfiguration.cleanup.policy": { label: "Cleanup policy", help: "Whether old records are deleted, compacted (only the latest record per key is kept), or both.", group: "basics" },
  "kafka.channel.topicConfiguration.retention.ms": { label: "Retention (ms)", help: "How long records are kept, in milliseconds. -1 keeps them forever.", group: "basics" },
  "kafka.channel.topicConfiguration.retention.bytes": { label: "Retention (bytes)", help: "How much data each partition keeps before old records are removed. -1 means no limit.", group: "basics" },
  "kafka.channel.topicConfiguration.delete.retention.ms": { label: "Delete retention (ms)", help: "How long deletion markers are kept on a compacted topic, in milliseconds.", group: "more" },
  "kafka.channel.topicConfiguration.max.message.bytes": { label: "Max message size (bytes)", help: "The largest record the topic accepts, in bytes.", group: "basics" },
  "kafka.channel.topicConfiguration.confluent.key.schema.validation": { label: "Validate key schema (Confluent)", help: "Whether the broker checks message keys against the registered schema. Confluent only.", group: "more" },
  "kafka.channel.topicConfiguration.confluent.key.subject.name.strategy": { label: "Key subject name strategy (Confluent)", help: "How the key schema's registry subject is named. Confluent only.", group: "more" },
  "kafka.channel.topicConfiguration.confluent.value.schema.validation": { label: "Validate value schema (Confluent)", help: "Whether the broker checks message values against the registered schema. Confluent only.", group: "more" },
  "kafka.channel.topicConfiguration.confluent.value.subject.name.strategy": { label: "Value subject name strategy (Confluent)", help: "How the value schema's registry subject is named. Confluent only.", group: "more" },
  "kafka.operation.groupId": { label: "Consumer group ID", help: "Identifies the consumer group. Written as a JSON Schema, so a fixed name looks like the example.", group: "basics" },
  "kafka.operation.clientId": { label: "Client ID", help: "Identifies this consumer inside its group. Written as a JSON Schema, so a fixed name looks like the example.", group: "basics" },
  "kafka.message.key": { label: "Message key", help: "The schema of the record key, written as JSON Schema.", group: "basics" },
  "kafka.message.schemaIdLocation": { label: "Schema ID location", help: "Where the schema registry's schema ID travels: in a header or in the payload.", group: "basics" },
  "kafka.message.schemaIdPayloadEncoding": { label: "Schema ID encoding", help: "When the ID is in the payload: the number of bytes, or a vendor value such as apicurio-new.", group: "more", suggestions: ["confluent", "apicurio-legacy", "apicurio-new"] },
  "kafka.message.schemaLookupStrategy": { label: "Schema lookup strategy", help: "The naming strategy class used to find the schema in the registry. Leave empty for the vendor default.", group: "more", suggestions: ["TopicIdStrategy", "RecordIdStrategy", "TopicRecordIdStrategy"] },

  // Google Pub/Sub
  "googlepubsub.channel.labels": { label: "Labels", help: "Labels attached to the topic, as names and values.", group: "more" },
  "googlepubsub.channel.messageRetentionDuration": { label: "Message retention duration", help: "How long Pub/Sub keeps published messages, as a duration such as 86400s.", group: "more", placeholder: "86400s" },
  "googlepubsub.channel.messageStoragePolicy": { label: "Message storage policy", help: "Restricts the regions where Pub/Sub may store messages.", group: "more" },
  "googlepubsub.channel.messageStoragePolicy.allowedPersistenceRegions": { label: "Allowed regions", help: "Regions where messages may be stored, for example us-central1.", group: "basics" },
  "googlepubsub.channel.schemaSettings": { label: "Schema settings", help: "The Pub/Sub schema that messages on this topic are validated against.", group: "basics" },
  "googlepubsub.channel.schemaSettings.encoding": { label: "Encoding", help: "How messages are encoded against the schema: json or binary.", group: "basics", suggestions: ["json", "binary"] },
  "googlepubsub.channel.schemaSettings.name": { label: "Schema name", help: "The full resource name of the schema.", group: "basics", placeholder: "projects/my-project/schemas/my-schema" },
  "googlepubsub.channel.schemaSettings.firstRevisionId": { label: "First revision ID", help: "The oldest schema revision that messages may use.", group: "more" },
  "googlepubsub.channel.schemaSettings.lastRevisionId": { label: "Last revision ID", help: "The newest schema revision that messages may use.", group: "more" },
  "googlepubsub.message.attributes": { label: "Attributes", help: "Names and values attached to each message.", group: "more" },
  "googlepubsub.message.orderingKey": { label: "Ordering key", help: "Messages that share an ordering key are delivered in the order they were published.", group: "basics" },
  "googlepubsub.message.schema": { label: "Schema", help: "The Pub/Sub schema the message payload follows.", group: "basics" },
  "googlepubsub.message.schema.name": { label: "Schema name", help: "The full resource name of the schema.", group: "basics", placeholder: "projects/my-project/schemas/my-schema" },

  // Pulsar
  "pulsar.server.tenant": { label: "Tenant", help: "The Pulsar tenant. When left empty, public is assumed.", group: "basics", placeholder: "public" },
  "pulsar.channel.namespace": { label: "Namespace", help: "The Pulsar namespace this topic belongs to.", group: "basics" },
  "pulsar.channel.persistence": { label: "Persistence", help: "Whether messages are stored durably (persistent) or only kept in memory (non-persistent).", group: "basics" },
  "pulsar.channel.compaction": { label: "Compaction threshold (MB)", help: "The topic compaction threshold, in megabytes.", group: "more" },
  "pulsar.channel.geo-replication": { label: "Geo-replication clusters", help: "The clusters the topic is replicated to.", group: "more" },
  "pulsar.channel.retention": { label: "Retention", help: "How long and how much data the topic keeps after messages are acknowledged.", group: "more" },
  "pulsar.channel.retention.time": { label: "Retention time (minutes)", help: "Minutes to keep messages. 0 turns retention off.", group: "basics" },
  "pulsar.channel.retention.size": { label: "Retention size (MB)", help: "Megabytes to keep. 0 turns retention off.", group: "basics" },
  "pulsar.channel.ttl": { label: "Message TTL (seconds)", help: "Seconds after which unacknowledged messages expire.", group: "more" },
  "pulsar.channel.deduplication": { label: "Deduplication", help: "Whether the topic discards duplicate messages.", group: "more" },
};

// ---------------------------------------------------------------------------------------------------------------
// Reading @asyncapi/specs
// ---------------------------------------------------------------------------------------------------------------

export interface GeneratedBinding { version: string; fields: FieldTemplate[] }
export type GeneratedBindings = Record<string, Partial<Record<BindingTarget, GeneratedBinding>>>;

export const BINDING_TARGETS: readonly BindingTarget[] = ["server", "channel", "operation", "message"];
/** The binding directory name when it differs from the key used in an AsyncAPI document's `bindings` object. */
const DIRECTORY_TO_PROTOCOL: Record<string, string> = { websockets: "ws" };

const compareVersions = (a: string, b: string) => {
  const [x, y] = [a, b].map((v) => v.split(".").map(Number));
  for (let i = 0; i < Math.max(x.length, y.length); i++) if ((x[i] ?? 0) !== (y[i] ?? 0)) return (x[i] ?? 0) - (y[i] ?? 0);
  return 0;
};

const directories = (dir: string) => fs.readdirSync(dir, { withFileTypes: true }).filter((e) => e.isDirectory()).map((e) => e.name);

/** Default location of the installed `@asyncapi/specs` package. */
export function defaultSpecsRoot(): string {
  return path.dirname(createRequire(import.meta.url).resolve("@asyncapi/specs"));
}

/** For every protocol and target, the template generated from the highest binding version that defines that target. */
export function generateBindingTemplates(specsRoot: string, overrides: Record<string, FieldOverride> = FIELD_OVERRIDES): GeneratedBindings {
  const bindingsDir = path.join(specsRoot, "bindings");
  // Pass 1: the highest version that defines each protocol/target (a directory with no schema files is skipped).
  const latest: Record<string, Partial<Record<BindingTarget, { version: string; file: string }>>> = {};
  for (const directory of directories(bindingsDir)) {
    const protocol = DIRECTORY_TO_PROTOCOL[directory] ?? directory;
    for (const version of directories(path.join(bindingsDir, directory)).sort(compareVersions)) {
      for (const target of BINDING_TARGETS) {
        const file = path.join(bindingsDir, directory, version, `${target}.json`);
        if (fs.existsSync(file)) (latest[protocol] ??= {})[target] = { version, file }; // later (higher) versions replace earlier ones
      }
    }
  }
  // Pass 2: generate from those files only (the overrides are written against the latest schemas).
  const out: GeneratedBindings = {};
  for (const protocol of Object.keys(latest).sort()) {
    for (const target of BINDING_TARGETS) {
      const entry = latest[protocol][target];
      if (!entry) continue;
      const schema = JSON.parse(fs.readFileSync(entry.file, "utf8")) as JsonSchema;
      (out[protocol] ??= {})[target] = { version: entry.version, fields: applyFieldOverrides(schemaToFields(schema), overrides, protocol, target) };
    }
  }
  for (const overridePath of Object.keys(overrides)) {
    const [protocol, target] = overridePath.split(".");
    if (!out[protocol]?.[target as BindingTarget]) throw new Error(`Override "${overridePath}" names a binding that does not exist`);
  }
  return out;
}

export function renderBindingsModule(data: GeneratedBindings, specsVersion: string): string {
  return [
    "// AUTO-GENERATED by scripts/generate-asyncapi-templates.ts from @asyncapi/specs. Do not edit by hand.",
    "// Regenerate with `npm run gen:asyncapi-templates`; a unit test fails while this file is stale.",
    'import type { BindingTarget, FieldTemplate } from "./types";',
    "",
    `export const GENERATED_FROM = "@asyncapi/specs@${specsVersion}";`,
    "",
    "export interface GeneratedBinding { version: string; fields: FieldTemplate[] }",
    "",
    `export const GENERATED_BINDINGS: Record<string, Partial<Record<BindingTarget, GeneratedBinding>>> = ${JSON.stringify(data, null, 2)};`,
    "",
  ].join("\n");
}

const readSpecsVersion = (specsRoot: string) => (JSON.parse(fs.readFileSync(path.join(specsRoot, "package.json"), "utf8")) as { version: string }).version;

/** The full text of `bindings.generated.ts` for the given `@asyncapi/specs` installation. */
export function generateBindingsModule(specsRoot: string = defaultSpecsRoot()): string {
  return renderBindingsModule(generateBindingTemplates(specsRoot), readSpecsVersion(specsRoot));
}

// ---------------------------------------------------------------------------------------------------------------

function main(): void {
  const output = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "../src/lib/events/templates/bindings.generated.ts");
  const specsRoot = defaultSpecsRoot();
  const data = generateBindingTemplates(specsRoot);
  const text = renderBindingsModule(data, readSpecsVersion(specsRoot));
  fs.writeFileSync(output, text);
  const templates = Object.values(data).reduce((n, targets) => n + Object.keys(targets).length, 0);
  console.log(`Wrote ${path.relative(process.cwd(), output)}: ${templates} binding templates for ${Object.keys(data).length} protocols (${(text.length / 1024).toFixed(0)} KB)`);
}

if (process.argv[1] && import.meta.url === pathToFileURL(path.resolve(process.argv[1])).href) main();
