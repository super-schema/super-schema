// src/lib/events/import/types.ts
// Shared shapes of the AsyncAPI 3.0 importer's pure layer (source parsing, payload extraction, mapping to an event document).
// Pure — client-safe: nothing in `src/lib/events/import/**` may import a server-only module or anything from `src/features`.
import type { EntityPin } from "@/lib/events/types";

/**
 * What the importer tells the user it had to change or leave out. The codes are the ones the importer UI groups by.
 * - UNSUPPORTED_PAYLOAD_FORMAT / NO_PAYLOAD: a message whose payload cannot become an entity (it gets a placeholder).
 * - UNSUPPORTED_EXTENSION: an `x-…` extension the event document has no place for (it is not imported).
 * - DROPPED_CONSTRUCT: a part of the file the event document cannot hold (an unsupported security scheme, an unused component, …).
 * - ENTITY_RENAMED: a payload entity got a numeric suffix because its name was taken (reported by the persisting step).
 * - BUILTIN_TRAIT_MAPPED: a message trait was replaced by a built-in library trait (CloudEvents, W3C Trace Context).
 * - KEY_ADJUSTED: a key was not usable as a document key (or was taken), so a valid one was generated.
 * - SANITIZED_VALUE: a value the event document rejects (an unknown property, a wrong type, a blank required field) was removed.
 */
export type ImportWarningCode =
  | "UNSUPPORTED_PAYLOAD_FORMAT" | "NO_PAYLOAD" | "UNSUPPORTED_EXTENSION" | "DROPPED_CONSTRUCT" | "ENTITY_RENAMED"
  | "BUILTIN_TRAIT_MAPPED" | "KEY_ADJUSTED" | "SANITIZED_VALUE";

/** `pointer` is an RFC 6901 JSON Pointer into the SOURCE file ("" = the document itself). */
export interface ImportWarning { pointer: string; code: ImportWarningCode; message: string }

/** The error codes this layer returns (as `ServiceError.code`). */
export type ImportErrorCode =
  | "PARSE_ERROR" | "UNSUPPORTED_VERSION" | "TOO_LARGE"
  | "EXTERNAL_REF" | "REF_CYCLE" | "REF_NOT_FOUND" | "REF_TOO_LARGE"
  | "MISSING_PAYLOAD_PIN" | "VALIDATION_ERROR" | "IMPORT_FAILED";

/** A parsed AsyncAPI 3.x document: a plain object, no forbidden keys, bounded in size and depth. */
export type RawAsyncApi3 = Record<string, unknown> & { asyncapi: string };

/** Every payload and headers schema of every message (component or inline), local `$ref`s already inlined so each schema is self-contained. */
export interface ExtractedPayload {
  /** The key the message will get in the event document. */
  messageKey: string;
  role: "payload" | "headers";
  /** Where the schema is written in the source file (`/components/messages/lightMeasured/payload`). */
  sourcePointer: string;
  format: "json-schema" | "avro" | "protobuf" | "unsupported" | "none";
  /** An object (json-schema, avro) or a string (protobuf source); `undefined` for `unsupported` and `none`. */
  raw: unknown;
  /** PascalCase from the message name, title or key (+ "Headers" for headers). Always a plain identifier. */
  suggestedName: string;
}

export interface MapContext {
  /** `${messageKey}:payload` / `${messageKey}:headers` → the entity pin the message gets. A payload pin is required for every message. */
  payloadPins: ReadonlyMap<string, EntityPin>;
  /** Ids of the tenant's built-in library traits; absent = no built-in available, the trait stays a local copy. */
  builtInTraitIds: { cloudEvents?: string; traceContext?: string };
}
