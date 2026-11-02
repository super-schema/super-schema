/**
 * Git Export Service
 *
 * Handles Git repository configuration and schema export operations.
 * Pure helper functions for file path building and commit message formatting
 * are exported separately for unit testing.
 *
 * Service functions interact with Prisma and wrap operations in withAudit().
 */

import { ctxCan } from "@/lib/access";
import { prisma } from "@/lib/db";
import { withAudit } from "@/lib/audit";
import { ok, err } from "@/types/result";
import type { Result } from "@/types/result";
import type { ServiceContext } from "@/types/service-context";
import {
  ConfigureRepositoryInputSchema,
  FORMAT_EXTENSIONS,
  type ConfigureRepositoryInput,
  type ExportFormat,
  type GitExportResult,
  type GitConfigResponse,
} from "@/types/schemas/git";
import type { TargetOutput } from "@/lib/emission/emission.types";
import type { SchemaVersion } from "@/types/schema-version";
import { domainLabel } from "@/lib/entity-placement";
import { getSchemaTargetCatalog, getSchemaTargetDefinition } from "@/lib/schema-targets/catalog";
import { TENANT_PLACEHOLDER } from "@/lib/references/entity-reference";
import { withoutSchemaVersions } from "@/lib/references/closure";
import { SecretBoxError, sealSecret } from "@/lib/crypto/secret-box";

// ---------------------------------------------------------------------------
// Pure helper functions (no I/O — unit-testable)
// ---------------------------------------------------------------------------

/**
 * Build the export file path for a given entity and format.
 *
 * @param basePath - Root path inside the repo (e.g., "schemas/")
 * @param domainSlug - Domain name slugified (lowercase, hyphens)
 * @param entityName - Entity name slugified (lowercase, hyphens)
 * @param format - The export format
 * @returns The full file path, e.g., "schemas/payments/transaction.superschema.json"
 */
export function buildExportFilePath(
  basePath: string,
  domainSlug: string,
  entityName: string,
  format: ExportFormat
): string {
  const normalizedBase = basePath.endsWith("/") ? basePath : `${basePath}/`;
  const slug = entityName.toLowerCase().replace(/\s+/g, "-");
  const domainDir = domainSlug.toLowerCase().replace(/\s+/g, "-");
  const extension = FORMAT_EXTENSIONS[format];
  return `${normalizedBase}${domainDir}/${slug}${extension}`;
}

/**
 * Build a Git commit message for an entity export.
 *
 * @param entityName - The entity display name
 * @param version - The entity version number
 * @param changeSummary - Brief description of what changed
 * @returns Formatted commit message
 */
export function buildCommitMessage(
  entityName: string,
  version: number,
  changeSummary: string
): string {
  return `Update ${entityName} v${version} — ${changeSummary}`;
}

/**
 * Build a bulk export commit message.
 *
 * @param count - Number of entities exported
 * @returns Formatted commit message
 */
export function buildBulkCommitMessage(count: number): string {
  return `Bulk export — ${count} entities`;
}

/**
 * Slugify a string for use in file paths.
 */
export function slugify(value: string): string {
  return value
    .toLowerCase()
    .replace(/[^a-z0-9]+/g, "-")
    .replace(/^-|-$/g, "");
}

// ---------------------------------------------------------------------------
// Export file sets
//
// Layout of an entity that has generated schemas (`entity.metadata.schemaVersions`):
//
//   <base>/<domain|_tenant>/<product|_tenant>/<entity>/<entity>.superschema.json
//   <base>/<domain|_tenant>/<product|_tenant>/<entity>/<target>/<file path of the stored version>
//
// Rulings (multi-entity emission, Task 10):
// - Version: per target, the latest PUBLISHED (or deployed) version, else the latest version (see `pickExportVersion`). A warning
//   says when a newer draft was not exported, or when the exported version is a draft (a preview, when it references drafts).
// - Files: the version's `files` (path as stored); a version without `files` writes its `output` as one file named
//   `<entity><extension of the target>`.
// - Every entity folder is SELF-CONTAINED: it holds the root's FULL file set, i.e. every file of the picked version whatever its
//   `entityId` (the referenced entities' files included), so the references between the files (`$ref: "Address.json"`, qualified
//   names such as `Billing.Customer.json`, Protobuf imports, Avro full names) resolve inside the folder. An entity that is exported
//   too has its own folder with its own full set: content repeats across folders on purpose (a folder is a deployable unit).
// - A file whose path is unsafe (see `sanitizeExportFilePath`) is SKIPPED with a warning; the rest of the export goes ahead.
// - Two files on one path: the first is kept, and a warning says so when their content differs. Paths that differ only by letter
//   case, or that would be a file and a directory of the same name, are not both written (the first is kept, with a warning).
// - An entity with NO generated version and only the legacy `emittedOutputs` keeps the old flat layout, exactly as before.
// ---------------------------------------------------------------------------

