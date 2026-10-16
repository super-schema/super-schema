// src/lib/events/document/types.ts
// Event document v2 (spec 2026-10-15-events-self-contained-design §4). Pure types — client-safe.
import type {
  AsyncApiExternalDocs, AsyncApiReplyAddress, AsyncApiServerVariable, AsyncApiTag, EventSpecInfo, JsonObject, JsonSchemaDialect, JsonValue,
  OperationAction, PayloadFormat, TraitKind,
} from "@/lib/event-specs/types";
import type { EntityPin } from "@/lib/events/types";

export const DOCUMENT_VERSION = 2 as const;
/** Every local key (`servers[]`, `channels[]`, `messages[]`, …) — the AsyncAPI components key rule. */
export const KEY_PATTERN = /^[a-zA-Z0-9._-]+$/;
export const KEY_MAX_LENGTH = 64;

/** Present on infra-owned items synced from a provider; absent = typed by hand. */
export interface Origin { provider: string; ref: string; syncedAt: string }

// Leaf shapes are type aliases (not interfaces) on purpose: they stay assignable to `JsonObject`, so UI code that edits them
// as JSON keeps compiling.
/** AsyncAPI External Documentation Object. `url` is an absolute http(s) URL. */
export type DocExternalDocs = AsyncApiExternalDocs;
/** AsyncAPI Tag Object. */
export type DocTag = AsyncApiTag;
export type DocServerVariable = AsyncApiServerVariable;
/** Channel parameter (AsyncAPI Parameter Object). `location` is a runtime expression: `$message.header#/…` or `$message.payload#/…`. */
export type DocChannelParameter = { description?: string; enum?: string[]; default?: string; examples?: string[]; location?: string };
/** Message correlation id. `location` is a runtime expression (`$message.header#/…` or `$message.payload#/…`). */
export type DocCorrelationId = { location: string; description?: string };
/** Message example: AsyncAPI requires `headers` or `payload`. */
export type DocMessageExample = { name?: string; summary?: string; headers?: JsonObject; payload?: JsonValue };
/** Where an operation's reply is sent, as a runtime expression on the request message. */
export type DocReplyAddress = AsyncApiReplyAddress;

export const SECURITY_SCHEME_TYPES = [
  "userPassword", "apiKey", "X509", "symmetricEncryption", "asymmetricEncryption", "httpApiKey", "http", "oauth2", "openIdConnect",
  "plain", "scramSha256", "scramSha512", "gssapi",
] as const;
export type DocSecuritySchemeType = (typeof SECURITY_SCHEME_TYPES)[number];
/**
 * AsyncAPI Security Scheme Object. Type-specific fields: `apiKey` → `in` ("user" | "password"); `httpApiKey` → `name`, `in`
 * ("header" | "query" | "cookie"); `http` → `scheme` (+ `bearerFormat` when "bearer"); `oauth2` → `flows` (+ `scopes`);
 * `openIdConnect` → `openIdConnectUrl` (+ `scopes`). The parser validates them.
 */
export type DocSecurityScheme = { type: DocSecuritySchemeType; description?: string; [typeSpecific: string]: unknown };

/** Keys a local trait's `spec` may carry, per kind (AsyncAPI Message Trait / Operation Trait Object); `x-…` extensions are always allowed. */
export const MESSAGE_TRAIT_SPEC_KEYS = [
  "name", "title", "summary", "description", "contentType", "correlationId", "tags", "externalDocs", "deprecated", "examples", "bindings",
  "headers", // an inline headers schema; a pinned headers entity (`DocTrait.headers`) wins over it
] as const;
export const OPERATION_TRAIT_SPEC_KEYS = ["title", "summary", "description", "security", "tags", "externalDocs", "bindings"] as const;

export interface DocServer {
  key: string; protocol: string; host: string; pathname?: string; protocolVersion?: string; description?: string; externalRef?: string; origin?: Origin;
  title?: string; summary?: string;
  /** Every key must appear as `{name}` in `host` or `pathname`. */
  variables?: Record<string, DocServerVariable>;
  /** Keys of `components.securitySchemes`. */
  security?: string[];
  tags?: DocTag[]; externalDocs?: DocExternalDocs; bindings?: JsonObject;
}
export interface DocChannel {
  key: string; address: string | null; protocol: string; serverKeys: string[]; bindings?: JsonObject; origin?: Origin;
  /**
   * An explicit wire format for every message on this channel. Absent = follow the messages: each message's own
   * `representation`, else its entity's recorded source format, else the protocol default (see `resolveRepresentations`).
   */
  format?: PayloadFormat;
  /** The JSON Schema dialect used for json-schema payloads on this channel (draft-07 when absent). */
  formatDialect?: JsonSchemaDialect;
  title?: string; summary?: string; description?: string; parameters?: Record<string, DocChannelParameter>; tags?: DocTag[]; externalDocs?: DocExternalDocs;
  messageKeys: string[];
}
export interface DocMessage {
  key: string; name?: string; title?: string; summary?: string; description?: string; contentType?: string; correlationId?: DocCorrelationId;
  tags?: DocTag[]; externalDocs?: DocExternalDocs; deprecated?: boolean; bindings?: JsonObject; examples?: DocMessageExample[];
  /**
   * The schema representation this message is emitted in. Absent = Auto: the channel's explicit `format` when it sets one, else the
   * payload entity's recorded source format, else the protocol default (Kafka → Avro, everything else → JSON Schema).
   */
  representation?: PayloadFormat;
  payload: EntityPin; headers?: EntityPin; keyPin?: EntityPin; traitKeys: string[];
}
export type DocTrait =
  | { key: string; kind: TraitKind; spec: JsonObject; headers?: EntityPin }
  | { key: string; kind: TraitKind; libraryTraitId: string };
export interface DocOperation {
  key: string; action: OperationAction; channelKey: string; messageKeys: string[]; traitKeys: string[];
  title?: string; summary?: string; description?: string;
  /** Keys of `components.securitySchemes`. */
  security?: string[];
  tags?: DocTag[]; externalDocs?: DocExternalDocs; bindings?: JsonObject;
  reply?: { address?: DocReplyAddress; channelKey?: string; messageKeys?: string[] };
}
export interface DocExternalRef { key: string; eventVersionId: string; kind: "channel" | "message"; itemKey: string }
export interface DocComponents { correlationIds?: Record<string, JsonObject>; parameters?: Record<string, JsonObject>; securitySchemes?: Record<string, DocSecurityScheme> }
export interface EventDocument {
  documentVersion: 2; info: EventSpecInfo; defaultContentType?: string;
  servers: DocServer[]; channels: DocChannel[]; messages: DocMessage[]; traits: DocTrait[];
  operations: DocOperation[]; externalRefs: DocExternalRef[]; components?: DocComponents;
}
/** `pointer` is an RFC 6901 JSON Pointer into the draft document ("" = the document itself). */
export interface DocumentProblem { pointer: string; message: string }

export function emptyEventDocument(title: string, description?: string): EventDocument {
  return {
    documentVersion: DOCUMENT_VERSION,
    info: description === undefined ? { title } : { title, description },
    servers: [], channels: [], messages: [], traits: [], operations: [], externalRefs: [],
  };
}

export const isLibraryTrait = (t: DocTrait): t is Extract<DocTrait, { libraryTraitId: string }> => "libraryTraitId" in t;
