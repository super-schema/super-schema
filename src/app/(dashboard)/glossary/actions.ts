"use server";

import { authorizeActiveTenant, authorizeSubject, contextOf, type AccessSubject } from "@/lib/action-context";
import type { ActionId } from "@/lib/access";
import {
  createConcept,
  updateConcept,
  deleteConcept,
  getConcepts,
  searchConcepts,
  linkFieldToConcept,
  unlinkFieldFromConcept,
  suggestConceptsForField,
} from "@/services/business-concept.service";
import type { ServiceContext } from "@/types/service-context";
import type {
  CreateBusinessConceptInput,
  UpdateBusinessConceptInput,
  BusinessConceptFilter,
} from "@/types/schemas/business-concept";
import { revalidatePath } from "next/cache";

/**
 * The guard of every glossary action, BEFORE any read or write: the caller must be allowed `action` in the ACTIVE tenant (`glossary.read`,
 * `glossary.write`: the table's "anywhere in the tenant" level) or, for linking a field, over the field's own place (`glossary.link`).
 * Nobody signed in, a user with no role, a disabled user and a tenant that is not the one in view are all refused; the context handed to the
 * service carries the principal's assignments, not a role label the service could trust.
 */
async function getServiceContext(action: ActionId, subject?: AccessSubject): Promise<{ ctx: ServiceContext } | { error: string }> {
  const allowed = subject ? await authorizeSubject(action, subject) : await authorizeActiveTenant(action);
  if (!allowed.success) return { error: allowed.error.code === "UNAUTHORIZED" ? "Not authenticated" : allowed.error.message };
  return { ctx: contextOf(allowed.data.principal) };
}

export async function createConceptAction(input: CreateBusinessConceptInput) {
  const access = await getServiceContext("glossary.write");
  if ("error" in access) return { error: access.error };
  const ctx = access.ctx;

  const result = await createConcept(input, ctx);
  if (!result.success) return { error: result.error.message };

  revalidatePath("/glossary");
  return { success: true, data: result.data };
}

export async function updateConceptAction(id: string, input: UpdateBusinessConceptInput) {
  const access = await getServiceContext("glossary.write");
  if ("error" in access) return { error: access.error };
  const ctx = access.ctx;

  const result = await updateConcept(id, input, ctx);
  if (!result.success) return { error: result.error.message };

  revalidatePath("/glossary");
  return { success: true, data: result.data };
}

export async function deleteConceptAction(id: string) {
  const access = await getServiceContext("glossary.write");
  if ("error" in access) return { error: access.error };
  const ctx = access.ctx;

  const result = await deleteConcept(id, ctx);
  if (!result.success) return { error: result.error.message };

  revalidatePath("/glossary");
  return { success: true };
}

export async function getConceptsAction(filters?: BusinessConceptFilter) {
  const access = await getServiceContext("glossary.read");
  if ("error" in access) return { error: access.error };
  const ctx = access.ctx;

  const result = await getConcepts(filters, ctx);
  if (!result.success) return { error: result.error.message };
  return { success: true, data: result.data };
}

export async function searchConceptsAction(query: string) {
  const access = await getServiceContext("glossary.read");
  if ("error" in access) return { error: access.error };
  const ctx = access.ctx;

  const result = await searchConcepts(query, ctx);
  if (!result.success) return { error: result.error.message };
  return { success: true, data: result.data };
}

export async function linkFieldToConceptAction(
  fieldId: string,
  conceptId: string,
  confidence: number = 1.0
) {
  const access = await getServiceContext("glossary.link", { kind: "field", id: fieldId });
  if ("error" in access) return { error: access.error };
  const ctx = access.ctx;

  const result = await linkFieldToConcept(fieldId, conceptId, ctx, confidence);
  if (!result.success) return { error: result.error.message };

  revalidatePath("/glossary");
  return { success: true, data: result.data };
}

export async function unlinkFieldFromConceptAction(
  fieldId: string,
  conceptId: string
) {
  const access = await getServiceContext("glossary.link", { kind: "field", id: fieldId });
  if ("error" in access) return { error: access.error };
  const ctx = access.ctx;

  const result = await unlinkFieldFromConcept(fieldId, conceptId, ctx);
  if (!result.success) return { error: result.error.message };

  revalidatePath("/glossary");
  return { success: true };
}

export async function suggestConceptsForFieldAction(
  fieldName: string,
  fieldType: string
) {
  const access = await getServiceContext("glossary.read");
  if ("error" in access) return { error: access.error };
  const ctx = access.ctx;

  const result = await suggestConceptsForField(fieldName, fieldType, ctx);
  if (!result.success) return { error: result.error.message };
  return { success: true, data: result.data };
}
