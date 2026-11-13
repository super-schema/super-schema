/**
 * Field Dictionary service: a tenant's canonical fields (name, aliases, type, classification, default x-* attribute values).
 *
 * Authorization (admin rights) is enforced by the calling layer; every query here is scoped by tenantId. Names are case-sensitive (field
 * names are not normalized); aliases are compared case-insensitively, as autocomplete matches them.
 */

import { Prisma } from "@/generated/prisma/client";
import { prisma } from "@/lib/db";
import { CLASS_SCALE } from "@/lib/classification-scale";
import { dictionaryEntryFromField } from "@/lib/field-dictionary/from-field";
import { validateValue } from "@/lib/metadata-attributes/value-schema";
import { listMetadataAttributes } from "@/services/metadata-attribute.service";
import {
  FieldDictionaryEntrySchema,
  type DictionaryEntry,
  type FieldDictionaryEntryData,
} from "@/types/schemas/field-dictionary";
import { err, ok } from "@/types/result";
import type { Result } from "@/types/result";

type Row = Awaited<ReturnType<typeof prisma.fieldDictionaryEntry.findFirstOrThrow>>;

function toEntry(row: Row): DictionaryEntry {
  return {
    id: row.id,
    tenantId: row.tenantId,
    name: row.name,
    aliases: row.aliases,
    type: row.type,
    description: row.description,
    classification: row.classification,
    attributes: (row.attributes as Record<string, unknown> | null) ?? {},
    conceptId: row.conceptId,
    createdAt: row.createdAt,
    updatedAt: row.updatedAt,
  };
}

function notFound() {
  return err({ code: "NOT_FOUND", message: "Dictionary entry not found", suggestedFix: "Refresh and try again." });
}

function duplicateName(name: string) {
  return err({
    code: "DUPLICATE_NAME",
    message: `Dictionary entry "${name}" already exists`,
    suggestedFix: "Choose a different name.",
  });
}

function aliasConflict(alias: string) {
  return err({
    code: "ALIAS_CONFLICT",
    message: `"${alias}" is already the name or an alias of another dictionary entry`,
    suggestedFix: "Remove or rename the alias.",
  });
}

function parseEntry(input: unknown): Result<FieldDictionaryEntryData> {
  const parsed = FieldDictionaryEntrySchema.safeParse(input);
  if (!parsed.success) {
    return err({ code: "VALIDATION_ERROR", message: parsed.error.issues[0].message, suggestedFix: "Check the dictionary entry fields." });
  }
  return ok(parsed.data);
}

/** Each default attribute is validated against its definition when one exists; an unknown x-* key is allowed. */
async function checkAttributes(tenantId: string, attributes: Record<string, unknown>): Promise<Result<true>> {
  const keys = Object.keys(attributes);
  if (keys.length === 0) return ok(true);
  const listed = await listMetadataAttributes(tenantId, "field");
  if (!listed.success) return listed;
  const byKey = new Map(listed.data.map((d) => [d.key, d]));
  for (const key of keys) {
    if (!/^x-/.test(key)) {
      return err({ code: "VALIDATION_ERROR", message: `Attribute "${key}" must start with "x-"`, suggestedFix: "Use x-* attribute keys." });
    }
    const def = byKey.get(key);
    if (!def) continue;
    const problems = validateValue(attributes[key], def.valueSchema);
    if (problems.length > 0) {
      const p = problems[0];
      return err({
        code: "INVALID_ATTRIBUTE_VALUE",
        message: `Attribute "${key}"${p.path} ${p.message}`,
        details: { key, problems },
        suggestedFix: `Provide a value matching the "${def.label}" definition.`,
      });
    }
  }
  return ok(true);
}

/** An alias (or the name) that is another entry's name or alias, compared case-insensitively. Null when there is no clash. */
async function findAliasConflict(tenantId: string, data: FieldDictionaryEntryData, selfId?: string): Promise<string | null> {
  const others = await prisma.fieldDictionaryEntry.findMany({
    where: { tenantId, ...(selfId ? { id: { not: selfId } } : {}) },
    select: { name: true, aliases: true },
  });
  const names = new Set(others.map((o) => o.name.toLowerCase()));
  const aliases = new Set(others.flatMap((o) => o.aliases.map((a) => a.toLowerCase())));
  for (const alias of data.aliases) {
    const k = alias.toLowerCase();
    if (names.has(k) || aliases.has(k)) return alias;
  }
  // The name must not shadow another entry's alias (an identical name is DUPLICATE_NAME, reported before).
  if (aliases.has(data.name.toLowerCase())) return data.name;
  return null;
}

