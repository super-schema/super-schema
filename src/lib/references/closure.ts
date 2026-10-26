import type { PrismaClient, Prisma } from "@/generated/prisma/client";
import { ok, type Result } from "@/types/result";
import type { PrismaEntityInput, PrismaFieldInput } from "@/lib/compiler/compiler.service";
import { sanitizeIdentifier } from "@/lib/compiler/typespec-generator";
import { formatVersionLabel, parseVersionLabel } from "@/lib/entity-versioning/version-math";
import { readEntitySnapshot, withoutSchemaVersions, type EntitySnapshot } from "@/lib/entity-versioning/entity-snapshot";
import {
  TENANT_PLACEHOLDER,
  holdsEntityReference,
  qualifiedName,
  readFieldReference,
  type EntityRef,
  type LegacyEntityRef,
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
  /**
   * `entityId` / `fieldId` name the entity and the field row that hold the ambiguous reference (a member of the closure, not always the root): where an
   * explicit pick is written. `owner` is that entity as a reference. `frozen`: the field was read from a published or pinned SNAPSHOT, which a pick
   * cannot change (it writes the live row; only a new version of the owner carries it), so no pick is asked for: the owner must be published again.
   */
  | { code: "AMBIGUOUS_REFERENCE"; field: string; name: string; candidates: EntityRef[]; entityId: string; fieldId: string; owner: EntityRef; frozen: boolean }
  | { code: "PIN_NOT_FOUND"; field: string; ref: EntityRef; version: string }
  /**
   * Fields of the closure pin DIFFERENT versions of one entity. A closure resolves an entity once (its files are per entity), so the
   * pins cannot both hold. `pins` has one entry per distinct pinned version: the field and the entity that owns it.
   */
  | { code: "PIN_CONFLICT"; ref: EntityRef; pins: { field: string; owner: EntityRef; version: string }[] }
  | { code: "NEVER_PUBLISHED"; ref: EntityRef }
  | { code: "CLOSURE_TOO_LARGE"; limit: number }
  /**
   * The closure reaches an entity the caller's roles do not cover (KD-045): refused whole, never omitted and never described. `field` is the field of
   * an entity the caller CAN read that holds the reference (their own field); the unreadable entity is named nowhere in the error: not its name,
   * domain, product, id, pin or candidates.
   */
  | { code: "REFERENCE_NOT_READABLE"; field: string }
  | { code: "CROSS_TENANT" };

/** Where an entity sits in the scope tree: what a role is judged against (the tenant, the domain it hangs under, its product). */
export type ClosurePlace = { tenantId: string; domainId: string | null; productId: string | null };

/**
 * May the caller read the entity at `place`? The closure asks it of every entity it is about to add, before it reads a row of that entity's
 * content (KD-045). `entityReader(assignments)` in `@/lib/access` is the one implementation (the policy's `entity.read`); this module stays free
 * of policy and takes the answer as a function. No reader = nothing is held back (the loader's own tests, a caller that has no principal).
 */
export type ClosureReader = (place: ClosurePlace) => boolean;

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
  /**
   * Facts about how the closure was resolved that are not errors, one sentence each (shown with the generated version). Today: an entity
   * reached by an unpinned edge while another edge pins a version, which resolved to the pin for the whole closure.
   */
  notes: string[];
};

export const DEFAULT_MAX_CLOSURE_ENTITIES = 200;

type IndexedEntity = {
  id: string;
  name: string;
  description: string;
  status: string;
  version: number;
  domainId: string | null;
  /** The entity's place for access: its tenant, the domain it counts as being in (a product row with an empty domain column takes its product's) and its product. */
  place: ClosurePlace;
  latestVersionId: string | null;
  domain: { id: string; name: string; slug: string } | null;
  product: { name: string } | null;
  ref: EntityRef;
};

type Edge = { field: string; target: IndexedEntity; pin?: string };

/** What the resolver needs of a tenant entity: its id, its name and its qualified reference. */
type Resolvable = { id: string; name: string; ref: EntityRef };