/** A file of the export: `path` includes the base path. */
export interface ExportFile {
  path: string;
  content: string;
}

/** Longest relative path of a stored file, and longest segment of one in UTF-8 bytes (a file system's limit). */
const MAX_EXPORT_PATH_LENGTH = 512;
const MAX_EXPORT_SEGMENT_BYTES = 255;

/** Longest folder name made of a name (domain, product, entity). */
const MAX_FOLDER_SLUG_LENGTH = 100;

/** Warnings returned by one export; the rest is counted ("and N more warnings"). */
const MAX_EXPORT_WARNINGS = 50;

/** Folder for a domain, product or entity whose name has no letters or digits to slug. */
const UNNAMED_SEGMENT = "_unnamed";

/** Names Windows reserves for devices, with or without an extension (`con`, `CON.txt`, `lpt1.log`). */
const WINDOWS_RESERVED_NAME = /^(con|prn|aux|nul|com[1-9]|lpt[1-9])$/i;

/**
 * Code points HFS+ ignores when it compares names (zero-width and bidirectional marks, the BOM, the soft hyphen): `.g<U+200C>it`
 * is `.git` there. A stored path has no use for them.
 */
const INVISIBLE_CODE_POINTS = /[­​-‏‪-‮⁠-⁯﻿]/;

/** The legacy `emittedOutputs` emitters that were exported, and the format (extension) each one used. */
const LEGACY_EMITTER_FORMATS: ReadonlyMap<string, ExportFormat> = new Map([
  ["bigquery", "bigquery"],
  ["avro", "avro"],
  ["openapi", "openapi"],
]);

/** Extension of the single file written for a target's `output` string; the first three are the ones used before file sets. */
const TARGET_EXTENSIONS: ReadonlyMap<string, string> = new Map([
  ["bigquery", FORMAT_EXTENSIONS.bigquery],
  ["avro", FORMAT_EXTENSIONS.avro],
  ["openapi", FORMAT_EXTENSIONS.openapi],
  ["openapi3", FORMAT_EXTENSIONS.openapi],
  ["json-schema", ".schema.json"],
  ["protobuf", ".proto"],
  ["java-pojo", ".java"],
  ["spanner", ".spanner.sql"],
  ["postgresql", ".pg.sql"],
]);

const LANGUAGE_EXTENSIONS: ReadonlyMap<string, string> = new Map([
  ["sql", ".sql"],
  ["json", ".json"],
  ["yaml", ".yaml"],
  ["java", ".java"],
  ["typescript", ".ts"],
  ["python", ".py"],
  ["csharp", ".cs"],
  ["protobuf", ".proto"],
]);

/** The extension of the file a target's `output` string is written to when its version has no `files`. */
export function targetFileExtension(target: string): string {
  const known = TARGET_EXTENSIONS.get(target);
  if (known !== undefined) return known;
  const language = getSchemaTargetDefinition(target)?.outputLanguage;
  return (language !== undefined ? LANGUAGE_EXTENSIONS.get(language) : undefined) ?? ".txt";
}

const isRecord = (value: unknown): value is Record<string, unknown> =>
  typeof value === "object" && value !== null && !Array.isArray(value);

const hasOwn = (object: object, key: string): boolean => Object.prototype.hasOwnProperty.call(object, key);

/** Windows reads `con`, `con.txt` and `CON.tar.gz` alike: the part before the first dot decides, and trailing spaces are dropped. */
function isReservedDeviceName(segment: string): boolean {
  return WINDOWS_RESERVED_NAME.test(segment.split(".")[0].replace(/ +$/, ""));
}

export type SanitizedExportPath = { ok: true; path: string } | { ok: false; reason: string };

/**
 * Checks the path of a stored file before it is joined to the base path: relative, forward slashes (backslashes are converted),
 * no control or invisible characters, no drive letter or colon, no empty / `.` / `..` / dots-only segment, no `.git` segment (a file
 * there would write into the repository's own metadata) and no Windows device name, bounded length (a segment by its UTF-8 bytes).
 * The value comes from stored JSON, so it is not trusted.
 */
