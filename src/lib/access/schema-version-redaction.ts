/**
 * Stored generated schemas at the READ boundary (KD-046).
 *
 * `generateSchemaAction` stores each result in the entity's `metadata.schemaVersions[target][n]`: the bundled `output`, the generated `files` (one per
 * entity of the reference closure, each tagged with its `entityId`) and the `resolution` (which entities and versions were used). Since KD-045 nobody
 * can GENERATE a closure that holds an entity they may not read, but a version made earlier by a wider role (a tenant administrator) stays stored
 * with the files of every entity it drew on, and whoever reads the root entity could read them. So every reader of the stored versions asks this module,
 * which returns the reader a COPY holding only what the reader's roles cover (the stored value is never changed: the writers keep working on the full
 * one, and tenant / platform administrators and holders covering every referenced entity get the copy equal to the stored version).
 *
 * The rule for one version:
 *  - an entity of the closure counts as unreadable when the reader's roles do not give `entity.read` over its own place (`entityReader`); an entity that
 *    no longer exists is judged as a tenant-level entity of the root's tenant (the least reachable place: tenant and platform roles only);
 *  - with no unreadable entity the version is returned as stored;
 *  - otherwise the files of unreadable entities are dropped (a file with no `entityId` is the root's and stays), `output` is REBUILT from the files that
 *    are left with the generator's own bundling (never cut out of the stored string), the unreadable entities leave the resolution (and so does its free
 *    text `notes`, which may name them), and the copy says how much was held back (`redacted`);
 *  - TWO kinds of file carry more than the entity they are tagged with, and for those the version cannot be shown in part: the files of the
 *    self-contained targets (OpenAPI and Avro inline the definitions of the entities a file refers to, and the reference graph is not stored) and a file
 *    shared by a cycle (Protobuf: tagged with the first member only; a member that no file of the version is tagged with is served by such a file). In
 *    either case, when the closure holds an unreadable entity, NO file of the version is shown: showing less than all of it would show the unreadable
 *    entity's definition inside the root's own file.
 *
 * Pure (`redactSchemaVersionsMap`) plus one lookup of the places of the entities to judge (`redactSchemaVersions`).
 */

import { bundleFileContents } from "@/lib/typespec-official/bundle";
import type { SchemaVersion, SchemaVersionRedaction, SchemaVersionsMap } from "@/types/schema-version";
import { entityReader, type EntityPlace } from "./entity-reader";
import type { Assignment } from "./scope";

/** Targets whose every file is self-contained: it inlines the definitions of the entities it refers to (`closure-emit.ts`, "How each target links the files"). */
export const SELF_CONTAINED_TARGETS: ReadonlySet<string> = new Set(["openapi3", "avro"]);

/** The note a reader sees next to a version that was redacted, in the words of the screen. */
export function HIDDEN_FILES_NOTE(count: number): string {
  return count === 1 ? "1 file of referenced entities is hidden for your role" : `${count} files of referenced entities are hidden for your role`;
}

type StoredFile = { path: string; content: string; target?: string; entityId?: string };

const isRecord = (value: unknown): value is Record<string, unknown> => typeof value === "object" && value !== null && !Array.isArray(value);
const isStoredFile = (value: unknown): value is StoredFile =>
  isRecord(value) && typeof value.path === "string" && typeof value.content === "string" && (value.entityId === undefined || typeof value.entityId === "string");

/** The entity a stored file was written for: its tag, or the root for a file with none. */
const belongsTo = (file: StoredFile, rootEntityId: string): string => file.entityId ?? rootEntityId;

/** The ids of the entities of a stored resolution (entries of any other shape are ignored). */
function resolutionIds(resolution: unknown): string[] {
  if (!isRecord(resolution) || !Array.isArray(resolution.entities)) return [];
  return resolution.entities.flatMap((entry) => (isRecord(entry) && isRecord(entry.ref) && typeof entry.ref.entityId === "string" ? [entry.ref.entityId] : []));
}

export type RedactionInput = {
  /** The entity the versions are stored on, which the reader was authorized for before anything is read. Its own files always pass. */
  rootEntityId: string;
  /** May the reader read the entity with this id? Asked for every other entity named by a file or the resolution. */
  mayRead: (entityId: string) => boolean;
};