const idKey = (name: string) => sanitizeIdentifier(name.trim()).toLowerCase();
const nameKey = (name: string) => name.trim().toLowerCase();
const byQualified = (a: Pick<Resolvable, "ref">, b: Pick<Resolvable, "ref">) => compareStr(qualifiedName(a.ref), qualifiedName(b.ref));
function compareStr(a: string, b: string): number {
  return a < b ? -1 : a > b ? 1 : 0;
}

/** A pin as a comparable label: `1.0` and `01.0` are one version. Anything that does not parse is compared as written. */
function normalizePin(pin: string): string {
  const parsed = parseVersionLabel(pin.trim());
  return parsed.success ? formatVersionLabel(parsed.data) : pin.trim();
}

/** The pinning edges among `edges`, one per distinct version, ordered by owner (qualified name) then field name. */
function distinctPins<T extends { field: string; ownerRef: EntityRef; pin?: string }>(edges: T[]): T[] {
  const pinned = edges
    .filter((o) => o.pin)
    .sort((a, b) => compareStr(qualifiedName(a.ownerRef), qualifiedName(b.ownerRef)) || compareStr(a.field, b.field));
  const seenVersions = new Set<string>();
  return pinned.filter((o) => {
    const key = normalizePin(o.pin as string);
    if (seenVersions.has(key)) return false;
    seenVersions.add(key);
    return true;
  });
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
      productId: true,
      latestVersionId: true,
      domain: { select: { id: true, name: true, slug: true } },
      product: { select: { name: true, domainId: true } },
    },
    orderBy: { id: "asc" },
  });
  const index = new Map<string, IndexedEntity>();
  for (const r of rows) {
    const { productId, product, ...row } = r;
    index.set(r.id, {
      ...row,
      product: product ? { name: product.name } : null,
      place: { tenantId, domainId: r.domainId ?? product?.domainId ?? null, productId: productId ?? null },
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
 * Entity-level input for a closure member: its name, description, status and metadata (tags, deprecation, retention policy, the custom
 * declarations, relationships: everything `compileEntity` reads of the entity) come from the `snapshot` its published version froze
 * (`entitySnapshot` in the version's `compatReport`, see `entity-snapshot.ts`), so an edit made after the publish is not in published
 * output. Without one (a draft source, or a version published before snapshots) they come from the LIVE entity row. Identity (id,
 * qualified-name segments, domain) is always live by design: the id is the key and the qualified name is refreshed from it (spec decision
 * 4). The version number (`sequence`) is the published version's own.
 */
function toEntityInput(e: IndexedEntity, metadata: unknown, version?: number, snapshot?: EntitySnapshot): PrismaEntityInput {
  return {
    id: e.id,
    name: snapshot?.name ?? e.name,
    description: snapshot?.description ?? e.description,
    status: snapshot?.status ?? e.status,
    version: version ?? e.version,
    domainId: e.domainId,
    metadata: snapshot ? snapshot.metadata : metadata,
    domain: e.domain ? { id: e.domain.id, name: e.domain.name, slug: e.domain.slug } : null,
  };
}

export { withoutSchemaVersions };

/** The metadata of one closure member (see {@link withoutSchemaVersions}); one primary-key read. A vanished row reads as no metadata. */
async function loadMemberMetadata(db: DbClient, entityId: string): Promise<unknown> {
  const row = await db.entity.findUnique({ where: { id: entityId }, select: { metadata: true } });
  return withoutSchemaVersions(row?.metadata ?? null);
}


/**
 * Resolves a field reference to an indexed entity: id, then qualified name, then a legacy bare name (tenant-wide).
 * Returns `undefined` (dangling) when nothing matches, or the candidates when a bare name is ambiguous.
 */
function resolveTarget<T extends Resolvable>(
  index: Map<string, T>,
  fieldRef: EntityRef | LegacyEntityRef
): { target: T } | { ambiguous: T[]; name: string } | undefined {
  if ("legacyName" in fieldRef) {
    // A name-only reference whose field still carries the entity id (its qualified string could not be read): the id is the key.
    const byId = fieldRef.entityId ? index.get(fieldRef.entityId) : undefined;
    if (byId) return { target: byId };
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

/** What {@link createRefResolver} answers: the one entity a reference means, the several a bare name matches, or nothing (dangling). */
export type RefResolution = { target: EntityRef } | { ambiguous: EntityRef[]; name: string } | undefined;

/**
 * The tenant's entities as qualified references (id, domain / product / entity), for resolving a name that is not on a field row yet (a
 * name written in TypeSpec source). Tenant-scoped like the closure walk, with the same light read (no metadata). A blank tenant id fails
 * closed (`CROSS_TENANT`): Prisma reads `tenantId: undefined` as "every tenant".
 */
export async function loadTenantEntityRefs(db: DbClient, tenantId: string): Promise<Result<EntityRef[], ClosureError>> {
  if (typeof tenantId !== "string" || tenantId.trim() === "") return { success: false, error: { code: "CROSS_TENANT" } };
  const index = await loadTenantIndex(db, tenantId);
  return ok([...index.values()].map((e) => e.ref));
}

/**
 * The closure walk's own resolver (id, then qualified name, then a legacy bare name across the tenant) over a list of tenant entity
 * references, for callers that resolve a reference outside a closure walk. Entries without an id are not resolvable and are skipped.
 */
export function createRefResolver(refs: readonly EntityRef[]): (fieldRef: EntityRef | LegacyEntityRef) => RefResolution {
  const index = new Map<string, Resolvable>();
  for (const ref of refs) if (ref.entityId) index.set(ref.entityId, { id: ref.entityId, name: ref.entity, ref });
  return (fieldRef) => {
    const resolved = resolveTarget(index, fieldRef);
    if (!resolved) return undefined;
    if ("ambiguous" in resolved) return { ambiguous: resolved.ambiguous.map((e) => e.ref), name: resolved.name };
    return { target: resolved.target.ref };
  };
}

type Loaded = {
  fields: PrismaFieldInput[];
  source: ClosureEntity["source"];
  version?: string;
  sequence?: number;
  /** What the published version froze about the entity itself. Absent for a draft source and for a version published before snapshots. */
  snapshot?: EntitySnapshot;
};

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
    const entitySnapshot = readEntitySnapshot(v.compatReport);
    return {
      fields: [...snapshot].sort((a, b) => a.sortOrder - b.sortOrder),
      source,
      version: formatVersionLabel(v),
      sequence: v.sequence,
      ...(entitySnapshot ? { snapshot: entitySnapshot } : {}),
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
 *
 * `opts.reader` (KD-045): who may read what. The root is the caller's own (they were authorized for it before the load); every OTHER entity the walk
 * is about to add is asked about first, and one the caller may not read refuses the whole closure with `REFERENCE_NOT_READABLE` before a single row of its
 * content (fields, versions, metadata) is read, so nothing of it can reach a source or a file, an error text or a candidate list.
 */
export async function loadReferenceClosure(
  db: DbClient,
  tenantId: string,
  rootEntityId: string,
  mode: ResolveMode,
  opts?: { maxEntities?: number; rootAtDraft?: boolean; reader?: ClosureReader }
): Promise<Result<ReferenceClosure, ClosureError>> {
  const limit = opts?.maxEntities ?? DEFAULT_MAX_CLOSURE_ENTITIES;
  // Fail closed: Prisma reads `where: { tenantId: undefined }` as "no filter", i.e. every tenant. A caller without a tenant gets the
  // same answer as a root outside it.
  if (typeof tenantId !== "string" || tenantId.trim() === "") return { success: false, error: { code: "CROSS_TENANT" } };
  const index = await loadTenantIndex(db, tenantId);
  const rootIndexed = index.get(rootEntityId);
  if (!rootIndexed) return { success: false, error: { code: "CROSS_TENANT" } };
  const reader = opts?.reader;
  const refuse = (field: string): Result<never, ClosureError> => ({ success: false, error: { code: "REFERENCE_NOT_READABLE", field } });

  /** One edge to an entity, as a field of a member declared it: who owns the field and the version it pins (none: unpinned). */
  type Observation = { field: string; owner: IndexedEntity; ownerRef: EntityRef; pin?: string };
  type Walk = {
    entities: ClosureEntity[];
    graph: Map<string, string[]>;
    upgrades: LegacyUpgrade[];
    /** Every edge to every entity but the root (a member as often as the root declares them), in walk order. */
    observed: Map<string, Observation[]>;
    /** The pin each entity was loaded with (absent: loaded by the mode). */
    applied: Map<string, string | undefined>;
    /** Members of a published or pinned source whose version froze no entity snapshot (published before snapshots): read from the live row. */
    legacy: Set<string>;
  };

  /**
   * One breadth-first pass. `forced` is the pin to load an entity with whichever edge reached it first (a pin on ANY edge to an entity
   * wins, and the first edge visited is not always the one that pins), learned from the previous pass.
   */
  const walk = async (forced: Map<string, Observation & { pin: string }>): Promise<Result<Walk, ClosureError>> => {
    const entities: ClosureEntity[] = [];
    const graph = new Map<string, string[]>();
    const seen = new Set<string>();
    const upgrades: LegacyUpgrade[] = [];
    const observed = new Map<string, Observation[]>();
    const applied = new Map<string, string | undefined>();
    const legacy = new Set<string>();

    const add = async (
      e: IndexedEntity,
      pin: string | undefined,
      field: string,
      contentMode: ResolveMode = mode
    ): Promise<Result<Loaded, ClosureError>> => {
      const loaded = await loadContent(db, e, contentMode, pin, field);
      if (!loaded.success) return loaded;
      // A published version that froze the entity's own content is read from that snapshot (no read of the live row); a draft source and a
      // version published before snapshots are read from the live row, and the latter is said so in the notes.
      const frozen = loaded.data.snapshot;
      const metadata = frozen ? undefined : await loadMemberMetadata(db, e.id);
      if (!frozen && loaded.data.source !== "draft") legacy.add(e.id);
      entities.push({
        entityId: e.id,
        ref: e.ref,
        source: loaded.data.source,
        ...(loaded.data.version ? { version: loaded.data.version } : {}),
        fields: loaded.data.fields,
        entity: toEntityInput(e, metadata, loaded.data.sequence, frozen),
      });
      applied.set(e.id, pin);
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
        // A bare name that several entities answer to lists them as the question to pick from: it may not list one the caller cannot read.
        if ("ambiguous" in resolved && reader && resolved.ambiguous.some((candidate) => !reader(candidate.place))) return refuse(field.name);
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
              owner: current.ref,
              frozen: current.source !== "draft",
            },
          };
        }
        if ("legacyName" in fieldRef && current.source === "draft") {
          upgrades.push({ entityId: current.entityId, fieldId: field.id, fieldName: field.name, ref: resolved.target.ref });
        }
        const pin = fieldRef.pinnedVersion;
        edges.push({ field: field.name, target: resolved.target, pin });
        if (resolved.target.id !== rootIndexed.id) {
          const list = observed.get(resolved.target.id) ?? [];
          list.push({ field: field.name, owner: index.get(current.entityId) ?? rootIndexed, ownerRef: current.ref, ...(pin ? { pin } : {}) });
          observed.set(resolved.target.id, list);
        }
      }
      graph.set(current.entityId, [...new Set(edges.map((e) => e.target.id))]);

      // Breadth-first by qualified name, a field's name breaking ties.
      edges.sort((a, b) => byQualified(a.target, b.target) || compareStr(a.field, b.field));
      for (const edge of edges) {
        if (seen.has(edge.target.id)) continue;
        // Before the content of the target is read (and before any error about it could name it): the caller's roles must cover it.
        if (reader && !reader(edge.target.place)) return refuse(edge.field);
        if (entities.length >= limit) return { success: false, error: { code: "CLOSURE_TOO_LARGE", limit } };
        const force = forced.get(edge.target.id);
        const loaded = await add(edge.target, force ? force.pin : edge.pin, force ? force.field : edge.field);
        if (!loaded.success) return loaded;
        seen.add(edge.target.id);
      }
    }
    return ok({ entities, graph, upgrades, observed, applied, legacy });
  };

  // A closure resolves each entity ONCE (the emitted files are per entity), so a pin on any edge to an entity applies to it everywhere:
  // walk, look at every edge that reached each entity, and walk again with the pins that were not the first edge's. Two pins that
  // disagree are a conflict. Pins only come from edges, so this settles in a pass or two; the bound only guards a closure whose edges
  // change with the version a pin selects (version 1 of M pins B 1.0, version 2 pins B 2.0), which has no consistent answer.
  const MAX_PASSES = 8;
  const forced = new Map<string, Observation & { pin: string }>();
  let result: Walk | undefined;
  for (let pass = 0; pass < MAX_PASSES; pass++) {
    const walked = await walk(forced);
    if (!walked.success) return walked;
    let again = false;
    for (const [targetId, list] of walked.data.observed) {
      const target = index.get(targetId);
      if (!target) continue;
      const pins = distinctPins(list);
      if (pins.length > 1) {
        return {
          success: false,
          error: { code: "PIN_CONFLICT", ref: target.ref, pins: pins.map((o) => ({ field: o.field, owner: o.ownerRef, version: o.pin as string })) },
        };
      }
      const wanted = pins[0] ? normalizePin(pins[0].pin as string) : undefined;
      const had = walked.data.applied.get(targetId);
      if ((had === undefined ? undefined : normalizePin(had)) === wanted) continue;
      if (pins[0]) forced.set(targetId, { ...pins[0], pin: pins[0].pin as string });
      else forced.delete(targetId);
      again = true;
    }
    if (!again) {
      result = walked.data;
      break;
    }
  }
  if (!result) {
    // Oscillating: report the entity whose pin keeps changing with the content it selects.
    const [id, last] = [...forced.entries()][0] ?? [rootIndexed.id, undefined];
    const target = index.get(id) ?? rootIndexed;
    return {
      success: false,
      error: { code: "PIN_CONFLICT", ref: target.ref, pins: last ? [{ field: last.field, owner: last.ownerRef, version: last.pin }] : [] },
    };
  }

  const { entities, graph, upgrades, observed, legacy } = result;
  const notes: string[] = [];
  for (const entity of entities) {
    const list = observed.get(entity.entityId) ?? [];
    const pinning = distinctPins(list)[0];
    const unpinned = list.filter((o) => !o.pin);
    if (!pinning || unpinned.length === 0) continue;
    const who = (o: Observation) => `${o.ownerRef.entity}.${o.field}`;
    notes.push(
      `${unpinned.map(who).join(", ")} ${unpinned.length === 1 ? "is" : "are"} unpinned but ${who(pinning)} pins ${entity.ref.entity} ${pinning.pin}: the pin was used for both.`
    );
  }
  // A published member whose version froze no entity snapshot (published before snapshots): its name, description, status and metadata are
  // read from the live row, so an edit made since the publish shows through. Said once per member, in closure order.
  for (const entity of entities) {
    if (legacy.has(entity.entityId)) notes.push(`${entity.ref.entity} ${entity.version ?? ""}: metadata read from the live row: published before snapshots.`.replace("  ", " "));
  }

  const labels = new Map(entities.map((e) => [e.entityId, qualifiedName(e.ref)]));
  return ok({
    root: entities[0],
    entities,
    draftEntities: entities.filter((e) => e.source === "draft").map((e) => e.ref),
    cycles: findCycles(graph, (id) => labels.get(id) ?? id),
    upgrades,
    notes,
  });
}
