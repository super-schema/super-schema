// src/lib/events/document/instant-asyncapi.ts
// The AsyncAPI document of an UNSAVED event draft, built synchronously in the browser for the live Code panel. Pure — client-safe.
//
// It runs the server's own pipeline (parse → plan → resolve → assemble → serialize) with one difference: nothing is rendered.
// Every payload / headers / Kafka-key schema is a clearly marked PLACEHOLDER that names the entity and version it stands for
// (`x-super-schema-entity: Order@1.0`), external references (which need the referenced event's stored version) are left out with an
// info diagnostic, and a library trait is a stub that carries its key UNLESS its definition is handed in (`libraryTraits`): a built-in
// or library trait whose properties are inline (`spec.headers`) is then emitted exactly as the server will. The server render
// (`previewEventDocumentAction`) replaces the placeholders with the real schemas a moment later.
import { assembleAsyncApi3 } from "@/lib/event-specs/assemble";
import { diagnostic, normalizeDiagnostics } from "@/lib/event-specs/diagnostics";
import { toJson, toYaml } from "@/lib/event-specs/serialize";
import type { Diagnostic, JsonObject, PayloadFormat, SchemaArtifact, TraitKind } from "@/lib/event-specs/types";
import { validateAsyncApi3Structure } from "@/lib/event-specs/validator";
import type { EntityPin, FrozenTrait } from "@/lib/events/types";
import { parseEventDocument } from "./parse";
import type { EntityFormats } from "./representation";
import { planDocumentArtifacts, resolveDocument, type MessageArtifacts } from "./resolve";
import { isLibraryTrait, type DocumentProblem, type EventDocument } from "./types";

/** Marks a schema as a stand-in for an entity's real schema: the value is `Entity@version`. */
export const PLACEHOLDER_ENTITY_KEY = "x-super-schema-entity";
/** Marks a trait as a stub for a library trait that is resolved on the server: the value is the trait's key in the document. */
export const PLACEHOLDER_LIBRARY_TRAIT_KEY = "x-super-schema-library-trait";
/** `info.version` of an instant (and of the server's draft) emission. */
export const INSTANT_VERSION = "draft";

export interface InstantAsyncApi {
  /** Null when the draft does not parse or resolve; then `yaml` and `json` are empty and `diagnostics` say why. */
  document: JsonObject | null;
  yaml: string;
  json: string;
  /** Draft problems point into the draft document; assembler / validator diagnostics point into the emitted document. */
  diagnostics: Diagnostic[];
}

/** The stored definition of a library trait (what the server's snapshot loads for a `libraryTraitId`). */
export interface InstantLibraryTrait {
  /** The trait's name in the library: the server emits it as the component key (`components.messageTraits.<name>`). */
  name: string;
  kind: TraitKind;
  /** The AsyncAPI Message / Operation Trait object, including inline `headers` for a trait that defines message properties. */
  spec: JsonObject;
}

export interface InstantAsyncApiOptions {
  productSlug: string;
  /** entityId → entity name ("Order"). An entity that is not in the map is named by its id. */
  entityLabels: ReadonlyMap<string, string>;
  /** entityVersionId → version label ("1.0" or "v1.0"). A pinned version that is not in the map shows as "pinned". */
  versionLabels?: ReadonlyMap<string, string>;
  /**
   * entityId → the representation the entity was imported in (what a message's "Auto" follows, see `resolveRepresentations`).
   * Default: none, so Auto falls back to the protocol default (Kafka → Avro, everything else → JSON Schema).
   */
  entityFormats?: EntityFormats;
  /**
   * libraryTraitId → the trait's real definition. A library trait the document uses is emitted from it (a copy, so a frozen built-in
   * definition is never shared); one that is not in the map stays a stub that carries its key. Default: none, all stubs.
   * A trait whose headers are a pinned ENTITY has no inline properties here: its headers come with the server render.
   */
  libraryTraits?: ReadonlyMap<string, InstantLibraryTrait>;
}

/** The builder's library options as the map `buildInstantAsyncApi` takes; an option that carries no `spec` is left out (it stays a stub). */
export function instantLibraryTraits(
  options: ReadonlyArray<{ id: string; name: string; kind: TraitKind; spec?: JsonObject }>
): Map<string, InstantLibraryTrait> {
  const out = new Map<string, InstantLibraryTrait>();
  for (const o of options) if (o.spec) out.set(o.id, { name: o.name, kind: o.kind, spec: o.spec });
  return out;
}

