import type { PrismaClient, Prisma } from "@/generated/prisma/client";
import { entityPlaceOf, type PlaceReader } from "@/lib/access/entity-reader";
import { placeRootMessageFirst } from "@/lib/event-specs/proto-root";
import type { JsonObject, PayloadFormat, SchemaArtifact } from "@/lib/event-specs/types";
import { dedupeAvroNamedTypes } from "@/lib/events/avro-named-types";
import { isJsonObject } from "@/lib/events/inputs";
import { inlineJsonSchemaBundle } from "@/lib/events/json-schema-bundle";
import { combineTypeSpecSources, findRootModelName, levelNamespace, stripGovernanceOverlay, type CombinedSource } from "@/lib/events/version-source";
import { upgradeLegacyTagDecorators } from "@/lib/compiler/legacy-tag-decorators";
import { loadEntityModel } from "@/lib/compiler/entity-model-loader";
import { findEmptyEnumFields, generateTypeSpec } from "@/lib/compiler/typespec-generator";
import { sanitizeIdentifier } from "@/lib/compiler/typespec-identifiers";
import { resolveEntityReferences } from "@/lib/entity-versioning/line-references";
import { isSourceStale } from "@/lib/entity-versioning/draft-state";
import { formatVersionLabel } from "@/lib/entity-versioning/version-math";
import { getSchemaTargetDefinition } from "@/lib/schema-targets/catalog";
import {
  DEFAULT_EMITTER_TIMEOUT_MS,
  TSP_MAX_WAITING_RUNS,
  TSP_MAX_WAIT_MS,
  injectProtobufFieldNumbers,
  runTypeSpecEmitterFiles,
  type EmitterRunOptions,
  type EmittedFile,
} from "@/lib/typespec-official/emitter.service";
import { Semaphore, SemaphoreCancelledError, SemaphoreFullError, SemaphoreWaitTimeoutError } from "@/lib/concurrency/semaphore";
import { COMPILER_BUSY_MESSAGE } from "@/lib/emission/emission-admission";
import { describeAvroProjection, describeInvalidAvroSymbols, findInvalidAvroSymbols, projectTypeSpecSourceForAvro } from "@/lib/typespec-official/avro-source";
import { projectTypeSpecSourceForProtobuf } from "@/lib/typespec-official/protobuf-source";
import type { FieldSnapshot } from "@/services/version-history/version.types";
import { ok, err, type Result } from "@/types/result";

type Db = PrismaClient | Prisma.TransactionClient;

/**
 * What is rendered: a pinned version or an entity's current draft, read inside `tenantId` only (the tenant the caller acts in). A subject of
 * another tenant, whether stored or sent by a client, reads as not found: its source never reaches a payload, nor a cached render.
 */
export type ArtifactSubject =
  | { kind: "version"; entityVersionId: string; tenantId: string }
  | { kind: "draft"; entityId: string; tenantId: string };
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
/** What one caller adds to a render: the signal that cancels the compiler runs of the render (a client that went away). */
export interface RenderRun {
  signal?: AbortSignal;
}
export interface ArtifactRenderer {
  /**
   * `canRead`, when given, is the caller's read scope: a closure member it does not cover refuses the render (`REFERENCE_NOT_READABLE`), before any
   * render is served from the cache. Without it the closure is not checked (saved drafts, publish).
   * `run` is honoured for a DRAFT only: a draft is never cached, so it belongs to one caller. A version render is cached and shared by every
   * caller, so it is not cancelled for one of them.
   */
  render(subject: ArtifactSubject, format: PayloadFormat, canRead?: PlaceReader, run?: RenderRun): Promise<Result<RenderedArtifact>>;
}
export type EmitFiles = (
  packageName: string,
  source: string,
  options: Record<string, unknown>,
  run?: EmitterRunOptions
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

/** The refusal for a schema that reaches an entity the caller's roles do not cover. Its message names nothing of that entity (KD-045). */
const unreadableReference = (): Result<never> =>
  err({ code: "REFERENCE_NOT_READABLE", message: "The schema refers to an entity that none of the caller's roles cover" });

/**
 * One frozen version as a program part. `tenantId` binds the lookup to a tenant, for the root of a program and for every dependency: the
 * dependencies are reached through stored `SchemaReference` edges, and an edge to another tenant's version (stored data is not trusted to be
 * clean) must read as "not found", never load that version's source into this tenant's payload. With `canRead`, a version the caller's roles
 * do not cover is refused before anything about it is named (its root model check below names the entity and its source's models).
 */
async function loadVersionPart(
  db: Db,
  versionId: string,
  tenantId: string,
  canRead?: PlaceReader
): Promise<Result<{ part: ProgramPart; pins: string[]; tenantId: string }>> {
  const v = await db.entityVersion.findUnique({
    where: { id: versionId, entity: { tenantId } },
    select: {
      id: true, entityId: true, major: true, minor: true, resolvedSource: true, fieldSnapshot: true,
      entity: { select: { name: true, tenantId: true, domainId: true, productId: true, product: { select: { domainId: true } } } },
    },
  });
  if (!v) return err({ code: "NOT_FOUND", message: `Entity version "${versionId}" not found` });
  // Read before anything is named (KD-045): the root model below names the entity and the models of its source when it cannot find one.
  if (canRead && !canRead(entityPlaceOf(v.entity))) return unreadableReference();
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
    tenantId: v.entity.tenantId,
  });
}

