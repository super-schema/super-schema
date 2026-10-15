import { prisma } from "@/lib/db";
import { ok, err } from "@/types/result";
import type { Result } from "@/types/result";
import type { BusinessConcept, FieldConceptLink } from "@/generated/prisma/client";
import type { ServiceContext } from "@/types/service-context";
import {
  CreateBusinessConceptSchema,
  UpdateBusinessConceptSchema,
  BusinessConceptFilterSchema,
  LinkFieldConceptSchema,
  type CreateBusinessConceptInput,
  type UpdateBusinessConceptInput,
  type BusinessConceptFilter,
} from "@/types/schemas/business-concept";
import { domainLabel } from "@/lib/entity-placement";

export async function createConcept(
  input: CreateBusinessConceptInput,
  ctx: ServiceContext
): Promise<Result<BusinessConcept>> {
  const parsed = CreateBusinessConceptSchema.safeParse(input);
  if (!parsed.success) {
    return err({
      code: "VALIDATION_ERROR",
      message: parsed.error.issues[0].message,
      suggestedFix: "Check the concept input fields and try again.",
    });
  }

  try {
    const concept = await prisma.businessConcept.create({
      data: {
        name: parsed.data.name,
        domain: parsed.data.domain,
        definition: parsed.data.definition,
        synonyms: parsed.data.synonyms,
        canonicalType: parsed.data.canonicalType,
        classification: parsed.data.classification,
        tags: parsed.data.tags,
        ownerId: ctx.userId,
      },
    });
    return ok(concept);
  } catch (e: unknown) {
    if (e instanceof Error && e.message.includes("Unique constraint")) {
      return err({
        code: "DUPLICATE",
        message: `A concept named "${parsed.data.name}" already exists`,
        suggestedFix: "Choose a different concept name.",
      });
    }
    throw e;
  }
}

export async function updateConcept(
  id: string,
  input: UpdateBusinessConceptInput,
  _ctx: ServiceContext
): Promise<Result<BusinessConcept>> {
  const parsed = UpdateBusinessConceptSchema.safeParse(input);
  if (!parsed.success) {
    return err({
      code: "VALIDATION_ERROR",
      message: parsed.error.issues[0].message,
      suggestedFix: "Check the concept input fields and try again.",
    });
  }

  const existing = await prisma.businessConcept.findUnique({ where: { id } });
  if (!existing) {
    return err({
      code: "NOT_FOUND",
      message: `Business concept with ID "${id}" not found`,
      suggestedFix: "Verify the concept ID and try again.",
    });
  }

  try {
    const concept = await prisma.businessConcept.update({
      where: { id },
      data: parsed.data,
    });
    return ok(concept);
  } catch (e: unknown) {
    if (e instanceof Error && e.message.includes("Unique constraint")) {
      return err({
        code: "DUPLICATE",
        message: `A concept named "${parsed.data.name}" already exists`,
        suggestedFix: "Choose a different concept name.",
      });
    }
    throw e;
  }
}

export async function deleteConcept(
  id: string,
  _ctx: ServiceContext
): Promise<Result<{ deleted: true }>> {
  const existing = await prisma.businessConcept.findUnique({
    where: { id },
    include: { fieldLinks: true },
  });
  if (!existing) {
    return err({
      code: "NOT_FOUND",
      message: `Business concept with ID "${id}" not found`,
      suggestedFix: "Verify the concept ID and try again.",
    });
  }

  if (existing.fieldLinks.length > 0) {
    return err({
      code: "HAS_DEPENDENCIES",
      message: `Cannot delete concept "${existing.name}" because it is linked to ${existing.fieldLinks.length} field(s)`,
      suggestedFix: "Unlink all fields from this concept before deleting.",
    });
  }

  await prisma.businessConcept.delete({ where: { id } });
  return ok({ deleted: true });
}