export function sanitizeExportFilePath(raw: unknown): SanitizedExportPath {
  if (typeof raw !== "string" || raw === "") return { ok: false, reason: "empty path" };
  if (/[\u0000-\u001f\u007f]/.test(raw)) return { ok: false, reason: "control character in path" };
  if (INVISIBLE_CODE_POINTS.test(raw)) return { ok: false, reason: "invisible character in path" };
  const path = raw.replace(/\\/g, "/");
  if (path.startsWith("/")) return { ok: false, reason: "absolute path" };
  if (/^[A-Za-z]:/.test(path)) return { ok: false, reason: "drive letter in path" };
  if (path.length > MAX_EXPORT_PATH_LENGTH) return { ok: false, reason: "path too long" };
  for (const segment of path.split("/")) {
    if (segment === "") return { ok: false, reason: "empty segment in path" };
    if (new TextEncoder().encode(segment).length > MAX_EXPORT_SEGMENT_BYTES) return { ok: false, reason: "segment too long" };
    if (segment.includes(":")) return { ok: false, reason: "colon in path" };
    // `.`, `..` and, on Windows, names that read as them once trailing dots and spaces are dropped.
    if (/^[. ]+$/.test(segment)) return { ok: false, reason: "dot segment in path" };
    // `.git`, also as Windows reads it (trailing dots and spaces dropped) and as its NTFS short name `git~1`.
    const bare = segment.replace(/[. ]+$/, "").toLowerCase();
    if (bare === ".git" || /^git~\d+$/.test(bare)) return { ok: false, reason: "git metadata directory in path" };
    if (isReservedDeviceName(segment)) return { ok: false, reason: "reserved device name in path" };
  }
  return { ok: true, path };
}

const versionNumber = (version: SchemaVersion): number => (typeof version.version === "number" ? version.version : 0);

const isPublishedVersion = (version: SchemaVersion): boolean => version.status === "published" || version.status === "deployed";

/** The version with the highest number (the first of equals). */
const latestOf = (list: SchemaVersion[]): SchemaVersion | undefined =>
  list.reduce<SchemaVersion | undefined>((best, version) => (best === undefined || versionNumber(version) > versionNumber(best) ? version : best), undefined);

/** The version to export and the newest version of any status; a list entry that is not an object is ignored. */
function selectVersion(versions: readonly SchemaVersion[]): { version: SchemaVersion; newest: SchemaVersion } | undefined {
  const usable = versions.filter((version): version is SchemaVersion => isRecord(version));
  const newest = latestOf(usable);
  if (newest === undefined) return undefined;
  return { version: latestOf(usable.filter(isPublishedVersion)) ?? newest, newest };
}

/**
 * The version of a target the export writes: the latest PUBLISHED (or deployed) one, else the latest of any status. "Latest" is
 * the highest version number, so the order of the list does not matter. A list entry that is not an object is ignored.
 */
export function pickExportVersion(versions: readonly SchemaVersion[]): SchemaVersion | undefined {
  return selectVersion(versions)?.version;
}

/** For every catalog target the entity has versions of, in catalog order: the version to export and the newest one. */
function selectedVersions(schemaVersions: unknown): Array<{ target: string; version: SchemaVersion; newest: SchemaVersion }> {
  const byTarget = isRecord(schemaVersions) ? schemaVersions : {};
  const selected: Array<{ target: string; version: SchemaVersion; newest: SchemaVersion }> = [];
  for (const { key } of getSchemaTargetCatalog()) {
    const versions = hasOwn(byTarget, key) ? byTarget[key] : undefined;
    if (!Array.isArray(versions)) continue;
    const choice = selectVersion(versions as SchemaVersion[]);
    if (choice) selected.push({ target: key, ...choice });
  }
  return selected;
}

/** A stored file of a version, its path checked. */
type StoredFile = { path: string; content: string };

/**
 * The folder name of a domain, product or entity: its slug, at most 100 characters, never a Windows device name (`con` is `con_`),
 * `_unnamed` when the name has no letters or digits.
 */
function folderSlug(name: string): string {
  const slug = slugify(name).slice(0, MAX_FOLDER_SLUG_LENGTH).replace(/-+$/, "");
  if (slug === "") return UNNAMED_SEGMENT;
  return isReservedDeviceName(slug) ? `${slug}_` : slug;
}

/** The domain / product folder: the `_tenant` placeholder for no domain or product, else the slug of the name. */
function placeSegment(name: string | null | undefined): string {
  if (typeof name !== "string" || name.trim() === "") return TENANT_PLACEHOLDER;
  return folderSlug(name);
}

