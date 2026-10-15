import type { PrismaClient, Prisma } from "@/generated/prisma/client";
import { placeRootMessageFirst } from "@/lib/event-specs/proto-root";
import type { JsonObject, PayloadFormat, SchemaArtifact } from "@/lib/event-specs/types";
import { dedupeAvroNamedTypes } from "@/lib/events/avro-named-types";
import { isJsonObject } from "@/lib/events/inputs";
import { inlineJsonSchemaBundle } from "@/lib/events/json-schema-bundle";
import { combineTypeSpecSources, findRootModelName, levelNamespace, stripGovernanceOverlay, type CombinedSource } from "@/lib/events/version-source";
import { upgradeLegacyTagDecorators } from "@/lib/compiler/legacy-tag-decorators";
import { loadEntityModel } from "@/lib/compiler/entity-model-loader";
import { generateTypeSpec } from "@/lib/compiler/typespec-generator";
import { sanitizeIdentifier } from "@/lib/compiler/typespec-identifiers";
import { resolveEntityReferences } from "@/lib/entity-versioning/line-references";
import { isSourceStale } from "@/lib/entity-versioning/draft-state";
import { formatVersionLabel } from "@/lib/entity-versioning/version-math";
import { getSchemaTargetDefinition } from "@/lib/schema-targets/catalog";
import {
  DEFAULT_EMITTER_TIMEOUT_MS,
  injectProtobufFieldNumbers,
  runTypeSpecEmitterFiles,
  type EmittedFile,
} from "@/lib/typespec-official/emitter.service";
import { describeAvroProjection, projectTypeSpecSourceForAvro } from "@/lib/typespec-official/avro-source";
import { projectTypeSpecSourceForProtobuf } from "@/lib/typespec-official/protobuf-source";
import type { FieldSnapshot } from "@/services/version-history/version.types";
import { ok, err, type Result } from "@/types/result";

type Db = PrismaClient | Prisma.TransactionClient;

export type ArtifactSubject = { kind: "version"; entityVersionId: string } | { kind: "draft"; entityId: string };
export interface RenderedArtifact {
  artifact: SchemaArtifact;
  /** Non-fatal program-combination notes — surfaced as diagnostics by the resolver. */
  warnings: string[];
  /**
   * Coded notes (present only when there are some): what a format projection changed — an Avro enum symbol that had to
   * be renamed to a valid one. The resolver turns each into a warning diagnostic carrying its own code.
   */
  notes?: Array<{ code: string; message: string }>;
}
export interface ArtifactRenderer {
  render(subject: ArtifactSubject, format: PayloadFormat): Promise<Result<RenderedArtifact>>;
}
export type EmitFiles = (
  packageName: string,
  source: string,
  options: Record<string, unknown>,
  run?: { timeoutMs?: number }
) => Promise<Result<EmittedFile[]>>;

export interface ProgramPart {
  label: string;
  entityId: string;
  /** null for a draft root. */
  versionId: string | null;
  rootModel: string;
  source: string;
  fields: Array<{ name: string; fieldNumber: number | null }>;
}
export interface Program {
  root: ProgramPart;
  deps: ProgramPart[];
  namespace: string;
}

const MAX_CLOSURE = 64;

async function namespaceFor(db: Db, entityId: string): Promise<Result<string>> {
  const e = await db.entity.findUnique({
    where: { id: entityId },
    select: { tenant: { select: { slug: true } }, domain: { select: { slug: true } }, product: { select: { slug: true } } },
  });
  if (!e) return err({ code: "NOT_FOUND", message: `Entity "${entityId}" not found` });
  return ok(levelNamespace({ tenantSlug: e.tenant.slug, domainSlug: e.domain?.slug ?? null, productSlug: e.product?.slug ?? null }));
}

/** The entity's root model (see `findRootModelName`); a source without any model falls back to the entity's identifier. */
function rootModelFor(source: string, entityName: string, label: string): Result<string> {
  const found = findRootModelName(source, entityName);
  if (!found.success) return err({ ...found.error, message: `${label}: ${found.error.message}` });
  return ok(found.data ?? sanitizeIdentifier(entityName));
}

