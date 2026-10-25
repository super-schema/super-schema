/**
 * What a publish freezes about the ENTITY itself (final wave 2b, G7). A version's `fieldSnapshot` freezes the fields and `resolvedSource`
 * the TypeSpec source, but the rest of what an emission reads of an entity (its name, description, status and metadata: tags,
 * deprecation, retention policy, custom aliases / scalars / interfaces / enums / unions / namespace / extensions, relationships) was
 * read from the LIVE row, so a draft edit made after a publish showed up in output generated "from the published version".
 *
 * The snapshot lives in the version's `compatReport` JSON under `entitySnapshot` (next to `referencedVersions`, see
 * `referenced-versions.ts`): no column, no migration. It is read back by {@link readEntitySnapshot}, tolerant on purpose: a version
 * published before this existed (`{}`, `null`, a hand-edited row) reads as none, and the caller falls back to the live row.
 *
 * IDENTITY is not part of it and stays live (the id, the qualified-name segments, the domain): the id is the key and the qualified
 * name is refreshed from it (multi-entity emission spec, decision 4). Pure and client-safe.
 */

export type EntitySnapshot = {
  name: string;
  description: string;
  status: string;
  /** The entity's metadata without `schemaVersions` (the stored generated schemas are bookkeeping the emitters never read). */
  metadata: unknown;
};

const isRecord = (value: unknown): value is Record<string, unknown> => value !== null && typeof value === "object" && !Array.isArray(value);
const own = (object: Record<string, unknown>, key: string): unknown => (Object.prototype.hasOwnProperty.call(object, key) ? object[key] : undefined);

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

/** The part of a `compatReport` a publish writes for the entity itself: `{ entitySnapshot }`. */
export function entitySnapshotReport(entity: { name: string; description: string; status: string; metadata: unknown }): { entitySnapshot: EntitySnapshot } {
  return {
    entitySnapshot: {
      name: entity.name,
      description: entity.description,
      status: entity.status,
      metadata: withoutSchemaVersions(entity.metadata ?? null),
    },
  };
}

/** The entity snapshot a publish stored in `compatReport`, or undefined when the version has none (published before snapshots, malformed). */
export function readEntitySnapshot(compatReport: unknown): EntitySnapshot | undefined {
  if (!isRecord(compatReport)) return undefined;
  const raw = own(compatReport, "entitySnapshot");
  if (!isRecord(raw)) return undefined;
  const name = own(raw, "name");
  const description = own(raw, "description");
  const status = own(raw, "status");
  if (typeof name !== "string" || typeof description !== "string" || typeof status !== "string") return undefined;
  // (a hand-edited or older row may still carry the stored schema versions inside: they are never handed out)
  return { name, description, status, metadata: withoutSchemaVersions(own(raw, "metadata") ?? null) };
}