/** The files of a version: `files` when it has any, else its `output` as one file. Unsafe or malformed entries are skipped, with a warning. */
function storedFilesOfVersion(version: SchemaVersion, target: string, entitySlug: string, entityName: string, warnings: string[]): StoredFile[] {
  const skip = (what: string, reason: string) => warnings.push(`${entityName}: ${target}: skipped ${what}: ${reason}`);
  if (Array.isArray(version.files) && version.files.length > 0) {
    const stored: StoredFile[] = [];
    for (const raw of version.files as unknown[]) {
      if (!isRecord(raw) || typeof raw.path !== "string" || typeof raw.content !== "string") {
        skip("a malformed file entry", "it has no path or no content");
        continue;
      }
      const checked = sanitizeExportFilePath(raw.path);
      if (!checked.ok) {
        skip(`file ${JSON.stringify(raw.path.slice(0, 120))}`, checked.reason);
        continue;
      }
      stored.push({ path: checked.path, content: raw.content });
    }
    return stored;
  }
  if (typeof version.output === "string" && version.output !== "") {
    return [{ path: `${entitySlug}${targetFileExtension(target)}`, content: version.output }];
  }
  return [];
}

/** What the export reads of one entity. `schemaVersions` and `emittedOutputs` are `entity.metadata`'s keys of those names. */
export interface GitExportEntityInput {
  name: string;
  /** `null` / absent: a tenant-level entity (folder `_tenant`). */
  domainName?: string | null;
  productName?: string | null;
  /** The content of the entity's SuperSchema JSON. */
  definition: Record<string, unknown>;
  /** Legacy: the outputs the first emission pipeline stored. Only read for entities without `schemaVersions`, and for a target without a version. */
  emittedOutputs?: Record<string, TargetOutput>;
  /** `SchemaVersionsMap`; anything else (stored JSON is not trusted) reads as no versions. */
  schemaVersions?: unknown;
}

export interface ExportPlan {
  files: ExportFile[];
  /** What was skipped, kept apart or not exported (at most 50, then a count), for the person who exports; the export itself went ahead. */
  warnings: string[];
}

/** One row of the PR body's target table: what the export writes of a target. */
export interface ExportedTargetSummary {
  target: string;
  displayName: string;
  version: number;
  status: SchemaVersion["status"];
  /** Files written for the target in the entity's folder (distinct paths). */
  fileCount: number;
  /** The version references unpublished drafts. */
  preview?: boolean;
}

/** The targets an export of the entity writes, in catalog order, each with the version picked by {@link pickExportVersion}. */
export function exportedTargetSummary(input: GitExportEntityInput): ExportedTargetSummary[] {
  const entitySlug = folderSlug(input.name);
  return selectedVersions(input.schemaVersions).map(({ target, version }) => {
    const files = storedFilesOfVersion(version, target, entitySlug, input.name, []);
    return {
      target,
      displayName: getSchemaTargetDefinition(target)?.displayName ?? target,
      version: versionNumber(version),
      status: version.status,
      fileCount: new Set(files.map((file) => file.path)).size,
      ...(version.resolution?.preview === true ? { preview: true } : {}),
    };
  });
}

interface PlannedEntity {
  input: GitExportEntityInput;
  /** `<base><domain>/<product>/<entity>` (no trailing slash). */
  dir: string;
  entitySlug: string;
  /** Per target with a version, the FULL file set of the picked version (catalog order). */
  selected: Map<string, StoredFile[]>;
  /** Legacy `emittedOutputs` that the old export knew, as `[emitter, format, content]`. */
  legacy: Array<[string, ExportFormat, string]>;
}

/** What to tell about the version picked for a target: a newer draft left out, or a draft exported because nothing is published. */
function versionNote(version: SchemaVersion, newest: SchemaVersion): string | undefined {
  if (isPublishedVersion(version)) {
    return versionNumber(newest) > versionNumber(version)
      ? `exported published v${versionNumber(version)}; newer draft v${versionNumber(newest)} not exported`
      : undefined;
  }
  return `exported draft v${versionNumber(version)}${version.resolution?.preview === true ? " (preview)" : ""}`;
}

function planEntity(base: string, input: GitExportEntityInput, warnings: string[]): PlannedEntity {
  const entitySlug = folderSlug(input.name);
  const dir = `${base}${placeSegment(input.domainName)}/${placeSegment(input.productName)}/${entitySlug}`;

  const selected = new Map<string, StoredFile[]>();
  for (const { target, version, newest } of selectedVersions(input.schemaVersions)) {
    selected.set(target, storedFilesOfVersion(version, target, entitySlug, input.name, warnings));
    const note = versionNote(version, newest);
    if (note !== undefined) warnings.push(`${input.name}: ${target}: ${note}`);
  }

  const legacy: PlannedEntity["legacy"] = [];
  if (isRecord(input.emittedOutputs)) {
    for (const [emitter, output] of Object.entries(input.emittedOutputs)) {
      const format = LEGACY_EMITTER_FORMATS.get(emitter);
      if (format !== undefined && isRecord(output) && typeof output.output === "string") legacy.push([emitter, format, output.output]);
    }
  }

  return { input, dir, entitySlug, selected, legacy };
}