async function loadVersionPart(db: Db, versionId: string): Promise<Result<{ part: ProgramPart; pins: string[] }>> {
  const v = await db.entityVersion.findUnique({
    where: { id: versionId },
    select: { id: true, entityId: true, major: true, minor: true, resolvedSource: true, fieldSnapshot: true, entity: { select: { name: true } } },
  });
  if (!v) return err({ code: "NOT_FOUND", message: `Entity version "${versionId}" not found` });
  const pins = await db.schemaReference.findMany({
    where: { fromKind: "ENTITY_VERSION", fromId: v.id, role: "FIELD", toKind: "ENTITY_VERSION" },
    select: { toId: true },
    orderBy: { toId: "asc" },
  });
  const snapshot = Array.isArray(v.fieldSnapshot) ? (v.fieldSnapshot as unknown as FieldSnapshot[]) : [];
  const label = `${v.entity.name}@${formatVersionLabel(v)}`;
  const rootModel = rootModelFor(v.resolvedSource, v.entity.name, label);
  if (!rootModel.success) return rootModel;
  return ok({
    part: {
      label,
      entityId: v.entityId,
      versionId: v.id,
      rootModel: rootModel.data,
      source: v.resolvedSource,
      fields: snapshot.map((f) => ({ name: f.name, fieldNumber: f.fieldNumber ?? null })),
    },
    pins: pins.map((p) => p.toId),
  });
}

/** BFS over FIELD pins; one version per entity (CONFLICTING_PINS otherwise). */
async function loadClosure(db: Db, start: string[], present: Map<string, ProgramPart>): Promise<Result<ProgramPart[]>> {
  const byEntity = new Map(present);
  const queue = [...start];
  const visited = new Set<string>();
  const out: ProgramPart[] = [];
  while (queue.length > 0) {
    const id = queue.shift() as string;
    if (visited.has(id)) continue;
    visited.add(id);
    if (visited.size > MAX_CLOSURE) {
      return err({ code: "REFERENCE_CLOSURE_TOO_LARGE", message: `More than ${MAX_CLOSURE} referenced entity versions` });
    }
    const loaded = await loadVersionPart(db, id);
    if (!loaded.success) return loaded;
    const { part, pins } = loaded.data;
    const existing = byEntity.get(part.entityId);
    if (existing) {
      if (existing.versionId !== part.versionId) {
        return err({
          code: "CONFLICTING_PINS",
          message: `${existing.label} and ${part.label} are both reachable; one schema cannot contain two versions of the same entity`,
          suggestedFix: "Re-publish the referencing entities so they pin the same version.",
        });
      }
      continue;
    }
    byEntity.set(part.entityId, part);
    out.push(part);
    queue.push(...pins);
  }
  return ok(out);
}

