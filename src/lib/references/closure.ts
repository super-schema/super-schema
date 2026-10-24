import type { PrismaClient, Prisma } from "@/generated/prisma/client";
import { ok, type Result } from "@/types/result";
import type { PrismaEntityInput, PrismaFieldInput } from "@/lib/compiler/compiler.service";
import { sanitizeIdentifier } from "@/lib/compiler/typespec-generator";
import { formatVersionLabel, parseVersionLabel } from "@/lib/entity-versioning/version-math";
import {
  TENANT_PLACEHOLDER,
  holdsEntityReference,
  qualifiedName,
  readFieldReference,
  type EntityRef,
} from "@/lib/references/entity-reference";

type DbClient = PrismaClient | Prisma.TransactionClient;

/** `published`: an unpinned reference resolves to its latest published version. `draft`: to the latest saved rows. */
export type ResolveMode = "published" | "draft";

export type ClosureEntity = {
  entityId: string;
  ref: EntityRef;
  /** `pinned` when a field pinned a published version, otherwise the mode's source. */
  source: "published" | "draft" | "pinned";
  /** MAJOR.MINOR label; absent for a draft source. */
  version?: string;
  fields: PrismaFieldInput[];
  entity: PrismaEntityInput;
};

export type ClosureError =
  /** `entityId` / `fieldId` name the entity and the field row that hold the ambiguous reference (a member of the closure, not always the root): where an explicit pick is written. */
  | { code: "AMBIGUOUS_REFERENCE"; field: string; name: string; candidates: EntityRef[]; entityId: string; fieldId: string }
  | { code: "PIN_NOT_FOUND"; field: string; ref: EntityRef; version: string }
  | { code: "NEVER_PUBLISHED"; ref: EntityRef }
  | { code: "CLOSURE_TOO_LARGE"; limit: number }
  | { code: "CROSS_TENANT" };

/** A legacy name-only reference (on a live field row) that resolved to exactly one entity: what the qualified form would point at. */
export type LegacyUpgrade = { entityId: string; fieldId: string; fieldName: string; ref: EntityRef };

export type ReferenceClosure = {
  root: ClosureEntity;
  entities: ClosureEntity[];
  /** Entities whose content comes from unpublished (draft) rows. */
  draftEntities: EntityRef[];
  /** Strongly connected groups of size > 1, and self-loops, as sorted qualified names. */
  cycles: string[][];
  /**
   * Legacy name-only references found on LIVE field rows (draft source) that resolved to exactly one entity. Reported, never
   * written: loading stays side-effect free, the caller decides whether to apply `upgradeLegacyReference`. Content read from a
   * published or pinned snapshot is frozen and never listed.
   */
  upgrades: LegacyUpgrade[];
};

export const DEFAULT_MAX_CLOSURE_ENTITIES = 200;

type IndexedEntity = {
  id: string;
  name: string;
  description: string;
  status: string;
  version: number;
  domainId: string | null;
  latestVersionId: string | null;
  domain: { id: string; name: string; slug: string } | null;
  product: { name: string } | null;
  ref: EntityRef;
};

type Edge = { field: string; target: IndexedEntity; pin?: string };

const idKey = (name: string) => sanitizeIdentifier(name.trim()).toLowerCase();
const nameKey = (name: string) => name.trim().toLowerCase();
const byQualified = (a: IndexedEntity, b: IndexedEntity) => compareStr(qualifiedName(a.ref), qualifiedName(b.ref));
function compareStr(a: string, b: string): number {
  return a < b ? -1 : a > b ? 1 : 0;
}

/**
 * The tenant's entities, as light as possible: this is read on EVERY generate / emit / validate call for the whole tenant, so it
 * deliberately does not select `metadata` (it holds every stored schema version, `files` and `output` per target). A member's metadata
 * is read by `loadMemberMetadata` for the entities that end up in the closure only.
 */
