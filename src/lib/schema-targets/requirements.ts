/**
 * requirements.ts — inputs a target NEEDS that the entity may not carry yet (pure).
 *
 * Some emitters refuse an entity that lacks a piece of target-specific information (BigQuery, PostgreSQL and Spanner:
 * `missing-primary-key`). Instead of failing with an error string, generation asks the user for that piece. Each target lists
 * requirement CHECKS; a check returns a missing requirement or null. A new required input (partition column, ...) is one more
 * check plus a new `code` — the UI renders whatever the list holds.
 */

/** The minimal structural input: what the checks read of an entity. */
export interface RequirementField {
  name: string;
  isKey: boolean;
  nullable: boolean;
  type: string;
}
export interface RequirementEntityShape {
  name: string;
  fields: readonly RequirementField[];
}

/** A required input that is missing. `suggested` is a SUGGESTION for the form, never applied silently. */
export interface MissingRequirement {
  code: "primary-key";
  message: string;
  /** Every field the user may pick (all fields that are not keys). */
  candidates: string[];
  /** A pre-selection for the form (may be empty). */
  suggested: string[];
}

export interface TargetRequirements {
  missing: MissingRequirement[];
}

type RequirementCheck = (entity: RequirementEntityShape) => MissingRequirement | null;

const KEY_NAMES = new Set(["id", "uuid", "key"]);
const KEYLIKE_TYPES = /^(string|int8|int16|int32|int64|uint8|uint16|uint32|uint64|integer|safeint|uuid)$/i;
const compact = (text: string): string => text.toLowerCase().replace(/[^a-z0-9]/g, "");

/** The default selection: `id` / `<entity>_id` / `<entity>Id` / `uuid` / `key`; else the first required string/integer field; else none. */
export function suggestPrimaryKey(entity: RequirementEntityShape): string[] {
  const fields = entity.fields.filter((field) => !field.isKey);
  const entityId = `${compact(entity.name)}id`;
  const named = fields.find((field) => field.name === "id") ??
    fields.find((field) => compact(field.name) === entityId) ??
    fields.find((field) => KEY_NAMES.has(field.name.toLowerCase()));
  if (named) return [named.name];
  const required = fields.find((field) => !field.nullable && KEYLIKE_TYPES.test(field.type));
  return required ? [required.name] : [];
}

/** The primary-key question for `entity`, whether or not a key is flagged (candidates are the non-key fields). */
export function primaryKeyRequirement(entity: RequirementEntityShape): MissingRequirement {
  return {
    code: "primary-key",
    message: `${entity.name || "This entity"} has no primary key. This target needs at least one field that identifies a row.`,
    candidates: entity.fields.filter((field) => !field.isKey).map((field) => field.name),
    suggested: suggestPrimaryKey(entity),
  };
}

const primaryKeyCheck: RequirementCheck = (entity) =>
  entity.fields.some((field) => field.isKey) ? null : primaryKeyRequirement(entity);

const REQUIREMENTS_BY_TARGET: Readonly<Record<string, readonly RequirementCheck[]>> = {
  bigquery: [primaryKeyCheck],
  postgresql: [primaryKeyCheck],
  spanner: [primaryKeyCheck],
};

/** True when `targetId` has any requirement check (lets callers skip loading the entity for targets that need nothing). */
export function hasTargetRequirements(targetId: string): boolean {
  return Object.hasOwn(REQUIREMENTS_BY_TARGET, targetId) && REQUIREMENTS_BY_TARGET[targetId].length > 0;
}

/** What `targetId` still needs from the user for `entity`; `{ missing: [] }` for a target with no requirements (or an unknown one). */
export function getTargetRequirements(targetId: string, entity: RequirementEntityShape): TargetRequirements {
  const checks = Object.hasOwn(REQUIREMENTS_BY_TARGET, targetId) ? REQUIREMENTS_BY_TARGET[targetId] : [];
  const missing: MissingRequirement[] = [];
  for (const check of checks) {
    const result = check(entity);
    if (result) missing.push(result);
  }
  return { missing };
}