export async function loadProgram(db: Db, subject: ArtifactSubject): Promise<Result<Program>> {
  if (subject.kind === "version") {
    const root = await loadVersionPart(db, subject.entityVersionId);
    if (!root.success) return root;
    const deps = await loadClosure(db, root.data.pins, new Map([[root.data.part.entityId, root.data.part]]));
    if (!deps.success) return deps;
    const namespace = await namespaceFor(db, root.data.part.entityId);
    if (!namespace.success) return namespace;
    return ok({ root: root.data.part, deps: deps.data, namespace: namespace.data });
  }

  const entity = await db.entity.findUnique({
    where: { id: subject.entityId },
    select: {
      id: true, name: true, typespecSource: true, metadata: true, tenantId: true, domainId: true, productId: true,
      fields: { orderBy: { sortOrder: "asc" }, select: { id: true, name: true, fieldNumber: true, decorators: true } },
    },
  });
  if (!entity) return err({ code: "NOT_FOUND", message: `Entity "${subject.entityId}" not found` });
  let source = entity.typespecSource;
  // The same trigger as publish (`needsRegeneration`): no stored source, or one flagged `metadata.sourceStale` because field /
  // entity edits happened outside the Source tab. A stale stored source would render the schema the entity had when it was last
  // saved, not the draft the author sees. (`isSourceStale` rather than `needsRegeneration`: that module pulls the server-only
  // TypeSpec compiler into the renderer.) Drafts are never cached, so the regenerated source is always the current one.
  if (!source || isSourceStale(entity.metadata)) {
    const model = await loadEntityModel(db, entity.id);
    if (!model.success) return model;
    source = generateTypeSpec(model.data);
  }
  const draftLabel = `${entity.name} (draft)`;
  const rootModel = rootModelFor(source, entity.name, draftLabel);
  if (!rootModel.success) return rootModel;
  const root: ProgramPart = {
    label: draftLabel,
    entityId: entity.id,
    versionId: null,
    rootModel: rootModel.data,
    source,
    fields: entity.fields.map((f) => ({ name: f.name, fieldNumber: f.fieldNumber })),
  };
  // The same resolution publish pins from: ids stored on the fields plus by-name references resolved in the entity's line.
  const resolved = await resolveEntityReferences(db, entity);
  if (resolved.unresolvedNames.length > 0) {
    return err({
      code: "UNRESOLVED_REFERENCE",
      message: `${entity.name} references ${resolved.unresolvedNames.join(", ")}, which ${resolved.unresolvedNames.length === 1 ? "is" : "are"} not (unambiguously) an entity in its tenant, domain or product`,
      suggestedFix: "Point the reference field at an existing entity in the same line.",
      details: { names: resolved.unresolvedNames },
    });
  }
  const refs = resolved.targetIds.length > 0
    ? await db.entity.findMany({ where: { id: { in: resolved.targetIds } }, select: { id: true, name: true, latestVersionId: true } })
    : [];
  if (refs.length < resolved.targetIds.length) {
    const missing = resolved.targetIds.filter((id) => !refs.some((r) => r.id === id));
    return err({ code: "UNRESOLVED_REFERENCE", message: `${entity.name} references entities that no longer exist (${missing.join(", ")})`, details: { ids: missing } });
  }
  const unpublished = refs.filter((r) => !r.latestVersionId).map((r) => r.name);
  if (unpublished.length > 0) {
    return err({ code: "UNPUBLISHED_REFERENCE", message: `${entity.name} references unpublished ${unpublished.join(", ")}; publish them to preview this payload` });
  }
  const deps = await loadClosure(db, refs.map((r) => r.latestVersionId as string), new Map([[entity.id, root]]));
  if (!deps.success) return deps;
  const namespace = await namespaceFor(db, entity.id);
  if (!namespace.success) return namespace;
  return ok({ root, deps: deps.data, namespace: namespace.data });
}

const FORMAT_HEADER: Record<PayloadFormat, { imports: string[]; usings: string[] }> = {
  avro: { imports: [], usings: [] },
  "json-schema": { imports: ['import "@typespec/json-schema";'], usings: [] },
  protobuf: { imports: ['import "@typespec/protobuf";'], usings: ["using TypeSpec.Protobuf;"] },
};

/**
 * The one place a frozen / stored source is prepared for the real compiler (per source, before the programs are
 * combined so added imports hoist):
 * 1. `upgradeLegacyTagDecorators` — versions frozen before Story 16.6 may still hold invalid `@tag(...)` lines
 *    (`decorator-wrong-target`); they are rewritten into the current overlay decorators.
 * 2. `stripGovernanceOverlay` — the overlay is then projected away (no payload emitter reads it, and importing
 *    the governance library leaks its enums into the JSON Schema `$defs`), as the Schemas-tab emission path does.
 * Drop step 1 when legacy stored sources are no longer possible; it is independent of step 2.
 */
function toRealCompilable(source: string): string {
  return stripGovernanceOverlay(upgradeLegacyTagDecorators(source));
}