async function loadTenantIndex(db: DbClient, tenantId: string): Promise<Map<string, IndexedEntity>> {
  const rows = await db.entity.findMany({
    where: { tenantId },
    select: {
      id: true,
      name: true,
      description: true,
      status: true,
      version: true,
      domainId: true,
      latestVersionId: true,
      domain: { select: { id: true, name: true, slug: true } },
      product: { select: { name: true } },
    },
    orderBy: { id: "asc" },
  });
  const index = new Map<string, IndexedEntity>();
  for (const r of rows) {
    index.set(r.id, {
      ...r,
      ref: {
        entityId: r.id,
        domain: r.domain?.name ?? TENANT_PLACEHOLDER,
        product: r.product?.name ?? TENANT_PLACEHOLDER,
        entity: r.name,
      },
    });
  }
  return index;
}

/**
 * Entity-level input for a closure member. LIMIT: `EntityVersion` snapshots only the fields (`fieldSnapshot`) and the
 * TypeSpec source (`resolvedSource`); it holds no name, description, metadata or domain. So for published and pinned
 * sources those come from the LIVE entity row (a post-publish rename or description edit shows through), and only the
 * fields and the version number (`sequence`) are frozen. Identity (id, qualified-name segments) is live by design: the
 * id is the key and the qualified name is refreshed from it (spec decision 4).
 */
function toEntityInput(e: IndexedEntity, metadata: unknown, version?: number): PrismaEntityInput {
  return {
    id: e.id,
    name: e.name,
    description: e.description,
    status: e.status,
    version: version ?? e.version,
    domainId: e.domainId,
    metadata,
    domain: e.domain ? { id: e.domain.id, name: e.domain.name, slug: e.domain.slug } : null,
  };
}

/**
 * `metadata` without `schemaVersions`: the stored generated schemas (every version's `output` and `files`, per target) are bookkeeping
 * the emitters never read (`compileEntity` takes tags, relationships, deprecation, custom and the retention policy), and they can be
 * large. Anything that is not a plain object is returned as it is. The input is not modified.
 */
export function withoutSchemaVersions(metadata: unknown): unknown {
  if (!metadata || typeof metadata !== "object" || Array.isArray(metadata)) return metadata;
  if (!Object.prototype.hasOwnProperty.call(metadata, "schemaVersions")) return metadata;
  const rest = { ...(metadata as Record<string, unknown>) };
  delete rest.schemaVersions;
  return rest;
}

/** The metadata of one closure member (see {@link withoutSchemaVersions}); one primary-key read. A vanished row reads as no metadata. */
async function loadMemberMetadata(db: DbClient, entityId: string): Promise<unknown> {
  const row = await db.entity.findUnique({ where: { id: entityId }, select: { metadata: true } });
  return withoutSchemaVersions(row?.metadata ?? null);
}

/**
 * Resolves a field reference to an indexed entity: id, then qualified name, then a legacy bare name (tenant-wide).
 * Returns `undefined` (dangling) when nothing matches, or the candidates when a bare name is ambiguous.
 */
function resolveTarget(
  index: Map<string, IndexedEntity>,
  fieldRef: EntityRef | { legacyName: string }
): { target: IndexedEntity } | { ambiguous: IndexedEntity[]; name: string } | undefined {
  if ("legacyName" in fieldRef) {
    const all = [...index.values()];
    const exact = all.filter((e) => nameKey(e.name) === nameKey(fieldRef.legacyName));
    const matches = exact.length > 0 ? exact : all.filter((e) => idKey(e.name) === idKey(fieldRef.legacyName));
    if (matches.length === 0) return undefined;
    if (matches.length === 1) return { target: matches[0] };
    return { ambiguous: matches.sort(byQualified), name: fieldRef.legacyName };
  }
  if (fieldRef.entityId) {
    // A dangling id (target deleted or moved tenant) falls through to the qualified name, per id -> qualified -> bare.
    const byId = index.get(fieldRef.entityId);
    if (byId) return { target: byId };
  }
  const q = qualifiedName(fieldRef);
  const matches = [...index.values()].filter((e) => qualifiedName(e.ref) === q);
  if (matches.length === 0) return undefined;
  if (matches.length === 1) return { target: matches[0] };
  return { ambiguous: matches.sort(byQualified), name: q };
}

type Loaded = { fields: PrismaFieldInput[]; source: ClosureEntity["source"]; version?: string; sequence?: number };