/** Aliases deduplicated case-insensitively, without the entry's own name. */
function cleanAliases(data: FieldDictionaryEntryData): string[] {
  const seen = new Set<string>([data.name.toLowerCase()]);
  const out: string[] = [];
  for (const a of data.aliases) {
    const k = a.toLowerCase();
    if (seen.has(k)) continue;
    seen.add(k);
    out.push(a);
  }
  return out;
}

export async function listFieldDictionary(tenantId: string): Promise<Result<DictionaryEntry[]>> {
  const rows = await prisma.fieldDictionaryEntry.findMany({ where: { tenantId }, orderBy: { name: "asc" } });
  return ok(rows.map(toEntry));
}

export async function createFieldDictionaryEntry(tenantId: string, input: unknown): Promise<Result<DictionaryEntry>> {
  const parsed = parseEntry(input);
  if (!parsed.success) return parsed;
  const d = { ...parsed.data, aliases: cleanAliases(parsed.data) };
  const attrs = await checkAttributes(tenantId, d.attributes);
  if (!attrs.success) return attrs;
  const existing = await prisma.fieldDictionaryEntry.findUnique({ where: { tenantId_name: { tenantId, name: d.name } } });
  if (existing) return duplicateName(d.name);
  const clash = await findAliasConflict(tenantId, d);
  if (clash) return aliasConflict(clash);
  try {
    const row = await prisma.fieldDictionaryEntry.create({
      data: {
        tenantId,
        name: d.name,
        aliases: d.aliases,
        type: d.type,
        description: d.description,
        classification: d.classification ?? null,
        attributes: d.attributes as Prisma.InputJsonValue,
        conceptId: d.conceptId ?? null,
      },
    });
    return ok(toEntry(row));
  } catch (e) {
    if (e instanceof Prisma.PrismaClientKnownRequestError && e.code === "P2002") return duplicateName(d.name);
    throw e;
  }
}

export async function updateFieldDictionaryEntry(
  tenantId: string,
  id: string,
  patch: Partial<FieldDictionaryEntryData>,
): Promise<Result<DictionaryEntry>> {
  const row = await prisma.fieldDictionaryEntry.findFirst({ where: { id, tenantId } });
  if (!row) return notFound();
  const current = toEntry(row);
  const parsed = parseEntry({
    name: current.name,
    aliases: current.aliases,
    type: current.type,
    description: current.description,
    classification: current.classification,
    attributes: current.attributes,
    conceptId: current.conceptId,
    ...patch,
  });
  if (!parsed.success) return parsed;
  const d = { ...parsed.data, aliases: cleanAliases(parsed.data) };
  const attrs = await checkAttributes(tenantId, d.attributes);
  if (!attrs.success) return attrs;
  if (d.name !== row.name) {
    const clash = await prisma.fieldDictionaryEntry.findUnique({ where: { tenantId_name: { tenantId, name: d.name } } });
    if (clash) return duplicateName(d.name);
  }
  const conflict = await findAliasConflict(tenantId, d, id);
  if (conflict) return aliasConflict(conflict);
  const updated = await prisma.fieldDictionaryEntry.update({
    where: { id },
    data: {
      name: d.name,
      aliases: d.aliases,
      type: d.type,
      description: d.description,
      classification: d.classification ?? null,
      attributes: d.attributes as Prisma.InputJsonValue,
      conceptId: d.conceptId ?? null,
    },
  });
  return ok(toEntry(updated));
}

/** Deletes the entry; fields created from it keep their values and lose only the link (`dictionaryEntryId` set null by the foreign key). */
export async function deleteFieldDictionaryEntry(tenantId: string, id: string): Promise<Result<{ id: string }>> {
  const row = await prisma.fieldDictionaryEntry.findFirst({ where: { id, tenantId } });
  if (!row) return notFound();
  await prisma.fieldDictionaryEntry.delete({ where: { id } });
  return ok({ id });
}

/** How many fields are linked to each of the tenant's entries (entries with none are absent). */
export async function dictionaryUsageCounts(tenantId: string): Promise<Record<string, number>> {
  const groups = await prisma.field.groupBy({
    by: ["dictionaryEntryId"],
    where: { dictionaryEntryId: { not: null }, entity: { tenantId } },
    _count: { _all: true },
  });
  return Object.fromEntries(groups.flatMap((g) => (g.dictionaryEntryId ? [[g.dictionaryEntryId, g._count._all]] : [])));
}