export async function getConcepts(
  filters?: BusinessConceptFilter,
  _ctx?: ServiceContext
): Promise<Result<BusinessConcept[]>> {
  const parsed = filters
    ? BusinessConceptFilterSchema.safeParse(filters)
    : { success: true as const, data: {} };
  if (!parsed.success) {
    return err({
      code: "VALIDATION_ERROR",
      message: "Invalid filter parameters",
      suggestedFix: "Check filter values and try again.",
    });
  }

  const where: Record<string, unknown> = {};
  const f = parsed.data;

  if (f.domain) {
    where.domain = f.domain;
  }
  if (f.tag) {
    where.tags = { has: f.tag };
  }
  if (f.search) {
    where.OR = [
      { name: { contains: f.search, mode: "insensitive" } },
      { definition: { contains: f.search, mode: "insensitive" } },
    ];
  }

  const concepts = await prisma.businessConcept.findMany({
    where,
    orderBy: { name: "asc" },
    include: { fieldLinks: true },
  });
  return ok(concepts);
}

export async function getConceptById(
  id: string,
  _ctx: ServiceContext
): Promise<Result<BusinessConcept & { fieldLinks: (FieldConceptLink & { field: { id: string; name: string; type: string; entityId: string; entity: { id: string; name: string; domain: { name: string } } } })[] }>> {
  const concept = await prisma.businessConcept.findUnique({
    where: { id },
    include: {
      fieldLinks: {
        include: {
          field: {
            include: {
              entity: {
                include: { domain: true },
              },
            },
          },
        },
      },
    },
  });

  if (!concept) {
    return err({
      code: "NOT_FOUND",
      message: `Business concept with ID "${id}" not found`,
      suggestedFix: "Verify the concept ID and try again.",
    });
  }

  return ok(concept as never);
}

export async function searchConcepts(
  query: string,
  _ctx: ServiceContext
): Promise<Result<BusinessConcept[]>> {
  if (!query || query.trim().length === 0) {
    return err({
      code: "VALIDATION_ERROR",
      message: "Search query is required",
      suggestedFix: "Provide a non-empty search string.",
    });
  }

  const q = query.trim().toLowerCase();

  // Search by name, definition, and synonyms
  const concepts = await prisma.businessConcept.findMany({
    where: {
      OR: [
        { name: { contains: q, mode: "insensitive" } },
        { definition: { contains: q, mode: "insensitive" } },
        { synonyms: { has: q } },
      ],
    },
    orderBy: { name: "asc" },
  });

  return ok(concepts);
}

export async function linkFieldToConcept(
  fieldId: string,
  conceptId: string,
  ctx: ServiceContext,
  confidence: number = 1.0
): Promise<Result<FieldConceptLink>> {
  const parsed = LinkFieldConceptSchema.safeParse({ fieldId, conceptId, confidence });
  if (!parsed.success) {
    return err({
      code: "VALIDATION_ERROR",
      message: parsed.error.issues[0].message,
      suggestedFix: "Provide valid fieldId and conceptId.",
    });
  }

  // Verify field exists
  const field = await prisma.field.findUnique({ where: { id: fieldId } });
  if (!field) {
    return err({
      code: "NOT_FOUND",
      message: `Field with ID "${fieldId}" not found`,
      suggestedFix: "Verify the field ID.",
    });
  }

  // Verify concept exists
  const concept = await prisma.businessConcept.findUnique({ where: { id: conceptId } });
  if (!concept) {
    return err({
      code: "NOT_FOUND",
      message: `Business concept with ID "${conceptId}" not found`,
      suggestedFix: "Verify the concept ID.",
    });
  }

  try {
    const link = await prisma.fieldConceptLink.create({
      data: {
        fieldId,
        conceptId,
        confidence,
        linkedBy: ctx.userId,
      },
    });
    return ok(link);
  } catch (e: unknown) {
    if (e instanceof Error && e.message.includes("Unique constraint")) {
      return err({
        code: "DUPLICATE",
        message: "This field is already linked to this concept",
        suggestedFix: "The link already exists.",
      });
    }
    throw e;
  }
}