/** The `main.tsp` for one format (D9). */
export function buildTargetSource(format: PayloadFormat, combined: CombinedSource, program: Pick<Program, "root" | "deps" | "namespace">): string {
  const header = FORMAT_HEADER[format];
  const imports = [...new Set([...header.imports, ...combined.imports])];
  const usings = [...new Set([...header.usings, ...combined.usings])];
  let body = combined.body;
  if (format === "protobuf") {
    body = projectTypeSpecSourceForProtobuf(body);
    for (const part of [program.root, ...program.deps]) body = injectProtobufFieldNumbers(body, part.rootModel, part.fields);
  }
  // An Avro enum symbol must be [A-Za-z_][A-Za-z0-9_]*: the canonical source keeps wire values (`in-progress`).
  if (format === "avro") body = projectTypeSpecSourceForAvro(body).source;
  const namespace = format === "protobuf" ? ["@package", `namespace ${program.namespace};`] : [`namespace ${program.namespace};`];
  return [...imports, ...usings, "", ...namespace, "", body, ""].join("\n");
}

function emitterOptions(format: PayloadFormat, rootModel: string): Record<string, unknown> {
  return format === "json-schema" ? { emitAllModels: true, "file-type": "json", bundleId: rootModel } : {};
}

const basename = (p: string) => p.split(/[\\/]/).pop() ?? p;

function parseJsonFile(file: EmittedFile): Result<JsonObject> {
  try {
    const value: unknown = JSON.parse(file.content);
    return isJsonObject(value) ? ok(value) : err({ code: "ARTIFACT_PARSE_FAILED", message: `${file.relativePath} is not a JSON object` });
  } catch (e) {
    return err({ code: "ARTIFACT_PARSE_FAILED", message: `${file.relativePath}: ${e instanceof Error ? e.message : String(e)}` });
  }
}

export function pickEmittedArtifact(format: PayloadFormat, files: EmittedFile[], rootModel: string): Result<SchemaArtifact> {
  if (format === "avro") {
    const file = files.find((f) => [`${rootModel}.avsc.json`, `${rootModel}.avsc`].includes(basename(f.relativePath)));
    if (!file) return err({ code: "ROOT_SCHEMA_NOT_FOUND", message: `Avro emitter wrote no ${rootModel}.avsc.json (got ${files.map((f) => f.relativePath).join(", ")})` });
    const json = parseJsonFile(file);
    if (!json.success) return json;
    // the emitter inlines a record at every use; Avro defines a named type once and refers to it by name afterwards
    const deduped = dedupeAvroNamedTypes(json.data);
    return deduped.success ? ok({ format: "avro", schema: deduped.data }) : deduped;
  }
  if (format === "json-schema") {
    const file = files.find((f) => basename(f.relativePath) === rootModel) ?? (files.length === 1 ? files[0] : undefined);
    if (!file) return err({ code: "ROOT_SCHEMA_NOT_FOUND", message: `JSON Schema emitter wrote no bundle "${rootModel}"` });
    const json = parseJsonFile(file);
    if (!json.success) return json;
    const inlined = inlineJsonSchemaBundle(json.data, rootModel);
    return inlined.success ? ok({ format: "json-schema", dialect: "2020-12", schema: inlined.data }) : inlined;
  }
  const protos = files.filter((f) => f.relativePath.endsWith(".proto"));
  if (protos.length !== 1) return err({ code: "PROTO_NOT_SELF_CONTAINED", message: `Expected one .proto file, got ${protos.length}` });
  const foreign = foreignProtoImports(protos[0].content);
  if (foreign.length > 0) {
    return err({
      code: "PROTO_NOT_SELF_CONTAINED",
      message: `The .proto imports files that are not available to a schema registry or consumer: ${foreign.join(", ")}`,
      suggestedFix: "Use only the protobuf well-known types (google/protobuf/*, google/type/*) or protoc-gen-validate imports.",
      details: { imports: foreign },
    });
  }
  const placed = placeRootMessageFirst(protos[0].content, rootModel);
  return placed.success ? ok({ format: "protobuf", schema: placed.data }) : placed;
}

