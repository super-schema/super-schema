import type { PrismaClient, Prisma } from "@/generated/prisma/client";
import { placeRootMessageFirst } from "@/lib/event-specs/proto-root";
import type { JsonObject, PayloadFormat, SchemaArtifact } from "@/lib/event-specs/types";
import { isJsonObject } from "@/lib/events/inputs";
import { inlineJsonSchemaBundle } from "@/lib/events/json-schema-bundle";
import { combineTypeSpecSources, findRootModelName, levelNamespace, stripGovernanceOverlay, type CombinedSource } from "@/lib/events/version-source";
import { upgradeLegacyTagDecorators } from "@/lib/compiler/legacy-tag-decorators";
import { loadEntityModel } from "@/lib/compiler/entity-model-loader";
import { generateTypeSpec } from "@/lib/compiler/typespec-generator";
import { collectReferencedEntityIds } from "@/lib/entity-versioning/reference-targets";
import { formatVersionLabel } from "@/lib/entity-versioning/version-math";
import { getSchemaTargetDefinition } from "@/lib/schema-targets/catalog";
import {
  injectProtobufFieldNumbers,
  runTypeSpecEmitterFiles,
  sanitizeIdentifier,
  type EmittedFile,
} from "@/lib/typespec-official/emitter.service";
import { projectTypeSpecSourceForProtobuf } from "@/lib/typespec-official/protobuf-source";
import type { FieldSnapshot } from "@/services/version-history/version.types";
import { ok, err, type Result } from "@/types/result";

type Db = PrismaClient | Prisma.TransactionClient;

export type ArtifactSubject = { kind: "version"; entityVersionId: string } | { kind: "draft"; entityId: string };
export interface RenderedArtifact {
  artifact: SchemaArtifact;
  /** Program-combination warnings (duplicate declarations) — surfaced as diagnostics by the resolver. */
  warnings: string[];
}
export interface ArtifactRenderer {
  render(subject: ArtifactSubject, format: PayloadFormat): Promise<Result<RenderedArtifact>>;
}
export type EmitFiles = (packageName: string, source: string, options: Record<string, unknown>) => Promise<Result<EmittedFile[]>>;

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
  return ok({
    part: {
      label: `${v.entity.name}@${formatVersionLabel(v)}`,
      entityId: v.entityId,
      versionId: v.id,
      rootModel: findRootModelName(v.resolvedSource, v.entity.name) ?? sanitizeIdentifier(v.entity.name),
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
      id: true, name: true, typespecSource: true, metadata: true,
      fields: { orderBy: { sortOrder: "asc" }, select: { id: true, name: true, fieldNumber: true, decorators: true } },
    },
  });
  if (!entity) return err({ code: "NOT_FOUND", message: `Entity "${subject.entityId}" not found` });
  let source = entity.typespecSource;
  if (!source) {
    const model = await loadEntityModel(db, entity.id);
    if (!model.success) return model;
    source = generateTypeSpec(model.data);
  }
  const root: ProgramPart = {
    label: `${entity.name} (draft)`,
    entityId: entity.id,
    versionId: null,
    rootModel: findRootModelName(source, entity.name) ?? sanitizeIdentifier(entity.name),
    source,
    fields: entity.fields.map((f) => ({ name: f.name, fieldNumber: f.fieldNumber })),
  };
  const refIds = collectReferencedEntityIds(entity.id, entity.fields, entity.metadata);
  const refs = refIds.length > 0
    ? await db.entity.findMany({ where: { id: { in: refIds } }, select: { id: true, name: true, latestVersionId: true } })
    : [];
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
    return json.success ? ok({ format: "avro", schema: json.data }) : json;
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
  const placed = placeRootMessageFirst(protos[0].content, rootModel);
  return placed.success ? ok({ format: "protobuf", schema: placed.data }) : placed;
}

function createLimiter(max: number) {
  let active = 0;
  const waiting: Array<() => void> = [];
  return async function limit<T>(task: () => Promise<T>): Promise<T> {
    if (active >= max) await new Promise<void>((resolve) => waiting.push(resolve));
    active++;
    try {
      return await task();
    } finally {
      active--;
      waiting.shift()?.();
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
}

export function createArtifactRenderer(options: ArtifactRendererOptions): ArtifactRenderer {
  const emitFiles = options.emitFiles ?? runTypeSpecEmitterFiles;
  const maxEntries = options.maxEntries ?? 256;
  const limit = createLimiter(options.concurrency ?? 2);
  const cache = new Map<string, Promise<Result<RenderedArtifact>>>();

  async function renderUncached(subject: ArtifactSubject, format: PayloadFormat): Promise<Result<RenderedArtifact>> {
    const program = await loadProgram(options.db, subject);
    if (!program.success) return program;
    const parts = [program.data.root, ...program.data.deps];
    const combined = combineTypeSpecSources(parts.map((p) => ({ label: p.label, source: toRealCompilable(p.source) })));
    if (!combined.success) return combined;
    const packageName = getSchemaTargetDefinition(format)?.packageName;
    if (!packageName) return err({ code: "UNSUPPORTED_FORMAT", message: `No TypeSpec emitter for format "${format}"` });
    const source = buildTargetSource(format, combined.data, program.data);
    const files = await limit(() => emitFiles(packageName, source, emitterOptions(format, program.data.root.rootModel)));
    if (!files.success) {
      return err({ code: "ARTIFACT_RENDER_FAILED", message: `${program.data.root.label} → ${format}: ${files.error.message}` });
    }
    const artifact = pickEmittedArtifact(format, files.data, program.data.root.rootModel);
    return artifact.success ? ok({ artifact: artifact.data, warnings: combined.data.warnings }) : artifact;
  }

  return {
    render(subject, format) {
      if (subject.kind === "draft") return renderUncached(subject, format);
      const key = `${subject.entityVersionId}:${format}`;
      const hit = cache.get(key);
      if (hit) {
        cache.delete(key);
        cache.set(key, hit);
        return hit;
      }
      const pending = renderUncached(subject, format).then((r) => {
        if (!r.success) cache.delete(key);
        return r;
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