/**
 * Remembers the paths of an export. A path is refused (and a warning says why) when it was taken already, when it differs from a
 * taken one only by letter case (the two would overwrite each other on a case-insensitive file system), or when it would be a file
 * and a directory of the same name.
 */
function createPathClaims(warnings: string[]): (path: string, content: string) => ExportFile | undefined {
  const files = new Map<string, ExportFile>();
  const directories = new Set<string>();
  return (path, content) => {
    const key = path.toLowerCase();
    const kept = files.get(key);
    if (kept !== undefined) {
      if (kept.path !== path) warnings.push(`${path}: differs only by letter case from ${kept.path}, which was kept; this file was skipped`);
      else if (kept.content !== content) warnings.push(`${path}: two files were exported to this path with different content; the first one was kept`);
      return undefined;
    }
    const segments = key.split("/");
    const prefixes = segments.slice(0, -1).map((_, index) => segments.slice(0, index + 1).join("/"));
    const blocking = prefixes.map((prefix) => files.get(prefix)).find((file) => file !== undefined);
    if (blocking !== undefined) {
      warnings.push(`${path}: ${blocking.path} is a file, so this path cannot be inside it; this file was skipped`);
      return undefined;
    }
    if (directories.has(key)) {
      warnings.push(`${path}: a directory of this name is already exported; this file was skipped`);
      return undefined;
    }
    const file = { path, content };
    files.set(key, file);
    for (const prefix of prefixes) directories.add(prefix);
    return file;
  };
}

/** The first 50 warnings, then a line that counts the rest. */
function capWarnings(warnings: string[]): string[] {
  if (warnings.length <= MAX_EXPORT_WARNINGS) return warnings;
  return [...warnings.slice(0, MAX_EXPORT_WARNINGS), `and ${warnings.length - MAX_EXPORT_WARNINGS} more warnings`];
}

/**
 * The files to write for a run that exports `entities` (see the layout above). Pure: nothing is read or written here.
 * Files come out per entity in the order given: its SuperSchema JSON, then its targets in catalog order. Each entity's folder holds
 * the full file set of its versions on its own: the entities are planned independently, so one entity exports the same way alone
 * (`generateExportFiles`) and in a bulk run.
 */
export function planGitExport(basePath: string, entities: readonly GitExportEntityInput[]): ExportPlan {
  const base = basePath.endsWith("/") ? basePath : `${basePath}/`;
  const warnings: string[] = [];
  const planned = entities.map((entity) => planEntity(base, entity, warnings));

  const files: ExportFile[] = [];
  const claim = createPathClaims(warnings);
  const add = (path: string, content: string) => {
    const file = claim(path, content);
    if (file !== undefined) files.push(file);
  };

  for (const entity of planned) {
    const { input, dir, entitySlug } = entity;
    const superschema = JSON.stringify(input.definition, null, 2);

    if (entity.selected.size === 0 && entity.legacy.length > 0) {
      // Legacy layout, exactly as before file sets: <base>/<domain>/<entity><extension of the format>.
      const domainSlug = slugify(input.domainName ?? domainLabel(null));
      const legacySlug = slugify(input.name);
      add(buildExportFilePath(basePath, domainSlug, legacySlug, "superschema"), superschema);
      for (const [, format, content] of entity.legacy) add(buildExportFilePath(basePath, domainSlug, legacySlug, format), content);
      continue;
    }

    add(`${dir}/${entitySlug}${FORMAT_EXTENSIONS.superschema}`, superschema);
    for (const [target, targetFiles] of entity.selected) {
      for (const file of targetFiles) add(`${dir}/${target}/${file.path}`, file.content);
    }
    // A legacy output of a target the entity has no version of is kept, as the single file the output fallback would write.
    for (const [emitter, format, content] of entity.legacy) {
      if (!entity.selected.has(emitter)) add(`${dir}/${emitter}/${entitySlug}${FORMAT_EXTENSIONS[format]}`, content);
    }
  }

  return { files, warnings: capWarnings(warnings) };
}

export interface GenerateExportFilesOptions {
  /** `null` / absent: a product-less (tenant-level) entity. */
  productName?: string | null;
  /** `entity.metadata.schemaVersions`. Without it the entity exports through `emittedOutputs` only. */
  schemaVersions?: unknown;
  /** Receives what was skipped (see {@link ExportPlan.warnings}). */
  warnings?: string[];
}