function redactVersion(raw: unknown, targetKey: string, input: RedactionInput): SchemaVersion | null {
  if (!isRecord(raw)) return null;
  const version = raw as unknown as SchemaVersion;
  const { rootEntityId } = input;
  const may = (id: string): boolean => id === rootEntityId || input.mayRead(id);

  const storedFiles = Array.isArray(version.files) ? version.files : undefined;
  const files = storedFiles?.filter(isStoredFile);
  const members = new Set<string>([...resolutionIds(version.resolution), ...(files ?? []).map((file) => belongsTo(file, rootEntityId))]);
  members.delete(rootEntityId);
  const unreadable = [...members].filter((id) => !may(id));
  const droppedMalformed = storedFiles !== undefined && files !== undefined && files.length !== storedFiles.length;

  if (unreadable.length === 0 && !droppedMalformed) return version;

  // The files that stay.
  let kept = files;
  if (files !== undefined && unreadable.length > 0) {
    const tagged = new Set(files.map((file) => belongsTo(file, rootEntityId)));
    const selfContained = SELF_CONTAINED_TARGETS.has(targetKey) || files.some((file) => file.target !== undefined && SELF_CONTAINED_TARGETS.has(file.target));
    const servedBySharedFile = unreadable.some((id) => !tagged.has(id));
    kept = selfContained || servedBySharedFile ? [] : files.filter((file) => may(belongsTo(file, rootEntityId)));
  }

  const copy: SchemaVersion = { ...version };
  if (files !== undefined && kept !== undefined) {
    const changed = kept.length !== files.length;
    copy.files = kept as unknown as SchemaVersion["files"];
    if (changed) copy.output = bundleFileContents(kept.map((file) => ({ path: file.path, content: file.content })));
  }
  if (unreadable.length > 0) {
    if (isRecord(version.resolution) && Array.isArray(version.resolution.entities)) {
      const rest: Record<string, unknown> = { ...(version.resolution as unknown as Record<string, unknown>) };
      delete rest.notes;
      copy.resolution = {
        ...rest,
        entities: version.resolution.entities.filter((entry) => {
          const id = isRecord(entry) && isRecord(entry.ref) ? entry.ref.entityId : undefined;
          return typeof id === "string" && may(id);
        }),
      } as unknown as SchemaVersion["resolution"];
    }
    const redacted: SchemaVersionRedaction = { hiddenFiles: (files?.length ?? 0) - (kept?.length ?? 0), hiddenEntities: unreadable.length };
    copy.redacted = redacted;
  }
  return copy;
}

/**
 * The stored versions as a reader may see them (see the module comment). Anything that is not a map of arrays of objects is left out: stored data of
 * an unknown shape cannot be judged and is never passed on.
 */
export function redactSchemaVersionsMap(map: unknown, input: RedactionInput): SchemaVersionsMap {
  const out: SchemaVersionsMap = {};
  if (!isRecord(map)) return out;
  for (const [target, versions] of Object.entries(map)) {
    if (target === "__proto__") continue;
    out[target] = Array.isArray(versions) ? versions.flatMap((version) => redactVersion(version, target, input) ?? []) : [];
  }
  return out;
}

/** The ids of the entities (other than the root) a stored map names, by a file or by a resolution: what has to be judged before it is shown. */
export function entityIdsToJudge(map: unknown, rootEntityId: string): string[] {
  const ids = new Set<string>();
  if (!isRecord(map)) return [];
  for (const versions of Object.values(map)) {
    if (!Array.isArray(versions)) continue;
    for (const version of versions) {
      if (!isRecord(version)) continue;
      for (const id of resolutionIds(version.resolution)) ids.add(id);
      if (Array.isArray(version.files)) for (const file of version.files) if (isStoredFile(file)) ids.add(belongsTo(file, rootEntityId));
    }
  }
  ids.delete(rootEntityId);
  return [...ids];
}