async function loadContent(
  db: DbClient,
  e: IndexedEntity,
  mode: ResolveMode,
  pin: string | undefined,
  field: string
): Promise<Result<Loaded, ClosureError>> {
  const published = async (
    where: Prisma.EntityVersionWhereUniqueInput,
    source: "published" | "pinned"
  ): Promise<Loaded | undefined> => {
    const v = await db.entityVersion.findUnique({ where });
    if (!v) return undefined;
    const snapshot = Array.isArray(v.fieldSnapshot) ? (v.fieldSnapshot as unknown as PrismaFieldInput[]) : [];
    return {
      fields: [...snapshot].sort((a, b) => a.sortOrder - b.sortOrder),
      source,
      version: formatVersionLabel(v),
      sequence: v.sequence,
    };
  };

  if (pin) {
    const parsed = parseVersionLabel(pin);
    const missing = { success: false, error: { code: "PIN_NOT_FOUND", field, ref: e.ref, version: pin } } as const;
    if (!parsed.success) return missing;
    const loaded = await published(
      { entityId_major_minor: { entityId: e.id, major: parsed.data.major, minor: parsed.data.minor } },
      "pinned"
    );
    return loaded ? ok(loaded) : missing;
  }
  if (mode === "published") {
    const loaded = e.latestVersionId ? await published({ id: e.latestVersionId }, "published") : undefined;
    if (!loaded) return { success: false, error: { code: "NEVER_PUBLISHED", ref: e.ref } };
    return ok(loaded);
  }
  const rows = await db.field.findMany({ where: { entityId: e.id }, orderBy: { sortOrder: "asc" } });
  return ok({ fields: rows as unknown as PrismaFieldInput[], source: "draft" });
}

/** Tarjan SCC over `graph`; returns groups of size > 1 and self-loops, sorted. */
function findCycles(graph: Map<string, string[]>, label: (id: string) => string): string[][] {
  let counter = 0;
  const idx = new Map<string, number>();
  const low = new Map<string, number>();
  const onStack = new Set<string>();
  const stack: string[] = [];
  const cycles: string[][] = [];

  const visit = (v: string): void => {
    idx.set(v, counter);
    low.set(v, counter);
    counter++;
    stack.push(v);
    onStack.add(v);
    for (const w of graph.get(v) ?? []) {
      if (!idx.has(w)) {
        visit(w);
        low.set(v, Math.min(low.get(v)!, low.get(w)!));
      } else if (onStack.has(w)) {
        low.set(v, Math.min(low.get(v)!, idx.get(w)!));
      }
    }
    if (low.get(v) === idx.get(v)) {
      const group: string[] = [];
      let w: string;
      do {
        w = stack.pop()!;
        onStack.delete(w);
        group.push(w);
      } while (w !== v);
      if (group.length > 1 || (graph.get(v) ?? []).includes(v)) cycles.push(group.map(label).sort(compareStr));
    }
  };
  for (const v of graph.keys()) if (!idx.has(v)) visit(v);
  return cycles.sort((a, b) => compareStr(a[0], b[0]));
}

/**
 * Loads the root entity and everything it references (transitively), tenant-scoped, breadth-first by qualified name.
 * `published` mode resolves unpinned references to the latest published version (never a draft); `draft` mode to the
 * latest saved rows. A pin on a reference names a published version and overrides both. A reference to a deleted or
 * other-tenant entity is dangling: the field is simply absent from the closure. Bounded by `maxEntities`; never throws
 * for domain failures.
 *
 * `opts.rootAtDraft`: the root is read from its current saved rows whatever `mode` says, while every member still resolves by
 * `mode`. This is the closure a PUBLISH of the root is judged against: the root is the draft being frozen (it may never have been
 * published, so it has no published version to read) and what it references must be a published version, never a draft. The root
 * is then the only entity of the closure that can be at draft state.
 */