/** What the admin Fields form offers: every classification level with its class, and the tenant's custom scalar and shared enum names. */
export interface DictionaryFormOptions {
  levels: { name: string; classNumber: number }[];
  customTypes: string[];
}

/**
 * The options of the admin Fields form (U9). Levels are the standard 1-5 scale plus the stored levels (custom ones included), once per name,
 * ordered by class then name. Custom types are the tenant's custom scalar and shared enum names (any domain), once per name, sorted.
 */
export async function dictionaryFormOptions(tenantId: string): Promise<DictionaryFormOptions> {
  const [rows, scalars, enums] = await Promise.all([
    prisma.classificationLevel.findMany({ select: { name: true, classNumber: true } }),
    prisma.customScalar.findMany({ where: { tenantId }, select: { name: true } }),
    prisma.sharedEnum.findMany({ where: { tenantId }, select: { name: true } }),
  ]);
  const levels = new Map<string, number>(CLASS_SCALE.map((c) => [c.level, c.classNumber]));
  for (const r of rows) if (!levels.has(r.name.toUpperCase())) levels.set(r.name, r.classNumber);
  return {
    levels: [...levels]
      .map(([name, classNumber]) => ({ name, classNumber }))
      .sort((a, b) => a.classNumber - b.classNumber || a.name.localeCompare(b.name)),
    customTypes: [...new Set([...scalars, ...enums].map((t) => t.name))].sort((a, b) => a.localeCompare(b)),
  };
}

export type DictionaryDrift = "type" | "description" | "classification" | "attributes";

export interface DictionaryUsageRow {
  fieldId: string;
  fieldName: string;
  entityId: string;
  entityName: string;
  entitySlug: string;
  /** Slugs of the entity's domain and product; null for a tenant-level (Enterprise) entity. */
  domainSlug: string | null;
  productSlug: string | null;
  /** Which properties of the field differ from the entry (the entry is the reference). Empty when the field matches. */
  drift: DictionaryDrift[];
}

/** Key-order-independent JSON, so two attribute maps compare by content. */
function canonical(v: unknown): string {
  if (Array.isArray(v)) return `[${v.map(canonical).join(",")}]`;
  if (v && typeof v === "object") {
    const o = v as Record<string, unknown>;
    return `{${Object.keys(o)
      .sort()
      .map((k) => `${JSON.stringify(k)}:${canonical(o[k])}`)
      .join(",")}}`;
  }
  return JSON.stringify(v) ?? "null";
}

/**
 * The fields linked to an entry (`Field.dictionaryEntryId`), each with the properties that differ from the entry. Read-only: nothing is synced.
 * Both sides go through `dictionaryEntryFromField`, so attributes compare the way "save to dictionary" builds them (schema-scope values, derived
 * members removed): a derived member that differs is not drift.
 */
export async function dictionaryUsage(tenantId: string, entryId: string): Promise<Result<DictionaryUsageRow[]>> {
  const entry = await prisma.fieldDictionaryEntry.findFirst({ where: { id: entryId, tenantId } });
  if (!entry) return notFound();
  const listed = await listMetadataAttributes(tenantId, "field");
  if (!listed.success) return listed;
  const defs = listed.data;
  const ref = toEntry(entry);
  const refShape = dictionaryEntryFromField(
    {
      name: ref.name,
      type: ref.type,
      description: ref.description,
      classification: ref.classification,
      decorators: { typespec: { extensions: { openapi: ref.attributes } } },
    },
    defs,
  );
  const rows = await prisma.field.findMany({
    where: { dictionaryEntryId: entryId, entity: { tenantId } },
    include: { entity: { select: { id: true, name: true, slug: true, domain: { select: { slug: true } }, product: { select: { slug: true } } } } },
    orderBy: [{ entity: { name: "asc" } }, { name: "asc" }],
  });
  return ok(
    rows.map((f) => {
      const shape = dictionaryEntryFromField(f, defs);
      const drift: DictionaryDrift[] = [];
      if (shape.type !== refShape.type) drift.push("type");
      if (shape.description !== refShape.description) drift.push("description");
      if (shape.classification !== refShape.classification) drift.push("classification");
      if (canonical(shape.attributes) !== canonical(refShape.attributes)) drift.push("attributes");
      return {
        fieldId: f.id,
        fieldName: f.name,
        entityId: f.entity.id,
        entityName: f.entity.name,
        entitySlug: f.entity.slug,
        domainSlug: f.entity.domain?.slug ?? null,
        productSlug: f.entity.product?.slug ?? null,
        drift,
      };
    }),
  );
}
