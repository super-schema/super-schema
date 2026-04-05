"use server";

import { auth } from "@/lib/auth";
import { prisma } from "@/lib/db";
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

async function getServiceContext(): Promise<ServiceContext | null> {
  const session = await auth();
  if (!session?.user?.id) return null;
  return {
    userId: session.user.id,
    userRole: "AUTHOR",
    prisma,
  };
}

export async function createConceptAction(input: CreateBusinessConceptInput) {
  const ctx = await getServiceContext();
  if (!ctx) return { error: "Not authenticated" };

  const result = await createConcept(input, ctx);
  if (!result.success) return { error: result.error.message };

  revalidatePath("/glossary");
  return { success: true, data: result.data };
}

export async function updateConceptAction(id: string, input: UpdateBusinessConceptInput) {
  const ctx = await getServiceContext();
  if (!ctx) return { error: "Not authenticated" };

  const result = await updateConcept(id, input, ctx);
  if (!result.success) return { error: result.error.message };

  revalidatePath("/glossary");
  return { success: true, data: result.data };
}

export async function deleteConceptAction(id: string) {
  const ctx = await getServiceContext();
  if (!ctx) return { error: "Not authenticated" };

  const result = await deleteConcept(id, ctx);
  if (!result.success) return { error: result.error.message };

  revalidatePath("/glossary");
  return { success: true };
}

export async function getConceptsAction(filters?: BusinessConceptFilter) {
  const ctx = await getServiceContext();
  if (!ctx) return { error: "Not authenticated" };

  const result = await getConcepts(filters, ctx);
  if (!result.success) return { error: result.error.message };
  return { success: true, data: result.data };
}

export async function searchConceptsAction(query: string) {
  const ctx = await getServiceContext();
  if (!ctx) return { error: "Not authenticated" };

  const result = await searchConcepts(query, ctx);
  if (!result.success) return { error: result.error.message };
  return { success: true, data: result.data };
}

export async function linkFieldToConceptAction(
  fieldId: string,
  conceptId: string,
  confidence: number = 1.0
) {
  const ctx = await getServiceContext();
  if (!ctx) return { error: "Not authenticated" };

  const result = await linkFieldToConcept(fieldId, conceptId, ctx, confidence);
  if (!result.success) return { error: result.error.message };

  revalidatePath("/glossary");
  return { success: true, data: result.data };
}

export async function unlinkFieldFromConceptAction(
  fieldId: string,
  conceptId: string
) {
  const ctx = await getServiceContext();
  if (!ctx) return { error: "Not authenticated" };

  const result = await unlinkFieldFromConcept(fieldId, conceptId, ctx);
  if (!result.success) return { error: result.error.message };

  revalidatePath("/glossary");
  return { success: true };
}

export async function suggestConceptsForFieldAction(
  fieldName: string,
  fieldType: string
) {
  const ctx = await getServiceContext();
  if (!ctx) return { error: "Not authenticated" };

  const result = await suggestConceptsForField(fieldName, fieldType, ctx);
  if (!result.success) return { error: result.error.message };
  return { success: true, data: result.data };
}