export async function loadReferenceClosure(
  db: DbClient,
  tenantId: string,
  rootEntityId: string,
  mode: ResolveMode,
  opts?: { maxEntities?: number; rootAtDraft?: boolean }
): Promise<Result<ReferenceClosure, ClosureError>> {
  const limit = opts?.maxEntities ?? DEFAULT_MAX_CLOSURE_ENTITIES;
  // Fail closed: Prisma reads `where: { tenantId: undefined }` as "no filter", i.e. every tenant. A caller without a tenant gets the
  // same answer as a root outside it.
  if (typeof tenantId !== "string" || tenantId.trim() === "") return { success: false, error: { code: "CROSS_TENANT" } };
  const index = await loadTenantIndex(db, tenantId);
  const rootIndexed = index.get(rootEntityId);
  if (!rootIndexed) return { success: false, error: { code: "CROSS_TENANT" } };

  const entities: ClosureEntity[] = [];
  const graph = new Map<string, string[]>();
  const seen = new Set<string>();
  const upgrades: LegacyUpgrade[] = [];

  const add = async (
    e: IndexedEntity,
    pin: string | undefined,
    field: string,
    contentMode: ResolveMode = mode
  ): Promise<Result<Loaded, ClosureError>> => {
    const loaded = await loadContent(db, e, contentMode, pin, field);
    if (!loaded.success) return loaded;
    const metadata = await loadMemberMetadata(db, e.id);
    entities.push({
      entityId: e.id,
      ref: e.ref,
      source: loaded.data.source,
      ...(loaded.data.version ? { version: loaded.data.version } : {}),
      fields: loaded.data.fields,
      entity: toEntityInput(e, metadata, loaded.data.sequence),
    });
    return loaded;
  };

  // The root is never pinned by anything: resolve it by the mode, or (a publish of the root) from its current saved rows.
  const rootLoaded = await add(rootIndexed, undefined, "", opts?.rootAtDraft ? "draft" : mode);
  if (!rootLoaded.success) return rootLoaded;
  seen.add(rootIndexed.id);

  for (let i = 0; i < entities.length; i++) {
    const current = entities[i];
    const edges: Edge[] = [];
    for (const field of current.fields) {
      // Only a field that IS a reference (or an array / map of them) points at an entity: the `referenced*` keys left on a field that was
      // retyped are stale data and must not keep the old target in the closure (nor fail it with its pin).
      if (!holdsEntityReference(field.type, field.decorators)) continue;
      const fieldRef = readFieldReference(field.decorators);
      if (!fieldRef) continue;
      const resolved = resolveTarget(index, fieldRef);
      if (!resolved) continue; // dangling
      if ("ambiguous" in resolved) {
        return {
          success: false,
          error: {
            code: "AMBIGUOUS_REFERENCE",
            field: field.name,
            name: resolved.name,
            candidates: resolved.ambiguous.map((c) => c.ref),
            entityId: current.entityId,
            fieldId: field.id,
          },
        };
      }
      if ("legacyName" in fieldRef && current.source === "draft") {
        upgrades.push({ entityId: current.entityId, fieldId: field.id, fieldName: field.name, ref: resolved.target.ref });
      }
      const pin = "legacyName" in fieldRef ? undefined : fieldRef.pinnedVersion;
      edges.push({ field: field.name, target: resolved.target, pin });
    }
    graph.set(current.entityId, [...new Set(edges.map((e) => e.target.id))]);

    // Breadth-first by qualified name, a field's name breaking ties.
    edges.sort((a, b) => byQualified(a.target, b.target) || compareStr(a.field, b.field));
    for (const edge of edges) {
      // Pin conflict: when two fields pin different versions of one entity, the first visited wins (deterministic,
      // breadth-first by qualified name then field name); later pins to an already-loaded entity are ignored.
      if (seen.has(edge.target.id)) continue;
      if (entities.length >= limit) return { success: false, error: { code: "CLOSURE_TOO_LARGE", limit } };
      const loaded = await add(edge.target, edge.pin, edge.field);
      if (!loaded.success) return loaded;
      seen.add(edge.target.id);
    }
  }

  const labels = new Map(entities.map((e) => [e.entityId, qualifiedName(e.ref)]));
  return ok({
    root: entities[0],
    entities,
    draftEntities: entities.filter((e) => e.source === "draft").map((e) => e.ref),
    cycles: findCycles(graph, (id) => labels.get(id) ?? id),
    upgrades,
  });
}