const PROTO_IMPORT = /^[ \t]*import\s+(?:public\s+|weak\s+)?"([^"]*)"\s*;/gm;
const ALLOWED_PROTO_IMPORT = /^(?:google\/protobuf\/[\w./-]+\.proto|google\/type\/[\w./-]+\.proto|validate\/validate\.proto|buf\/validate\/validate\.proto)$/;

/** `import "…";` paths of a `.proto` other than the well-known / validation ones (a document is one self-contained schema). */
function foreignProtoImports(proto: string): string[] {
  const foreign = new Set<string>();
  for (const m of proto.matchAll(PROTO_IMPORT)) {
    if (!ALLOWED_PROTO_IMPORT.test(m[1]) || m[1].includes("..")) foreign.add(m[1]);
  }
  return [...foreign];
}

/** At most `max` tasks run at once; a finishing task hands its slot straight to the next waiter (a rejecting task releases it too). */
function createLimiter(max: number) {
  let active = 0;
  const waiting: Array<() => void> = [];
  return async function limit<T>(task: () => Promise<T>): Promise<T> {
    if (active >= max) await new Promise<void>((resolve) => waiting.push(resolve));
    else active++;
    try {
      return await task();
    } finally {
      const next = waiting.shift();
      if (next) next();
      else active--;
    }
  };
}

export interface ArtifactRendererOptions {
  db: Db;
  emitFiles?: EmitFiles;
  /** LRU size for immutable version renders (default 256). */
  maxEntries?: number;
  /** Concurrent `tsp` processes (default 2 — typespec-cli times out under heavier parallel load). */
  concurrency?: number;
  /** A `tsp` run is killed after this long (default 120 000 ms); the render then fails with `EMITTER_TIMEOUT`. */
  emitTimeoutMs?: number;
}

/** The emitter kills its own process at `emitTimeoutMs`; this guard only frees the slot if an emitter fails to honour it. */
const EMIT_TIMEOUT_GRACE_MS = 5_000;

async function emitWithTimeout(
  emitFiles: EmitFiles,
  packageName: string,
  source: string,
  options: Record<string, unknown>,
  timeoutMs: number
): Promise<Result<EmittedFile[]>> {
  let timer: ReturnType<typeof setTimeout> | undefined;
  const timedOut = new Promise<Result<EmittedFile[]>>((resolve) => {
    timer = setTimeout(
      () => resolve(err({ code: "EMITTER_TIMEOUT", message: `Emitter "${packageName}" did not finish within ${timeoutMs} ms` })),
      timeoutMs + EMIT_TIMEOUT_GRACE_MS
    );
  });
  const emitted = Promise.resolve().then(() => emitFiles(packageName, source, options, { timeoutMs }));
  emitted.catch(() => undefined); // a late rejection after the timeout won must not become an unhandled rejection
  try {
    return await Promise.race([emitted, timedOut]);
  } finally {
    clearTimeout(timer);
  }
}

const describeSubject = (subject: ArtifactSubject): string =>
  subject.kind === "version" ? `Entity version "${subject.entityVersionId}"` : `Entity "${subject.entityId}" (draft)`;

function renderFailure(subject: ArtifactSubject, format: PayloadFormat, error: unknown): Result<never> {
  const message = error instanceof Error ? error.message : String(error);
  return err({ code: "ARTIFACT_RENDER_FAILED", message: `${describeSubject(subject)} → ${format}: ${message}` });
}