const NO_ENTITY_FORMATS: EntityFormats = new Map();

interface EntityRef {
  /** The entity's name, for identifiers. */
  label: string;
  /** `Order@1.0` / `Order@draft` / `Order@pinned`. */
  ref: string;
}

const failed = (diagnostics: Diagnostic[]): InstantAsyncApi => ({ document: null, yaml: "", json: "", diagnostics: normalizeDiagnostics(diagnostics) });

/** `details.problems` of a parse / resolve error, tolerating any other shape. */
function problemsOf(details: unknown): DocumentProblem[] {
  const list = (details as { problems?: unknown } | undefined)?.problems;
  if (!Array.isArray(list)) return [];
  return list.flatMap((p): DocumentProblem[] => {
    const { pointer, message } = (p ?? {}) as { pointer?: unknown; message?: unknown };
    return typeof pointer === "string" && typeof message === "string" ? [{ pointer, message }] : [];
  });
}

/** An Avro / Protobuf identifier from an entity name: `[A-Za-z_][A-Za-z0-9_]*`. */
function identifier(label: string): string {
  const safe = label.replace(/[^A-Za-z0-9_]+/g, "_");
  if (safe.replace(/_/g, "") === "") return "Entity";
  return /^[A-Za-z_]/.test(safe) ? safe : `_${safe}`;
}

function entityRef(pin: EntityPin, opts: InstantAsyncApiOptions): EntityRef {
  const label = opts.entityLabels.get(pin.entityId) ?? pin.entityId;
  const version = pin.entityVersionId === null ? "draft" : (opts.versionLabels?.get(pin.entityVersionId)?.replace(/^v/i, "") ?? "pinned");
  return { label, ref: `${label}@${version}` };
}

function protoStub(entity: EntityRef): string {
  return [
    `// ${PLACEHOLDER_ENTITY_KEY}: ${entity.ref} (placeholder - the full schema is rendered on the server)`,
    'syntax = "proto3";',
    "",
    `message ${identifier(entity.label)} {}`,
    "",
  ].join("\n");
}

/**
 * The placeholder artifacts the assembler may pick for one payload / key in `format`. JSON Schema is offered in both dialects, so
 * whichever dialect a channel asks for finds an exact match (no down-conversion is run on a stand-in).
 */
function placeholderArtifacts(format: PayloadFormat, entity: EntityRef): SchemaArtifact[] {
  switch (format) {
    case "avro":
      return [{ format: "avro", schema: { type: "record", name: identifier(entity.label), fields: [], [PLACEHOLDER_ENTITY_KEY]: entity.ref } }];
    case "protobuf":
      return [{ format: "protobuf", schema: protoStub(entity) }];
    case "json-schema":
      return (["draft-07", "2020-12"] as const).map((dialect) => ({ format: "json-schema" as const, dialect, schema: { [PLACEHOLDER_ENTITY_KEY]: entity.ref } }));
  }
}

/** Headers must be a JSON Schema object schema (the assembler drops anything else with an error). */
const headersPlaceholder = (entity: EntityRef): SchemaArtifact => ({
  format: "json-schema", dialect: "draft-07", schema: { type: "object", [PLACEHOLDER_ENTITY_KEY]: entity.ref },
});

/**
 * External references resolve against another event's stored version, which the browser does not have. They are removed together
 * with everything that can only exist through them: an operation on an external channel, an external message in a channel's, an
 * operation's or a reply's message list, and a reply that goes to an external channel.
 */
function withoutExternalRefs(doc: EventDocument): { doc: EventDocument; omitted: Diagnostic[] } {
  if (doc.externalRefs.length === 0) return { doc, omitted: [] };
  const externalChannels = new Set(doc.externalRefs.filter((r) => r.kind === "channel").map((r) => r.key));
  const externalMessages = new Set(doc.externalRefs.filter((r) => r.kind === "message").map((r) => r.key));
  const local = (keys: readonly string[]) => keys.filter((k) => !externalMessages.has(k));
  const omitted = doc.externalRefs.map((r, i) =>
    diagnostic(
      "info", "EXTERNAL_REF_OMITTED",
      `External ${r.kind} "${r.itemKey}" (reference "${r.key}") is not shown in the draft preview; the full render resolves it from its published version.`,
      `/externalRefs/${i}`
    )
  );
  return {
    omitted,
    doc: {
      ...doc,
      externalRefs: [],
      channels: doc.channels.map((c) => ({ ...c, messageKeys: local(c.messageKeys) })),
      operations: doc.operations
        .filter((o) => !externalChannels.has(o.channelKey))
        .map(({ reply, ...o }) => {
          const kept = { ...o, messageKeys: local(o.messageKeys) };
          if (reply === undefined || (reply.channelKey !== undefined && externalChannels.has(reply.channelKey))) return kept;
          return { ...kept, reply: reply.messageKeys === undefined ? reply : { ...reply, messageKeys: local(reply.messageKeys) } };
        }),
    },
  };
}