export async function unlinkFieldFromConcept(
  fieldId: string,
  conceptId: string,
  _ctx: ServiceContext
): Promise<Result<{ deleted: true }>> {
  const link = await prisma.fieldConceptLink.findUnique({
    where: { fieldId_conceptId: { fieldId, conceptId } },
  });

  if (!link) {
    return err({
      code: "NOT_FOUND",
      message: "No link found between this field and concept",
      suggestedFix: "Verify the field and concept IDs.",
    });
  }

  await prisma.fieldConceptLink.delete({
    where: { id: link.id },
  });
  return ok({ deleted: true });
}

export async function getConceptsForField(
  fieldId: string,
  _ctx: ServiceContext
): Promise<Result<(FieldConceptLink & { concept: BusinessConcept })[]>> {
  const links = await prisma.fieldConceptLink.findMany({
    where: { fieldId },
    include: { concept: true },
    orderBy: { confidence: "desc" },
  });
  return ok(links);
}

export async function suggestConceptsForField(
  fieldName: string,
  fieldType: string,
  _ctx: ServiceContext
): Promise<Result<{ concept: BusinessConcept; score: number }[]>> {
  if (!fieldName || fieldName.trim().length === 0) {
    return ok([]);
  }

  const normalizedName = fieldName.trim().toLowerCase().replace(/[_\-\s]+/g, "");

  // Fetch all concepts to match against
  const allConcepts = await prisma.businessConcept.findMany();

  const scored: { concept: BusinessConcept; score: number }[] = [];

  for (const concept of allConcepts) {
    let bestScore = 0;

    // Check exact name match
    const conceptNameNorm = concept.name.toLowerCase().replace(/[_\-\s]+/g, "");
    if (normalizedName === conceptNameNorm) {
      bestScore = 1.0;
    } else if (conceptNameNorm.includes(normalizedName) || normalizedName.includes(conceptNameNorm)) {
      bestScore = Math.max(bestScore, 0.7);
    }

    // Check synonym matches
    for (const synonym of concept.synonyms) {
      const synNorm = synonym.toLowerCase().replace(/[_\-\s]+/g, "");
      if (normalizedName === synNorm) {
        bestScore = Math.max(bestScore, 0.95);
      } else if (synNorm.includes(normalizedName) || normalizedName.includes(synNorm)) {
        bestScore = Math.max(bestScore, 0.6);
      }
    }

    // Check canonical type match (slight boost)
    if (concept.canonicalType && fieldType) {
      const typeNorm = fieldType.toLowerCase();
      const canonNorm = concept.canonicalType.toLowerCase();
      if (typeNorm === canonNorm) {
        bestScore = Math.min(1.0, bestScore + 0.05);
      }
    }

    if (bestScore > 0.3) {
      scored.push({ concept, score: bestScore });
    }
  }

  // Sort by score descending
  scored.sort((a, b) => b.score - a.score);

  return ok(scored.slice(0, 10));
}

export async function getConceptUsage(
  conceptId: string,
  _ctx: ServiceContext
): Promise<
  Result<{
    concept: BusinessConcept;
    usageCount: number;
    fields: { fieldId: string; fieldName: string; entityName: string; domainName: string; confidence: number }[];
  }>
> {
  const concept = await prisma.businessConcept.findUnique({
    where: { id: conceptId },
    include: {
      fieldLinks: {
        include: {
          field: {
            include: {
              entity: {
                include: { domain: true },
              },
            },
          },
        },
      },
    },
  });

  if (!concept) {
    return err({
      code: "NOT_FOUND",
      message: `Business concept with ID "${conceptId}" not found`,
      suggestedFix: "Verify the concept ID.",
    });
  }

  const fields = concept.fieldLinks.map((link) => ({
    fieldId: link.field.id,
    fieldName: link.field.name,
    entityName: link.field.entity.name,
    domainName: domainLabel(link.field.entity.domain),
    confidence: link.confidence,
  }));

  const uniqueEntities = new Set(fields.map((f) => f.entityName));

  return ok({
    concept,
    usageCount: fields.length,
    fields,
  });
}