/** How many files were held back across a redacted map (the screen's note). */
export function hiddenFileCount(map: SchemaVersionsMap): number {
  return Object.values(map).reduce((sum, versions) => sum + versions.reduce((n, version) => n + (version.redacted?.hiddenFiles ?? 0), 0), 0);
}

type PlaceRow = { id: string; tenantId: string; domainId: string | null; productId: string | null; product: { domainId: string | null } | null };

/** What the lookup of places needs of the database client (`prisma` or a transaction client satisfies it). */
export type EntityPlaceSource = {
  entity: {
    findMany: (args: {
      where: { id: { in: string[] } };
      select: { id: true; tenantId: true; domainId: true; productId: true; product: { select: { domainId: true } } };
    }) => PromiseLike<PlaceRow[]>;
  };
};

export type RedactionRoot = {
  entityId: string;
  /** The root's own place (its tenant, domain and product): the root is also the tenant a deleted entity is judged in. */
  place: EntityPlace;
};

/**
 * The stored versions of the entity `root`, as the holder of `assignments` may see them. The reader must hold `entity.read` over the root (the caller
 * authorized it before reading anything); if they do not, nothing is returned. One query for the places of the entities the map names, none when it
 * names only the root.
 */
export async function redactSchemaVersions(
  db: EntityPlaceSource,
  map: unknown,
  args: { root: RedactionRoot; assignments: readonly Assignment[] | undefined }
): Promise<SchemaVersionsMap> {
  const { root } = args;
  const reader = entityReader(args.assignments);
  if (!reader(root.place)) return {};
  const ids = entityIdsToJudge(map, root.entityId);
  const readable = new Set<string>();
  if (ids.length > 0) {
    const rows = await db.entity.findMany({
      where: { id: { in: ids } },
      select: { id: true, tenantId: true, domainId: true, productId: true, product: { select: { domainId: true } } },
    });
    const found = new Set<string>();
    for (const row of rows) {
      found.add(row.id);
      if (reader({ tenantId: row.tenantId, domainId: row.domainId ?? row.product?.domainId ?? null, productId: row.productId ?? null })) readable.add(row.id);
    }
    // Gone since the version was made: judged as a tenant-level entity of the root's tenant.
    if (reader({ tenantId: root.place.tenantId, domainId: null, productId: null })) for (const id of ids) if (!found.has(id)) readable.add(id);
  }
  return redactSchemaVersionsMap(map, { rootEntityId: root.entityId, mayRead: (id) => readable.has(id) });
}

/** An entity's metadata with its stored versions redacted for the reader (metadata with no versions is returned as it is). */
export async function redactEntityMetadata<M>(db: EntityPlaceSource, metadata: M, args: { root: RedactionRoot; assignments: readonly Assignment[] | undefined }): Promise<M> {
  if (!isRecord(metadata) || !Object.prototype.hasOwnProperty.call(metadata, "schemaVersions")) return metadata;
  return { ...metadata, schemaVersions: await redactSchemaVersions(db, metadata.schemaVersions, args) } as M;
}

/**
 * An entity's metadata WITHOUT its stored versions, for the views that never show them (a list, a page prop, a retention table): the safest redaction is
 * the one that hands over nothing. A copy; the value is returned as it is when there is nothing to drop.
 */
export function omitSchemaVersions<M>(metadata: M): M {
  if (!isRecord(metadata) || !Object.prototype.hasOwnProperty.call(metadata, "schemaVersions")) return metadata;
  const rest: Record<string, unknown> = { ...metadata };
  delete rest.schemaVersions;
  return rest as M;
}

/**
 * A stored audit state (`before_state` / `after_state`) without the entity's stored versions. The entries of an entity's audit trail hold the whole
 * row (or `{ metadata }`) as it was, and a reader of the change log is any reader of the entity; the versions are not part of what the log shows.
 */
export function withoutStoredSchemaVersions(state: unknown): unknown {
  if (!isRecord(state)) return state;
  const top = omitSchemaVersions(state);
  const nested = isRecord(top.metadata) ? omitSchemaVersions(top.metadata) : undefined;
  return nested !== undefined && nested !== top.metadata ? { ...top, metadata: nested } : top;
}