function build(raw: EventDocument, opts: InstantAsyncApiOptions): InstantAsyncApi {
  const parsed = parseEventDocument(raw);
  if (!parsed.success) {
    return failed(problemsOf(parsed.error.details).map((p) => diagnostic("error", "INVALID_DRAFT", p.message, p.pointer)));
  }
  const { doc, omitted } = withoutExternalRefs(parsed.data);
  const entityFormats = opts.entityFormats ?? NO_ENTITY_FORMATS;

  const plan = planDocumentArtifacts(doc, entityFormats, { emitAll: true });
  const artifacts = new Map<string, MessageArtifacts>();
  for (const m of doc.messages) {
    const need = plan.get(m.key);
    if (!need || artifacts.has(m.key)) continue;
    const payload = entityRef(m.payload, opts);
    const key = m.keyPin ? entityRef(m.keyPin, opts) : null;
    artifacts.set(m.key, {
      payloads: need.payloadFormats.flatMap((f) => placeholderArtifacts(f, payload)),
      keys: key ? need.keyFormats.flatMap((f) => placeholderArtifacts(f, key)) : [],
      ...(m.headers && { headers: headersPlaceholder(entityRef(m.headers, opts)) }),
    });
  }

  const localTraitHeaders = new Map<string, SchemaArtifact>();
  const libraryTraits = new Map<string, FrozenTrait>();
  for (const t of doc.traits) {
    if (isLibraryTrait(t)) {
      if (!libraryTraits.has(t.libraryTraitId)) {
        const known = opts.libraryTraits?.get(t.libraryTraitId);
        libraryTraits.set(t.libraryTraitId, {
          id: t.libraryTraitId, name: known?.name ?? t.key, kind: known?.kind ?? t.kind, ownerSlug: opts.productSlug,
          spec: known ? structuredClone(known.spec) : { [PLACEHOLDER_LIBRARY_TRAIT_KEY]: t.key }, headersEntityId: null, headersEntityVersionId: null,
        });
      }
    } else if (t.headers && !localTraitHeaders.has(t.key)) {
      localTraitHeaders.set(t.key, headersPlaceholder(entityRef(t.headers, opts)));
    }
  }

  const resolved = resolveDocument({
    doc, productSlug: opts.productSlug, version: INSTANT_VERSION,
    artifacts, localTraitHeaders, libraryTraits, libraryTraitHeaders: new Map(), external: new Map(),
    // The Code panel shows everything the user has defined so far, not only what an operation reaches.
    entityFormats, emitAll: true, emitChannelServers: true,
  });
  if (!resolved.success) {
    return failed([...omitted, ...problemsOf(resolved.error.details).map((p) => diagnostic("error", "UNRESOLVED_REFERENCE", p.message, p.pointer))]);
  }

  const assembled = assembleAsyncApi3(resolved.data);
  const diagnostics = normalizeDiagnostics([...omitted, ...assembled.diagnostics, ...validateAsyncApi3Structure(assembled.document)]);
  return { document: assembled.document, yaml: toYaml(assembled.document), json: toJson(assembled.document), diagnostics };
}

/**
 * The AsyncAPI document of `doc` with placeholder schemas, as an object, YAML and JSON. Never throws: a draft that does not parse
 * or resolve (or a value the serializers cannot handle) is `{ document: null, yaml: "", json: "" }` with the reasons as diagnostics.
 */
export function buildInstantAsyncApi(doc: EventDocument, opts: InstantAsyncApiOptions): InstantAsyncApi {
  try {
    return build(doc, opts);
  } catch {
    return failed([diagnostic("error", "INSTANT_BUILD_FAILED", "The draft could not be turned into AsyncAPI code.", "")]);
  }
}