/**
 * The files to export for one entity (`planGitExport` with that one entity). Returns an array of { path, content } objects.
 * The entity's folder holds the full file set of its versions, the files of the entities it references included.
 *
 * @param basePath - Repository base path
 * @param domainName - Domain display name; `null` for a tenant-level entity
 * @param entityName - Entity display name
 * @param entityDefinition - The full entity definition JSON object
 * @param emittedOutputs - Legacy map of emitter name to target output
 * @param options - The entity's product and its `schemaVersions` (what the file sets are read from)
 * @returns Array of files to write
 */
export function generateExportFiles(
  basePath: string,
  domainName: string | null | undefined,
  entityName: string,
  entityDefinition: Record<string, unknown>,
  emittedOutputs: Record<string, TargetOutput>,
  options: GenerateExportFilesOptions = {}
): ExportFile[] {
  const plan = planGitExport(basePath, [
    {
      name: entityName,
      domainName,
      productName: options.productName,
      definition: entityDefinition,
      emittedOutputs,
      schemaVersions: options.schemaVersions,
    },
  ]);
  options.warnings?.push(...plan.warnings);
  return plan.files;
}

/** What `buildExportEntityDefinition` and `toExportEntityInput` read of an entity row (a Prisma `Entity` with its domain, product and fields). */
export interface ExportableEntity {
  name: string;
  description: string;
  status: string;
  domain?: { name: string } | null;
  product?: { name: string } | null;
  fields: ReadonlyArray<{
    name: string;
    type: string;
    nullable: boolean;
    isKey: boolean;
    description?: unknown;
    classification?: unknown;
    decorators?: unknown;
  }>;
  metadata: unknown;
}

/**
 * The SuperSchema JSON of an entity. The stored generated schemas (`metadata.schemaVersions`: every version's output and files, per
 * target) are left out: they are exported as files, and would otherwise be written a second time inside this JSON.
 */
export function buildExportEntityDefinition(entity: ExportableEntity, version: number): Record<string, unknown> {
  return {
    name: entity.name,
    description: entity.description,
    domain: domainLabel(entity.domain),
    version,
    status: entity.status,
    fields: entity.fields.map((f) => ({
      name: f.name,
      type: f.type,
      nullable: f.nullable,
      isKey: f.isKey,
      description: f.description,
      classification: f.classification,
      decorators: f.decorators,
    })),
    metadata: withoutSchemaVersions(entity.metadata),
  };
}

/** An entity row as the input of {@link planGitExport}. */
export function toExportEntityInput(entity: ExportableEntity, version: number): GitExportEntityInput {
  const metadata = isRecord(entity.metadata) ? entity.metadata : {};
  return {
    name: entity.name,
    domainName: entity.domain?.name ?? null,
    productName: entity.product?.name ?? null,
    definition: buildExportEntityDefinition(entity, version),
    emittedOutputs: isRecord(metadata.emittedOutputs) ? (metadata.emittedOutputs as Record<string, TargetOutput>) : {},
    schemaVersions: metadata.schemaVersions,
  };
}

// ---------------------------------------------------------------------------
// Service functions (interact with Prisma + audit)
// ---------------------------------------------------------------------------

/**
 * Configure (upsert) the Git repository for schema exports.
 * Only one Git config per instance (MVP).
 */
