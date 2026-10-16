// tests/unit/lib/events/document/fixtures/compat-pipeline.ts
// parse → plan → resolve → assemble for a fixture document, the way event-snapshot / event-emit.service drive it, with
// deterministic stand-ins for the rendered entity schemas.
import { assembleAsyncApi3 } from "@/lib/event-specs/assemble";
import type { Diagnostic, JsonObject, PayloadFormat, ResolvedEventSpec, SchemaArtifact } from "@/lib/event-specs/types";
import { parseEventDocument } from "@/lib/events/document/parse";
import { planDocumentArtifacts, resolveDocument, type MessageArtifacts, type ResolveDocumentInput } from "@/lib/events/document/resolve";
import type { EventDocument } from "@/lib/events/document/types";
import { libraryTraits } from "./slice1-documents";

export function artifact(format: PayloadFormat, name: string): SchemaArtifact {
  if (format === "avro") return { format, schema: { type: "record", name, namespace: "acme.test", fields: [{ name: "id", type: "string" }] } };
  if (format === "protobuf") return { format, schema: `syntax = "proto3";\n\nmessage ${name} {\n  string id = 1;\n}\n` };
  return { format, dialect: "draft-07", schema: { title: name, type: "object", properties: { id: { type: "string" } } } };
}

/** A rendered payload (and, for messages with a key pin, key) for every format the document plans for each message. */
export function artifactsFor(
  doc: EventDocument, entityFormats?: ReadonlyMap<string, PayloadFormat | undefined>, options?: { emitAll?: boolean },
): Map<string, MessageArtifacts> {
  const out = new Map<string, MessageArtifacts>();
  for (const [key, plan] of planDocumentArtifacts(doc, entityFormats, options)) {
    const message = doc.messages.find((m) => m.key === key);
    if (!message) continue;
    out.set(key, {
      payloads: plan.payloadFormats.map((f) => artifact(f, `${key}Payload`)),
      keys: message.keyPin ? plan.keyFormats.map((f) => artifact(f, `${key}Key`)) : [],
    });
  }
  return out;
}

export function resolveInput(doc: EventDocument, overrides: Partial<ResolveDocumentInput> = {}): ResolveDocumentInput {
  return {
    doc, productSlug: "checkout", version: "2.0",
    artifacts: artifactsFor(doc, overrides.entityFormats, { emitAll: overrides.emitAll }),
    localTraitHeaders: new Map(),
    libraryTraits: libraryTraits(),
    libraryTraitHeaders: new Map([["lib-cloudevents", artifact("json-schema", "CloudEventsHeaders")], ["trait-1", artifact("json-schema", "CloudEventsHeaders")]]),
    external: new Map(),
    ...overrides,
  };
}

export interface PipelineResult { parsed: EventDocument; resolved: ResolvedEventSpec; document: JsonObject; diagnostics: Diagnostic[] }

/** Throws when a stage fails, naming the stage: a fixture that stops resolving is a test bug, not an output change. */
export function runPipeline(doc: EventDocument, overrides: Partial<ResolveDocumentInput> = {}): PipelineResult {
  const parsed = parseEventDocument(doc);
  if (!parsed.success) throw new Error(`parse failed: ${JSON.stringify(parsed.error.details)}`);
  const resolved = resolveDocument(resolveInput(parsed.data, overrides));
  if (!resolved.success) throw new Error(`resolve failed: ${JSON.stringify(resolved.error.details)}`);
  const assembled = assembleAsyncApi3(resolved.data);
  return { parsed: parsed.data, resolved: resolved.data, document: assembled.document, diagnostics: assembled.diagnostics };
}