export function createArtifactRenderer(options: ArtifactRendererOptions): ArtifactRenderer {
  const emitFiles = options.emitFiles ?? runTypeSpecEmitterFiles;
  const maxEntries = options.maxEntries ?? 256;
  const timeoutMs = options.emitTimeoutMs ?? DEFAULT_EMITTER_TIMEOUT_MS;
  const limit = createLimiter(options.concurrency ?? 2);
  const cache = new Map<string, Promise<Result<RenderedArtifact>>>();

  async function renderUncached(subject: ArtifactSubject, format: PayloadFormat): Promise<Result<RenderedArtifact>> {
    const program = await loadProgram(options.db, subject);
    if (!program.success) return program;
    const parts = [program.data.root, ...program.data.deps];
    const label = program.data.root.label;
    const combined = combineTypeSpecSources(parts.map((p) => ({ label: p.label, source: toRealCompilable(p.source) })));
    if (!combined.success) {
      return err({
        code: "ARTIFACT_RENDER_FAILED",
        message: `${label} → ${format}: ${combined.error.message}`,
        ...(combined.error.suggestedFix && { suggestedFix: combined.error.suggestedFix }),
        details: { cause: combined.error.code, ...combined.error.details },
      });
    }
    const packageName = getSchemaTargetDefinition(format)?.packageName;
    if (!packageName) return err({ code: "UNSUPPORTED_FORMAT", message: `No TypeSpec emitter for format "${format}"` });
    // The Avro projection renames what Avro cannot spell; a rename is reported, two values that collide are an error.
    const avro = format === "avro" ? describeAvroProjection(projectTypeSpecSourceForAvro(combined.data.body)) : undefined;
    if (avro && avro.errors.length > 0) {
      return err({
        code: "ARTIFACT_RENDER_FAILED",
        message: `${label} → ${format}: ${avro.errors.join("; ")}`,
        details: { cause: "AVRO_SYMBOL_COLLISION" },
      });
    }
    const source = buildTargetSource(format, combined.data, program.data);
    const files = await limit(() => emitWithTimeout(emitFiles, packageName, source, emitterOptions(format, program.data.root.rootModel), timeoutMs));
    if (!files.success) {
      return err({ code: "ARTIFACT_RENDER_FAILED", message: `${label} → ${format}: ${files.error.message}`, details: { cause: files.error.code } });
    }
    const artifact = pickEmittedArtifact(format, files.data, program.data.root.rootModel);
    if (!artifact.success) return artifact;
    const notes = (avro?.warnings ?? []).map((message) => ({ code: "AVRO_ENUM_SYMBOL_RENAMED", message }));
    return ok({ artifact: artifact.data, warnings: combined.data.warnings, ...(notes.length > 0 && { notes }) });
  }

  /** Never rejects: whatever a loader, the combiner, the emitter or the picker throws is an `ARTIFACT_RENDER_FAILED` result. */
  async function renderSafely(subject: ArtifactSubject, format: PayloadFormat): Promise<Result<RenderedArtifact>> {
    try {
      return await renderUncached(subject, format);
    } catch (error) {
      return renderFailure(subject, format, error);
    }
  }

  /** The level-derived namespace is part of the key: an immutable version renders differently if its entity moves. */
  async function versionCacheKey(entityVersionId: string, format: PayloadFormat): Promise<Result<string>> {
    const version = await options.db.entityVersion.findUnique({ where: { id: entityVersionId }, select: { entityId: true } });
    if (!version) return err({ code: "NOT_FOUND", message: `Entity version "${entityVersionId}" not found` });
    const namespace = await namespaceFor(options.db, version.entityId);
    return namespace.success ? ok(`${entityVersionId}:${format}:${namespace.data}`) : namespace;
  }

  return {
    async render(subject, format) {
      if (subject.kind === "draft") return renderSafely(subject, format);
      let key: string;
      try {
        const keyed = await versionCacheKey(subject.entityVersionId, format);
        if (!keyed.success) return keyed;
        key = keyed.data;
      } catch (error) {
        return renderFailure(subject, format, error);
      }
      const hit = cache.get(key);
      if (hit) {
        cache.delete(key);
        cache.set(key, hit);
        return hit;
      }
      const pending: Promise<Result<RenderedArtifact>> = renderSafely(subject, format).then((result) => {
        if (!result.success && cache.get(key) === pending) cache.delete(key);
        return result;
      });
      cache.set(key, pending);
      while (cache.size > maxEntries) cache.delete(cache.keys().next().value as string);
      return pending;
    },
  };
}

let shared: ArtifactRenderer | undefined;

/** Process-wide renderer (D9 cache) for server code; tests construct their own. */
export function getSharedArtifactRenderer(db: PrismaClient): ArtifactRenderer {
  shared ??= createArtifactRenderer({ db });
  return shared;
}