export async function configureRepository(
  input: ConfigureRepositoryInput,
  ctx: ServiceContext
): Promise<Result<GitConfigResponse>> {
  // The right to configure comes first: nobody learns what a valid configuration looks like without it.
  if (!ctxCan(ctx, "git.manage")) {
    return err({
      code: "FORBIDDEN",
      message: "Admin role required to configure Git repository",
      suggestedFix: "Contact an administrator to configure Git integration.",
    });
  }

  const parsed = ConfigureRepositoryInputSchema.safeParse(input);
  if (!parsed.success) {
    return err({
      code: "VALIDATION_ERROR",
      message: parsed.error.issues[0].message,
      suggestedFix: "Check the Git configuration fields and try again.",
    });
  }

  try {
    // The credential is sealed before anything is written: with no key configured nothing is stored, and the answer says so.
    const sealedCredential = sealSecret(parsed.data.authCredential, "GitConfig.authCredential");

    // Check if a config already exists
    const existing = await prisma.gitConfig.findFirst();

    // The audit entry records the redacted projection (no credential, sealed or not): what withAudit stores is what fn returns.
    const config = await withAudit({
      action: "CONFIGURE_GIT",
      entityType: "GitConfig",
      entityId: existing?.id ?? "pending",
      userId: ctx.userId,
      fn: async () => {
        if (existing) {
          return toGitConfigResponse(
            await prisma.gitConfig.update({
              where: { id: existing.id },
              data: {
                repositoryUrl: parsed.data.repositoryUrl,
                branch: parsed.data.branch,
                basePath: parsed.data.basePath,
                authMethod: parsed.data.authMethod,
                authCredential: sealedCredential,
                prReviewMode: parsed.data.prReviewMode,
                enabled: false,
              },
            })
          );
        }
        return toGitConfigResponse(
          await prisma.gitConfig.create({
            data: {
              repositoryUrl: parsed.data.repositoryUrl,
              branch: parsed.data.branch,
              basePath: parsed.data.basePath,
              authMethod: parsed.data.authMethod,
              authCredential: sealedCredential,
              prReviewMode: parsed.data.prReviewMode,
              enabled: false,
              createdBy: ctx.userId,
            },
          })
        );
      },
    });

    return ok(config);
  } catch (e: unknown) {
    return err({
      code: "INTERNAL_ERROR",
      message: e instanceof Error ? e.message : "Failed to configure Git",
      suggestedFix:
        e instanceof SecretBoxError
          ? "Set SECRETS_ENCRYPTION_KEY, or AUTH_SECRET, then try again (docs/auth-ops.md)."
          : "Check the repository URL and credentials.",
    });
  }
}

const GIT_NOT_VERIFIED =
  "Not verified: this build does not contact the Git repository, so the connection was not tested. Only the configuration was checked.";

/**
 * Test the connection to the configured Git repository.
 *
 * It does NOT reach the remote, and it never says the repository was reached. The stored credential is sent to no Git host in this build: the
 * schema importers fetch the hosts listed in SCHEMA_IMPORT_GIT_HOSTS through the operator's `gh` login (execFile, argv, a timeout:
 * src/lib/importers/jsonschema-ref-resolver.ts), and the exports and pull requests are recorded, not pushed (`exportAll`, `exportWithReview`).
 * A real check would be new code: the credential handed to a child process (never on a command line, never in a log), its own timeout, and its
 * own host allowlist. So the answer is "not verified", and the sync status is left as it was: a SUCCESS here would report a check nobody made.
 */
export async function testConnection(
  configId: string,
  ctx: ServiceContext
): Promise<Result<{ connected: boolean; verified: boolean; error?: string }>> {
  if (!ctxCan(ctx, "git.manage")) {
    return err({
      code: "FORBIDDEN",
      message: "Admin role required to test Git connection",
    });
  }

  const config = await prisma.gitConfig.findUnique({
    where: { id: configId },
  });
  if (!config) {
    return err({
      code: "NOT_FOUND",
      message: "Git configuration not found",
      suggestedFix: "Configure a Git repository first.",
    });
  }

  if (!config.repositoryUrl || !config.authCredential) {
    return ok({
      connected: false,
      verified: false,
      error: "Repository URL or credentials missing",
    });
  }

  return ok({ connected: false, verified: false, error: GIT_NOT_VERIFIED });
}

/**
 * Export all entities to the configured Git repository.
 */
export async function exportAll(
  ctx: ServiceContext
): Promise<Result<GitExportResult>> {
  if (!ctxCan(ctx, "git.manage")) {
    return err({
      code: "FORBIDDEN",
      message: "Admin role required for bulk export",
    });
  }

  const config = await prisma.gitConfig.findFirst({
    where: { enabled: true },
  });

  if (!config) {
    return err({
      code: "NOT_CONFIGURED",
      message: "Git export is not configured or not enabled",
    });
  }

  try {
    const entities = await prisma.entity.findMany({
      // A fixed order, so two runs over the same data write the same files (the oldest entity keeps a contested path).
      orderBy: [{ createdAt: "asc" }, { id: "asc" }],
      include: {
        domain: true,
        product: true,
        fields: { orderBy: { sortOrder: "asc" } },
      },
    });

    // One plan for the whole run: a file of a closure member goes once, under its owner's folder (see planGitExport).
    const plan = planGitExport(
      config.basePath,
      entities.map((entity) => {
        const metadata = (entity.metadata as Record<string, unknown>) ?? {};
        return toExportEntityInput(entity, (metadata.currentVersion as number) ?? 1);
      })
    );
    const totalFiles = plan.files.length;

    const commitMessage = buildBulkCommitMessage(entities.length);

    await withAudit({
      action: "GIT_EXPORT_ALL",
      entityType: "GitConfig",
      entityId: config.id,
      userId: ctx.userId,
      fn: async () => {
        await prisma.gitConfig.update({
          where: { id: config.id },
          data: {
            lastSyncAt: new Date(),
            lastSyncStatus: "SUCCESS",
          },
        });
        return null;
      },
    });

    return ok({
      success: true,
      filesExported: totalFiles,
      commitSha: `sha-${Date.now()}`,
      commitMessage,
      ...(plan.warnings.length > 0 ? { warnings: plan.warnings } : {}),
    } as GitExportResult);
  } catch (e: unknown) {
    await prisma.gitConfig.update({
      where: { id: config.id },
      data: {
        lastSyncAt: new Date(),
        lastSyncStatus: "FAILED",
      },
    });

    return ok({
      success: false,
      filesExported: 0,
      error: e instanceof Error ? e.message : "Bulk export failed",
    });
  }
}