/**
 * BFS over FIELD pins; one version per entity (CONFLICTING_PINS otherwise). With `canRead`, a member the caller's roles do not cover refuses the
 * whole closure before anything is rendered from it.
 */
async function loadClosure(db: Db, start: string[], present: Map<string, ProgramPart>, tenantId: string, canRead?: PlaceReader): Promise<Result<ProgramPart[]>> {
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
    const loaded = await loadVersionPart(db, id, tenantId, canRead);
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

/** The program of a subject: its root and every version it reaches. With `canRead`, the whole program must be readable by the caller (see `ArtifactRenderer.render`). */
export async function loadProgram(db: Db, subject: ArtifactSubject, canRead?: PlaceReader): Promise<Result<Program>> {
  if (subject.kind === "version") {
    const root = await loadVersionPart(db, subject.entityVersionId, subject.tenantId, canRead);
    if (!root.success) return root;
    const deps = await loadClosure(db, root.data.pins, new Map([[root.data.part.entityId, root.data.part]]), root.data.tenantId, canRead);
    if (!deps.success) return deps;
    const namespace = await namespaceFor(db, root.data.part.entityId);
    if (!namespace.success) return namespace;
    return ok({ root: root.data.part, deps: deps.data, namespace: namespace.data });
  }

  // The draft root is read inside the subject's tenant too: an entity of another tenant is "no longer exists" here, like a missing one.
  const entity = await db.entity.findUnique({
    where: { id: subject.entityId, tenantId: subject.tenantId },
    select: {
      id: true, name: true, typespecSource: true, metadata: true, tenantId: true, domainId: true, productId: true,
      product: { select: { domainId: true } },
      fields: { orderBy: { sortOrder: "asc" }, select: { id: true, name: true, fieldNumber: true, decorators: true } },
    },
  });
  if (!entity) return err({ code: "NOT_FOUND", message: `Entity "${subject.entityId}" not found` });
  if (canRead && !canRead(entityPlaceOf(entity))) return unreadableReference();
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
  // Only entities of the draft's own tenant: an id of another tenant's entity (stored by a client that forged it) is "no longer exists" here,
  // never a published version loaded into this tenant's payload.
  const refs = resolved.targetIds.length > 0
    ? await db.entity.findMany({
        where: { id: { in: resolved.targetIds }, tenantId: entity.tenantId },
        select: {
          id: true, name: true, latestVersionId: true, tenantId: true, domainId: true, productId: true, product: { select: { domainId: true } },
        },
      })
    : [];
  if (refs.length < resolved.targetIds.length) {
    const missing = resolved.targetIds.filter((id) => !refs.some((r) => r.id === id));
    return err({ code: "UNRESOLVED_REFERENCE", message: `${entity.name} references entities that no longer exist (${missing.join(", ")})`, details: { ids: missing } });
  }
  // Read before anything is named: an unpublished reference's name is as much its content as a published one's schema (KD-045).
  if (canRead && refs.some((r) => !canRead(entityPlaceOf(r)))) return unreadableReference();
  const unpublished = refs.filter((r) => !r.latestVersionId).map((r) => r.name);
  if (unpublished.length > 0) {
    return err({ code: "UNPUBLISHED_REFERENCE", message: `${entity.name} references unpublished ${unpublished.join(", ")}; publish them to preview this payload` });
  }
  const deps = await loadClosure(db, refs.map((r) => r.latestVersionId as string), new Map([[entity.id, root]]), entity.tenantId, canRead);
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

/**
 * The root record's Avro file: `<root>.avsc.json` (the default naming this renderer runs the emitter with), else the file the
 * emitter wrote under its `qualified-file-names` option (closure emission, closure-emit.ts), `<namespace>.<root>.avsc.json`.
 * The qualified form only counts when exactly one file has it: two namespaces can each hold a record of that name.
 */
function findAvroRootFile(files: EmittedFile[], rootModel: string): EmittedFile | undefined {
  const plain = files.find((f) => [`${rootModel}.avsc.json`, `${rootModel}.avsc`].includes(basename(f.relativePath)));
  if (plain) return plain;
  const qualified = files.filter((f) => basename(f.relativePath).endsWith(`.${rootModel}.avsc.json`));
  return qualified.length === 1 ? qualified[0] : undefined;
}

export function pickEmittedArtifact(format: PayloadFormat, files: EmittedFile[], rootModel: string): Result<SchemaArtifact> {
  if (format === "avro") {
    const file = findAvroRootFile(files, rootModel);
    if (!file) return err({ code: "ROOT_SCHEMA_NOT_FOUND", message: `Avro emitter wrote no ${rootModel}.avsc.json (got ${files.map((f) => f.relativePath).join(", ")})` });
    const json = parseJsonFile(file);
    if (!json.success) return json;
    // the emitter inlines a record at every use; Avro defines a named type once and refers to it by name afterwards
    const deduped = dedupeAvroNamedTypes(json.data);
    if (!deduped.success) return deduped;
    // Safety net behind the Avro projection: a symbol it could not fix (a numeric-valued enum member) is a clear,
    // user-facing error naming the enum — not dozens of opaque AsyncAPI parser errors later.
    const invalidSymbols = describeInvalidAvroSymbols(findInvalidAvroSymbols(deduped.data));
    if (invalidSymbols.length > 0) return err({ code: "AVRO_INVALID_SYMBOL", message: invalidSymbols.join("; ") });
    return ok({ format: "avro", schema: deduped.data });
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

/**
 * Runs one render in the renderer's queue (`queue`, at most its limit at a time, a waiting line of `maxWaiting`). A render beyond the line, or one
 * that waited longer than `maxWaitMs`, is answered `EMITTER_BUSY` and starts nothing; a render whose signal aborts before it has its turn leaves
 * the line at once (`EMITTER_CANCELLED`) and starts nothing either. The slot is given back on every way the render ends (Semaphore.run).
 */
async function inRenderQueue<T>(queue: Semaphore, maxWaitMs: number, task: () => Promise<Result<T>>, signal?: AbortSignal): Promise<Result<T>> {
  try {
    return await queue.run(task, { signal, maxWaitMs });
  } catch (error) {
    if (error instanceof SemaphoreFullError || error instanceof SemaphoreWaitTimeoutError) return err({ code: "EMITTER_BUSY", message: COMPILER_BUSY_MESSAGE });
    if (error instanceof SemaphoreCancelledError) return err({ code: "EMITTER_CANCELLED", message: "The render was cancelled by its caller." });
    throw error;
  }
}

export interface ArtifactRendererOptions {
  db: Db;
  emitFiles?: EmitFiles;
  /** LRU size for immutable version renders (default 256). */
  maxEntries?: number;
  /** Concurrent `tsp` processes (default 2 — typespec-cli times out under heavier parallel load). */
  concurrency?: number;
  /** Renders that may wait for a turn at once (default: TSP_MAX_WAITING_RUNS); one beyond that is answered `EMITTER_BUSY` at once. */
  maxWaiting?: number;
  /** The longest a render waits for its turn (default: TSP_MAX_WAIT_MS); past it the render is answered `EMITTER_BUSY`. */
  maxWaitMs?: number;
  /** A `tsp` run is killed after this long (default 120 000 ms); the render then fails with `EMITTER_TIMEOUT`. */
  emitTimeoutMs?: number;
}

/** The emitter kills its own process at `emitTimeoutMs`; this guard only frees the slot if an emitter fails to honour it. */
const EMIT_TIMEOUT_GRACE_MS = 5_000;

/**
 * Runs one emitter with the timeout of its RUN: the guard's clock starts when the emitter reports it has started (`onStart`, which the `tsp`
 * runs call once they hold their slot), not when the render asks for it. A render that waits in the compiler's queue is not timed out for
 * the wait; an emitter that never reports a start (a refused run, an injected emitter that never runs one) is answered by its own result.
 */
async function emitWithTimeout(
  emitFiles: EmitFiles,
  packageName: string,
  source: string,
  options: Record<string, unknown>,
  timeoutMs: number,
  signal?: AbortSignal
): Promise<Result<EmittedFile[]>> {
  let timer: ReturnType<typeof setTimeout> | undefined;
  let giveUp: (result: Result<EmittedFile[]>) => void = () => undefined;
  const timedOut = new Promise<Result<EmittedFile[]>>((resolve) => {
    giveUp = resolve;
  });
  const onStart = () => {
    timer = setTimeout(
      () => giveUp(err({ code: "EMITTER_TIMEOUT", message: `Emitter "${packageName}" did not finish within ${timeoutMs} ms` })),
      timeoutMs + EMIT_TIMEOUT_GRACE_MS
    );
  };
  const emitted = Promise.resolve().then(() => emitFiles(packageName, source, options, { timeoutMs, onStart, ...(signal && { signal }) }));
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
  const queue = new Semaphore(options.concurrency ?? 2, { maxWaiting: options.maxWaiting ?? TSP_MAX_WAITING_RUNS });
  const maxWaitMs = options.maxWaitMs ?? TSP_MAX_WAIT_MS;
  const cache = new Map<string, Promise<Result<RenderedArtifact>>>();

  async function renderUncached(subject: ArtifactSubject, format: PayloadFormat, canRead?: PlaceReader, run?: RenderRun): Promise<Result<RenderedArtifact>> {
    const program = await loadProgram(options.db, subject, canRead);
    if (!program.success) return program;
    const parts = [program.data.root, ...program.data.deps];
    const label = program.data.root.label;
    // A regenerated draft source marks an enum field without values (the generator never declares an empty enum); the
    // compiler would only say "Unknown identifier ERROR: …" — say what is wrong, and where, instead.
    for (const part of parts) {
      const empty = findEmptyEnumFields(part.source);
      if (empty.length > 0) {
        return err({
          code: "ARTIFACT_RENDER_FAILED",
          message: `${part.label} → ${format}: enum field ${empty.map((name) => `"${name}"`).join(", ")} has no values`,
          suggestedFix: "Give the enum field at least one value.",
          details: { cause: "ENUM_NO_VALUES" },
        });
      }
    }
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
    const files = await inRenderQueue(
      queue,
      maxWaitMs,
      () => emitWithTimeout(emitFiles, packageName, source, emitterOptions(format, program.data.root.rootModel), timeoutMs, run?.signal),
      run?.signal,
    );
    if (!files.success) {
      // A busy compiler or render queue is a "try again", not a render failure: it is not wrapped, so the caller can answer it as busy.
      if (files.error.code === "EMITTER_BUSY") return err({ code: "EMITTER_BUSY", message: files.error.message });
      return err({ code: "ARTIFACT_RENDER_FAILED", message: `${label} → ${format}: ${files.error.message}`, details: { cause: files.error.code } });
    }
    const artifact = pickEmittedArtifact(format, files.data, program.data.root.rootModel);
    if (!artifact.success) return artifact;
    const notes = (avro?.warnings ?? []).map((message) => ({ code: "AVRO_ENUM_SYMBOL_RENAMED", message }));
    return ok({ artifact: artifact.data, warnings: combined.data.warnings, ...(notes.length > 0 && { notes }) });
  }

  /** Never rejects: whatever a loader, the combiner, the emitter or the picker throws is an `ARTIFACT_RENDER_FAILED` result. */
  async function renderSafely(subject: ArtifactSubject, format: PayloadFormat, canRead?: PlaceReader, run?: RenderRun): Promise<Result<RenderedArtifact>> {
    try {
      return await renderUncached(subject, format, canRead, run);
    } catch (error) {
      return renderFailure(subject, format, error);
    }
  }

  /**
   * The level-derived namespace is part of the key: an immutable version renders differently if its entity moves. The version is looked up
   * inside the subject's tenant BEFORE the cache is consulted, so a render cached for one tenant is never handed to another.
   */
  async function versionCacheKey(subject: Extract<ArtifactSubject, { kind: "version" }>, format: PayloadFormat): Promise<Result<string>> {
    const version = await options.db.entityVersion.findUnique({
      where: { id: subject.entityVersionId, entity: { tenantId: subject.tenantId } },
      select: { entityId: true },
    });
    if (!version) return err({ code: "NOT_FOUND", message: `Entity version "${subject.entityVersionId}" not found` });
    const namespace = await namespaceFor(options.db, version.entityId);
    return namespace.success ? ok(`${subject.entityVersionId}:${format}:${namespace.data}`) : namespace;
  }

  return {
    async render(subject, format, canRead, run) {
      // Fail closed: a subject without its tenant (a caller that is not typed) would otherwise read every tenant's rows.
      if (typeof subject.tenantId !== "string" || subject.tenantId === "") {
        return err({ code: "NOT_FOUND", message: `${describeSubject(subject)} not found` });
      }
      if (subject.kind === "draft") return renderSafely(subject, format, canRead, run);
      let key: string;
      try {
        const keyed = await versionCacheKey(subject, format);
        if (!keyed.success) return keyed;
        key = keyed.data;
        // The caller's read scope is checked before the cache is consulted: a render cached for a caller whose roles cover the closure is never
        // handed to one whose roles do not. The closure of a frozen version does not change, so the check reads the same rows a render would.
        if (canRead) {
          const reach = await loadProgram(options.db, subject, canRead);
          if (!reach.success) return reach;
        }
      } catch (error) {
        return renderFailure(subject, format, error);
      }
      const hit = cache.get(key);
      if (hit) {
        cache.delete(key);
        cache.set(key, hit);
        return hit;
      }
      const pending: Promise<Result<RenderedArtifact>> = renderSafely(subject, format, canRead).then((result) => {
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
