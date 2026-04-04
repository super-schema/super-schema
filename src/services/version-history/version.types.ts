/**
 * Version History Types
 *
 * Types for version snapshots and diffs.
 * MVP: snapshots stored in entity metadata JSONB under `versionHistory` key.
 */

/** Snapshot of a single field at a point in time */
export interface FieldSnapshot {
  id: string;
  name: string;
  type: string;
  precision: number | null;
  scale: number | null;
  nullable: boolean;
  isKey: boolean;
  fieldNumber: number | null;
  description: string;
  classification: string | null;
  aliases: string[];
  decorators: Record<string, unknown>;
  sortOrder: number;
}

/** Snapshot of entity metadata at a point in time */
export interface EntitySnapshot {
  id: string;
  name: string;
  description: string;
  status: string;
  version: number;
  domainId: string;
  metadata: Record<string, unknown> | null;
}

/** Complete snapshot capturing entity + fields state at a point in time */
export interface VersionSnapshot {
  version: number;
  timestamp: string;
  createdBy: string;
  snapshot: {
    entity: EntitySnapshot;
    fields: FieldSnapshot[];
  };
  changeRecord: ChangeRecord | null;
}

/** A single change entry describing what changed in one field */
export interface ChangeEntry {
  type: "added" | "removed" | "modified";
  fieldName: string;
  details: {
    before?: FieldSnapshot;
    after?: FieldSnapshot;
    changedProperties: string[];
  };
}

/** Change record describing differences between two versions */
export interface ChangeRecord {
  previousVersion: number;
  changes: ChangeEntry[];
}

/** Result of comparing two version snapshots */
export interface VersionDiff {
  fromVersion: number;
  toVersion: number;
  changes: ChangeEntry[];
  summary: {
    added: number;
    removed: number;
    modified: number;
  };
}

/** A single property-level change within a modified field */
export interface PropertyChange {
  property: string;
  category: string;
  before: unknown;
  after: unknown;
}

/** A field entry in the structured diff result */
export interface DiffField {
  fieldName: string;
  changeType: "added" | "removed" | "modified" | "unchanged";
  versionA?: FieldSnapshot;
  versionB?: FieldSnapshot;
  changedProperties?: PropertyChange[];
}

/** Structured diff result with summary and per-field details */
export interface DiffResult {
  fromVersion: number;
  toVersion: number;
  summary: {
    added: number;
    removed: number;
    modified: number;
    unchanged: number;
  };
  fields: DiffField[];
}
