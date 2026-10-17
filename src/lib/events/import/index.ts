// src/lib/events/import/index.ts
// The AsyncAPI 3.0 importer's pure layer: file text → payload schemas + an event document. Pure — client-safe.
export { parseAsyncApiSource } from "./source";
export { createRefResolver, resolveLocalRefs, type RefResolver } from "./refs";
export { extractPayloads, pascalName } from "./payloads";
export { mapAsyncApiToEventDocument } from "./map-document";
export { detectBuiltInTrait, type BuiltInMatch, type BuiltInTraitKind } from "./builtin-traits";
export { MAX_ALIAS_COUNT, MAX_DOCUMENT_NODES, MAX_EXPANDED_NODES, MAX_NESTING_DEPTH } from "./limits";
export type { ExtractedPayload, ImportErrorCode, ImportWarning, ImportWarningCode, MapContext, RawAsyncApi3 } from "./types";
