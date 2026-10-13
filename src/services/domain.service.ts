import { prisma } from "@/lib/db";
import { withAudit } from "@/lib/audit";
import { ok, err } from "@/types/result";
import type { Result } from "@/types/result";
import type { Domain } from "@/generated/prisma/client";
import type { ServiceContext } from "@/types/service-context";
import {
  CreateDomainInputSchema,
  PolicyTemplateSchema,
  type CreateDomainInput,
} from "@/types/schemas/domain.schema";
import type { Prisma } from "@/generated/prisma/client";
import { generateSlug, isReservedSchemaRouteSlug } from "@/lib/slug";
import { ensureDefaultTenantId } from "@/lib/org-defaults";

export async function createDomain(
  input: CreateDomainInput,
  ctx: ServiceContext
): Promise<Result<Domain>> {
  const parsed = CreateDomainInputSchema.safeParse(input);
  if (!parsed.success) {
    return err({
      code: "VALIDATION_ERROR",
      message: parsed.error.issues[0].message,
      suggestedFix: "Check the domain input fields and try again.",
    });
  }

  const domainSlug = generateSlug(parsed.data.name);
  if (isReservedSchemaRouteSlug(domainSlug)) {
    return err({
      code: "VALIDATION_ERROR",
      message: `"${domainSlug}" is reserved for a schemas utility page.`,
      suggestedFix: "Choose a different domain name.",
    });
  }

  if (parsed.data.policyTemplate) {
    const ptResult = PolicyTemplateSchema.safeParse(parsed.data.policyTemplate);
    if (!ptResult.success) {
      return err({
        code: "VALIDATION_ERROR",
        message: "Invalid policy template structure",
        details: { issues: ptResult.error.issues },
        suggestedFix:
          "Ensure policyTemplate matches the expected schema: { defaultClassification?, defaultRetention?, defaultQualityRules?, namingConventions? }",
      });
    }
  }

  try {
    const domain = await withAudit({
      action: "CREATE",
      entityType: "Domain",
      entityId: "pending",
      userId: ctx.userId,
      fn: async () => {
        const tenantId = await ensureDefaultTenantId();
        return prisma.domain.create({
          data: {
            name: parsed.data.name,
            slug: domainSlug,
            tenantId,
            description: parsed.data.description,
            policyTemplate:
              (parsed.data.policyTemplate as Prisma.InputJsonValue) ??
              undefined,
          },
        });
      },
    });
    return ok(domain);
  } catch (e: unknown) {
    if (
      e instanceof Error &&
      e.message.includes("Unique constraint failed")
    ) {
      return err({
        code: "DUPLICATE",
        message: `A domain named "${parsed.data.name}" already exists`,
        suggestedFix: "Choose a different domain name.",
      });
    }
    throw e;
  }
}

export async function getDomains(
  ctx: ServiceContext
): Promise<Result<Domain[]>> {
  const domains = await ctx.prisma.domain.findMany({
    orderBy: [{ isSystem: "desc" }, { name: "asc" }],
  });
  return ok(domains);
}

export async function getDomainById(
  id: string,
  ctx: ServiceContext
): Promise<Result<Domain>> {
  const domain = await ctx.prisma.domain.findUnique({ where: { id } });
  if (!domain) {
    return err({
      code: "NOT_FOUND",
      message: `Domain with ID "${id}" not found`,
      suggestedFix: "Verify the domain ID and try again.",
    });
  }
  return ok(domain);
}
