/**
 * Events core — Phase 4a (pure layer). In-memory input/output shapes for the
 * AsyncAPI 3 document assembler (spec §6.1, §7). No Prisma, no IO: the DB-backed
 * resolver (Story 18.4) builds these from Channel / Message / Trait rows later.
 */

export type JsonPrimitive = string | number | boolean | null;
export type JsonValue = JsonPrimitive | JsonValue[] | JsonObject;
export type JsonObject = { [key: string]: JsonValue };

export type PayloadFormat = "avro" | "json-schema" | "protobuf";
export type JsonSchemaDialect = "draft-07" | "2020-12";

/** Spec §1 "Format profile": implementation format + dialect (JSON Schema only). */
export type FormatProfile = { format: PayloadFormat; dialect?: JsonSchemaDialect };

/**
 * One pre-rendered schema in one format profile. Later produced from an
 * `EntityVersionArtifact` (Story 14.5); supplied in memory today.
 * Avro and JSON Schema → object; Protobuf → `.proto` source text.
 */
export type SchemaArtifact = {
  format: PayloadFormat;
  dialect?: JsonSchemaDialect;
  schema: JsonObject | string;
};

// ── Spec §6.1 `EventSpecDocument` — the stored draft shape (IDs, not objects) ──

export type EventSpecInfo = {
  title: string;
  description?: string;
  contact?: JsonObject;
  license?: JsonObject;
  tags?: JsonObject[];
  externalDocs?: JsonObject;
};

export type EventSpecServer = {
  key: string;
  protocol: string;
  host: string;
  pathname?: string;
  protocolVersion?: string;
  description?: string;
  externalRef?: string;
};

export type OperationAction = "send" | "receive";

export type EventSpecOperation = {
  key: string;
  action: OperationAction;
  channelId: string;
  messageVersionIds: string[];
  traitIds: string[];
  summary?: string;
  description?: string;
  bindings?: JsonObject;
  reply?: { channelId?: string; messageVersionIds?: string[] };
};

export type EventSpecLocalComponents = {
  correlationIds?: Record<string, JsonObject>;
  parameters?: Record<string, JsonObject>;
  securitySchemes?: Record<string, JsonObject>;
  operationBindings?: Record<string, JsonObject>;
};

export type EventSpecDocument = {
  info: EventSpecInfo;
  defaultContentType?: string;
  servers: EventSpecServer[];
  operations: EventSpecOperation[];
  components?: EventSpecLocalComponents;
};

// ── Resolved input model consumed by the assembler ──────────────────────────

export type ResolvedChannel = {
  /** Catalog Channel id. */
  id: string;
  name: string;
  /** Owning product slug — qualifies name clashes (`checkout.orders`). */
  productSlug: string;
  /** AsyncAPI allows `null` (address unknown / dynamic). May contain `{param}`. */
  address: string | null;
  protocol: string;
  profile: FormatProfile;
  title?: string;
  summary?: string;
  description?: string;
  parameters?: Record<string, JsonObject>;
  bindings?: JsonObject;
  tags?: JsonObject[];
  externalDocs?: JsonObject;
};

export type ResolvedMessage = {
  /** MessageVersion id (or the Message id for an unpublished draft preview). */
  id: string;
  name: string;
  productSlug: string;
  title?: string;
  summary?: string;
  description?: string;
  contentType?: string;
  correlationId?: JsonObject;
  tags?: JsonObject[];
  externalDocs?: JsonObject;
  bindings?: JsonObject;
  examples?: JsonObject[];
  /** ResolvedTrait ids (kind MESSAGE), authored order. */
  traitRefs: string[];
  /** Payload rendered in every format profile the message may be emitted in. */
  payloads: SchemaArtifact[];
  /** Headers — must be a JSON Schema object schema (spec §7.2 step 3). */
  headers?: SchemaArtifact;
  /** Kafka key renderings (Avro and/or JSON Schema); an Avro key is emitted as a `{ schemaFormat, schema }` Multi Format Schema Object. */
  keys?: SchemaArtifact[];
  /** Draft preview of an unpublished Message (spec §7.2 step 2). */
  unpublished?: boolean;
};

export type TraitKind = "MESSAGE" | "OPERATION";

export type ResolvedTrait = {
  id: string;
  name: string;
  kind: TraitKind;
  /** Slug of the owning level (tenant, domain or product). */
  ownerSlug: string;
  /** AsyncAPI Message Trait / Operation Trait object. */
  spec: JsonObject;
  /** Message-trait headers artifact (e.g. `CloudEventsHeaders@1.0`); wins over `spec.headers`. */
  headers?: SchemaArtifact;
};

export type ResolvedOperation = {
  key: string;
  action: OperationAction;
  /** ResolvedChannel id. */
  channelRef: string;
  /** ResolvedMessage ids, authored order. */
  messageRefs: string[];
  /** ResolvedTrait ids (kind OPERATION), authored order. */
  traitRefs: string[];
  summary?: string;
  description?: string;
  bindings?: JsonObject;
  reply?: { channelRef?: string; messageRefs?: string[] };
};

export type ResolvedEventSpec = {
  /** Slug of the product that owns the Event Spec; its items keep unqualified names. */
  productSlug: string;
  /** `version` is `MAJOR.MINOR` for a published version (spec §6.1). */
  info: EventSpecInfo & { version: string };
  defaultContentType?: string;
  servers: EventSpecServer[];
  operations: ResolvedOperation[];
  channels: ResolvedChannel[];
  messages: ResolvedMessage[];
  traits: ResolvedTrait[];
  components: EventSpecLocalComponents;
};

// ── Diagnostics and adapter results ─────────────────────────────────────────

export type DiagnosticSeverity = "error" | "warning" | "info";

export type Diagnostic = {
  severity: DiagnosticSeverity;
  code: string;
  message: string;
  /** RFC 6901 JSON pointer into the emitted document ("" = document root). */
  pointer: string;
};

/** Spec §7.1 emit result, plus the diagnostics gathered while assembling + validating. */
export type EmitOutput = {
  document: JsonObject;
  json: string;
  yaml: string;
  diagnostics: Diagnostic[];
};

/** Placeholder result of `EventSpecAdapter.import()`; Epic 19 (splitter) extends it. */
export type ImportedEventSpec = {
  document: EventSpecDocument;
  sourceVersion?: string;
  diagnostics: Diagnostic[];
};
