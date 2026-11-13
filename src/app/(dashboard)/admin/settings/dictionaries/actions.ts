"use server";

import { revalidatePath } from "next/cache";
import { contextOf, guardActiveTenant } from "@/lib/action-context";
import { withAudit } from "@/lib/audit";
import { METADATA_PACKS, getMetadataPack } from "@/lib/metadata-attributes/packs";
import {
  createFieldDictionaryEntry,
  deleteFieldDictionaryEntry,
  dictionaryUsage,
  dictionaryUsageCounts,
  listFieldDictionary,
  updateFieldDictionaryEntry,
  type DictionaryUsageRow,
} from "@/services/field-dictionary.service";
import {
  createMetadataAttribute,
  deleteMetadataAttribute,
  listMetadataAttributes,
  updateMetadataAttribute,
} from "@/services/metadata-attribute.service";
import { installMetadataPack, installedPacks, uninstallMetadataPack } from "@/services/metadata-pack.service";
import { rederiveTenant } from "@/services/metadata-rederive.service";
import type { DictionaryEntry } from "@/types/schemas/field-dictionary";
import type { MetadataAttributeRecord } from "@/types/schemas/metadata-attribute";
import type { Result } from "@/types/result";

/** What the admin page shows: both dictionaries and every pack with whether it is installed. */
export interface DictionariesOverview {
  fields: DictionaryEntry[];
  /** Linked-field count per field entry id (absent = 0). */
  usage: Record<string, number>;
  attributes: MetadataAttributeRecord[];
  packs: { id: string; name: string; description: string; keys: string[]; installed: boolean }[];
}

export type DictionaryActionResult<T> = { data: T } | { error: string };

/** Thrown inside an audited write when the service refused it, so no audit entry is written for a change that did not happen. */
class Refused extends Error {
  constructor(readonly message: string) {
    super(message);
  }
}

/**
 * The guard of every action on this page, BEFORE anything is read or written: `tenant.admin`, a tenant administrator's act over the tenant in view
 * (the same right as the domain administration; a domain-scoped administrator does not reach it). The services take the tenant and nothing else,
 * so this is the only place that decides who may.
 */
async function gate() {
  const access = await guardActiveTenant("tenant.admin", { label: "Tenant" });
  if (!access.allowed) return { ok: false as const, error: access.refusal.error };
  const tenantId = access.resource.tenantId!;
  return { ok: true as const, tenantId, ctx: { ...contextOf(access.principal), tenantId } };
}

function fail(message: string): { error: string } {
  return { error: message };
}

/** Runs a dictionary write under the audit log: one entry on success, none when the service refuses. */
async function audited<T extends { id?: string }>(
  g: { tenantId: string; ctx: { userId: string } },
  action: string,
  entityType: string,
  entityId: string,
  run: () => Promise<Result<T>>,
  beforeState?: object,
): Promise<DictionaryActionResult<T>> {
  try {
    const data = await withAudit({
      action,
      entityType,
      entityId,
      userId: g.ctx.userId,
      tenantId: g.tenantId,
      beforeState,
      fn: async () => {
        const result = await run();
        if (!result.success) throw new Refused(result.error.message);
        return result.data;
      },
    });
    return { data };
  } catch (e) {
    if (e instanceof Refused) return fail(e.message);
    throw e;
  }
}

function refresh() {
  revalidatePath("/admin/settings/dictionaries");
  revalidatePath("/schemas", "layout");
}

export async function dictionariesOverviewAction(): Promise<DictionaryActionResult<DictionariesOverview>> {
  const g = await gate();
  if (!g.ok) return fail(g.error);
  const [fields, attributes, installed, usage] = await Promise.all([
    listFieldDictionary(g.tenantId),
    listMetadataAttributes(g.tenantId),
    installedPacks(g.tenantId),
    dictionaryUsageCounts(g.tenantId),
  ]);
  if (!fields.success) return fail(fields.error.message);
  if (!attributes.success) return fail(attributes.error.message);
  return {
    data: {
      fields: fields.data,
      usage,
      attributes: attributes.data,
      packs: METADATA_PACKS.map((p) => ({
        id: p.id,
        name: p.name,
        description: p.description,
        keys: p.definitions.map((d) => d.key),
        installed: installed.includes(p.id),
      })),
    },
  };
}

