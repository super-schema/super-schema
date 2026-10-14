/**
 * Events core — pure AsyncAPI 3 layer (Phase 4a). See spec §6–§7.
 * Not exported here on purpose: `./validation/asyncapi-parser-validator` (Story 18.5) pulls in
 * `@asyncapi/parser` and is Node-only — import it directly from server code.
 */
export * from "./types";
export { compareStrings, diagnostic, hasErrors, normalizeDiagnostics } from "./diagnostics";
export { jsonPointer, localRef, parseLocalRef, resolveLocalRef } from "./json-pointer";
export {
  DEFAULT_JSON_SCHEMA_DIALECT,
  FORMAT_CONTENT_TYPES,
  SCHEMA_FORMATS,
  contentTypeFor,
  formatSuffix,
  normalizeProfile,
  sameProfile,
  schemaFormatFor,
} from "./schema-format";
export {
  downConvertToDraft07,
  rewriteDefsRef,
  DRAFT_07_META_SCHEMA,
  UNSUPPORTED_IN_DRAFT_07,
} from "./json-schema-downconvert";
export type { DownConvertResult, DownConvertWarning } from "./json-schema-downconvert";
export { placeRootMessageFirst, ROOT_NODE_ANNOTATION } from "./proto-root";
export { qualifyNames } from "./qualify";
export type { NameCandidate, QualifiedNames } from "./qualify";
export { headersSchema, kafkaKeyProfile, placeKafkaKey, rebaseLocalRefs, selectArtifact } from "./message-schemas";
export type { SchemaRole, SchemaSelection } from "./message-schemas";
export { resolveEventSpecDocument } from "./resolve";
export type { EventSpecCatalog, ResolveOptions, ResolveProblem } from "./resolve";
export { assembleAsyncApi3, ASYNCAPI_VERSION } from "./assemble";
export type { AssemblyResult } from "./assemble";
export { toJson, toYaml } from "./serialize";
export { StructuralAsyncApi3Validator, validateAsyncApi3Structure } from "./validator";
export type { EventSpecValidator } from "./validator";
export { AsyncApi3Adapter, ASYNCAPI_3_SPEC_TYPE, getEventSpecAdapter } from "./adapter";
export type { AsyncApi3AdapterOptions, EventSpecAdapter } from "./adapter";
