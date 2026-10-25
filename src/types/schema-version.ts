import type { FieldTargetTypeOverride } from "@/lib/schema-targets/field-type-overrides";
import type { EntityRef } from "@/lib/references/entity-reference";
import type { EmittedFile } from "@/lib/typespec-official/closure-emit";

/** Pure types (nothing here is a runtime import): the shape stored in `entity.metadata.schemaVersions[target][]`. */

export interface FieldTypeMapping {
  fieldName: string;
  sourceType: string;
  targetType: string;
}

/**
 * Which version of each entity of a closure a generation used (multi-entity emission). The ROOT is the first entry (its `ref.entityId`
 * is the entity the schema was generated for); the others are the entities it references, directly or transitively.
 *
 * - `mode`: how unpinned references were resolved. `published`: to the latest PUBLISHED version of each entity (never a draft).
 *   `draft`: to the latest saved definition (drafts included).
 * - `preview`: true when ANY entity's content came from unpublished rows. Such output is a preview and cannot be published as is.
 * - `entities[].source`: `published` / `draft` as the mode resolved it, `pinned` when a field pinned a published version (a pin
 *   overrides the mode). `version` is the MAJOR.MINOR label and is absent for a `draft` source.
 */
export interface SchemaVersionResolution {
  mode: "published" | "draft";
  preview: boolean;
  entities: { ref: EntityRef; version?: string; source: "published" | "draft" | "pinned" }[];
  /** How the references were resolved when that is worth knowing, one sentence each (a pin used for an unpinned edge too, ...). Absent when there is nothing to say. */
  notes?: string[];
}

export interface SchemaVersion {
  version: number;
  status: "draft" | "published" | "deployed";
  /** The bundled `===== path =====` string of `files` (a single file is its bare content); always present, for existing consumers. */
  output: string;
  generatedAt: string;
  entityVersion: number;
  /**
   * The structured form of `output`, one file per entity, each tagged by target. Written by the closure targets (JSON Schema,
   * OpenAPI 3, Protobuf, Avro, Java POJO); absent for the DB targets and for versions stored before multi-entity emission.
   * Do not assume every entity has a file of its own (see `ClosureEmission.entityFiles`).
   */
  files?: EmittedFile[];
  /** Absent exactly when `files` is (same targets, same age). */
  resolution?: SchemaVersionResolution;
  fieldTypeMappings?: FieldTypeMapping[];
  typeOverrideSnapshot?: FieldTargetTypeOverride[];
  overrideDriftSummary?: {
    activeCount: number;
    staleCount: number;
  };
  publishedAt?: string;
  deployedAt?: string;
}

export type SchemaVersionsMap = Record<string, SchemaVersion[]>;
