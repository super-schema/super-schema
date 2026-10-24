import { ok, err } from "@/types/result";
import type { Result } from "@/types/result";
import type { Domain } from "@/generated/prisma/client";
import type { ServiceContext } from "@/types/service-context";
import {
  CreateDomainInputSchema,
  PolicyTemplateSchema,
  type CreateDomainInput,
} from "@/types/schemas/domain.schema";
import { createDomainRow } from "@/services/domain-row.service";

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

  // The row itself (the name's slug and its reserved words, the duplicate check, the tenant, the audit row) is `createDomainRow`'s:
  // the Domains page's action and the Admin tab make it the same way.
  return createDomainRow(
    { name: parsed.data.name, description: parsed.data.description, policyTemplate: parsed.data.policyTemplate, userId: ctx.userId },
    ctx.prisma
  );
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