/**
 * Enable Git export (auto-export on emit).
 */
export async function enableExport(
  configId: string,
  ctx: ServiceContext
): Promise<Result<GitConfigResponse>> {
  if (!ctxCan(ctx, "git.manage")) {
    return err({
      code: "FORBIDDEN",
      message: "Admin role required to enable Git export",
    });
  }

  const config = await prisma.gitConfig.findUnique({
    where: { id: configId },
  });
  if (!config) {
    return err({
      code: "NOT_FOUND",
      message: "Git configuration not found",
    });
  }

  // The audit entry records the redacted projection (see configureRepository). The credential column is not written here, so this update cannot
  // put back a credential saved meanwhile; a legacy plain value is sealed by the save that sets it (configureRepository).
  const updated = await withAudit({
    action: "ENABLE_GIT_EXPORT",
    entityType: "GitConfig",
    entityId: configId,
    userId: ctx.userId,
    fn: async () => toGitConfigResponse(await prisma.gitConfig.update({ where: { id: configId }, data: { enabled: true } })),
  });

  return ok(updated);
}

/**
 * Disable Git export.
 */
export async function disableExport(
  configId: string,
  ctx: ServiceContext
): Promise<Result<GitConfigResponse>> {
  if (!ctxCan(ctx, "git.manage")) {
    return err({
      code: "FORBIDDEN",
      message: "Admin role required to disable Git export",
    });
  }

  const config = await prisma.gitConfig.findUnique({
    where: { id: configId },
  });
  if (!config) {
    return err({
      code: "NOT_FOUND",
      message: "Git configuration not found",
    });
  }

  // The audit entry records the redacted projection (see configureRepository). The credential column is not written here, so this update cannot
  // put back a credential saved meanwhile; a legacy plain value is sealed by the save that sets it (configureRepository).
  const updated = await withAudit({
    action: "DISABLE_GIT_EXPORT",
    entityType: "GitConfig",
    entityId: configId,
    userId: ctx.userId,
    fn: async () => toGitConfigResponse(await prisma.gitConfig.update({ where: { id: configId }, data: { enabled: false } })),
  });

  return ok(updated);
}

/**
 * Get the current Git configuration (with credential redacted).
 */
export async function getConfig(
  ctx: ServiceContext
): Promise<Result<GitConfigResponse | null>> {
  if (!ctxCan(ctx, "git.manage")) {
    return err({
      code: "FORBIDDEN",
      message: "Admin role required to view Git configuration",
    });
  }

  const config = await prisma.gitConfig.findFirst();
  if (!config) {
    return ok(null);
  }

  return ok(toGitConfigResponse(config));
}

// ---------------------------------------------------------------------------
// Internal helpers
// ---------------------------------------------------------------------------

/**
 * Convert a Prisma GitConfig record to a response object with credential redacted.
 */
function toGitConfigResponse(config: {
  id: string;
  repositoryUrl: string;
  branch: string;
  basePath: string;
  authMethod: string;
  prReviewMode: string;
  enabled: boolean;
  lastSyncAt: Date | null;
  lastSyncStatus: string | null;
  createdAt: Date;
  updatedAt: Date;
}): GitConfigResponse {
  return {
    id: config.id,
    repositoryUrl: config.repositoryUrl,
    branch: config.branch,
    basePath: config.basePath,
    authMethod: config.authMethod as GitConfigResponse["authMethod"],
    prReviewMode: config.prReviewMode as GitConfigResponse["prReviewMode"],
    enabled: config.enabled,
    lastSyncAt: config.lastSyncAt?.toISOString() ?? null,
    lastSyncStatus:
      (config.lastSyncStatus as GitConfigResponse["lastSyncStatus"]) ?? null,
    createdAt: config.createdAt.toISOString(),
    updatedAt: config.updatedAt.toISOString(),
  };
}