/** The fields linked to one entry, with how each differs from it. Read-only. */
export async function fieldEntryUsageAction(id: string): Promise<DictionaryActionResult<DictionaryUsageRow[]>> {
  const g = await gate();
  if (!g.ok) return fail(g.error);
  const usage = await dictionaryUsage(g.tenantId, id);
  if (!usage.success) return fail(usage.error.message);
  return { data: usage.data };
}

export async function createFieldEntryAction(input: unknown) {
  const g = await gate();
  if (!g.ok) return fail(g.error);
  const answer = await audited(g, "CREATE", "FieldDictionaryEntry", "pending", () => createFieldDictionaryEntry(g.tenantId, input));
  if ("data" in answer) refresh();
  return answer;
}

export async function updateFieldEntryAction(id: string, patch: unknown) {
  const g = await gate();
  if (!g.ok) return fail(g.error);
  const answer = await audited(
    g,
    "UPDATE",
    "FieldDictionaryEntry",
    id,
    () => updateFieldDictionaryEntry(g.tenantId, id, patch as Parameters<typeof updateFieldDictionaryEntry>[2]),
    { id, tenantId: g.tenantId },
  );
  if ("data" in answer) refresh();
  return answer;
}

export async function deleteFieldEntryAction(id: string) {
  const g = await gate();
  if (!g.ok) return fail(g.error);
  const answer = await audited(g, "DELETE", "FieldDictionaryEntry", id, () => deleteFieldDictionaryEntry(g.tenantId, id), { id, tenantId: g.tenantId });
  if ("data" in answer) refresh();
  return answer;
}

/** A definition changed: fields carrying its derived members are re-derived. A user-supplied `pack` is never passed on: only pack install sets it. */
function withoutPack(input: unknown): unknown {
  if (!input || typeof input !== "object") return input;
  const { pack: _pack, ...rest } = input as Record<string, unknown>;
  void _pack;
  return rest;
}

export async function createAttributeAction(input: unknown) {
  const g = await gate();
  if (!g.ok) return fail(g.error);
  const answer = await audited(g, "CREATE", "MetadataAttributeDefinition", "pending", async () => {
    const result = await createMetadataAttribute(g.tenantId, { ...(withoutPack(input) as object), pack: null });
    if (result.success) await rederiveTenant(g.tenantId);
    return result;
  });
  if ("data" in answer) refresh();
  return answer;
}

export async function updateAttributeAction(id: string, patch: unknown) {
  const g = await gate();
  if (!g.ok) return fail(g.error);
  const answer = await audited(
    g,
    "UPDATE",
    "MetadataAttributeDefinition",
    id,
    async () => {
      const result = await updateMetadataAttribute(g.tenantId, id, withoutPack(patch) as Parameters<typeof updateMetadataAttribute>[2]);
      if (result.success) await rederiveTenant(g.tenantId);
      return result;
    },
    { id, tenantId: g.tenantId },
  );
  if ("data" in answer) refresh();
  return answer;
}

export async function deleteAttributeAction(id: string) {
  const g = await gate();
  if (!g.ok) return fail(g.error);
  const answer = await audited(g, "DELETE", "MetadataAttributeDefinition", id, () => deleteMetadataAttribute(g.tenantId, id), { id, tenantId: g.tenantId });
  if ("data" in answer) refresh();
  return answer;
}

export async function installPackAction(packId: string) {
  const g = await gate();
  if (!g.ok) return fail(g.error);
  if (!getMetadataPack(packId)) return fail("Unknown pack");
  const answer = await audited(g, "INSTALL_PACK", "MetadataPack", packId, () => installMetadataPack(g.tenantId, packId));
  if ("data" in answer) refresh();
  return answer;
}

export async function uninstallPackAction(packId: string) {
  const g = await gate();
  if (!g.ok) return fail(g.error);
  if (!getMetadataPack(packId)) return fail("Unknown pack");
  const answer = await audited(g, "UNINSTALL_PACK", "MetadataPack", packId, () => uninstallMetadataPack(g.tenantId, packId), { id: packId, tenantId: g.tenantId });
  if ("data" in answer) refresh();
  return answer;
}
