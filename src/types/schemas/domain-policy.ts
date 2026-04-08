import { z } from "zod";
import { RetentionPolicySchema } from "./retention-policy.schema";

export const QualityRuleTemplateSchema = z.object({
  type: z.string(),
  params: z.record(z.string(), z.unknown()),
});

// ---------------------------------------------------------------------------
// Completeness Requirements — per-requirement shape
// ---------------------------------------------------------------------------

export const CompletenessRequirementSchema = z.object({
  enabled: z.boolean(),
  severity: z.enum(["error", "warning"]),
  params: z.record(z.string(), z.unknown()).optional(),
});

export type CompletenessRequirement = z.infer<typeof CompletenessRequirementSchema>;

export const CompletenessRequirementsSchema = z.object({
  ownerRequired: CompletenessRequirementSchema.optional(),
  descriptionRequired: CompletenessRequirementSchema.optional(),
  tagsMinCount: CompletenessRequirementSchema.optional(),
  retentionPolicyRequired: CompletenessRequirementSchema.optional(),
  fieldDescriptionRequired: CompletenessRequirementSchema.optional(),
  fieldClassificationExplicit: CompletenessRequirementSchema.optional(),
});

export type CompletenessRequirements = z.infer<typeof CompletenessRequirementsSchema>;

// ---------------------------------------------------------------------------
// Policy Template
// ---------------------------------------------------------------------------

export const PolicyTemplateSchema = z
  .object({
    classification: z
      .enum(["PII", "SENSITIVE", "INTERNAL", "PUBLIC", "NEVER_STORED"])
      .optional(),
    retention: z.string().optional(),
    retentionPolicy: RetentionPolicySchema.optional(),
    qualityRules: z.array(QualityRuleTemplateSchema).optional(),
    namingConventions: z.string().optional(),
    completenessRequirements: CompletenessRequirementsSchema.optional(),
  })
  .partial();

export type PolicyTemplate = z.infer<typeof PolicyTemplateSchema>;

export const CreateDomainAdminInputSchema = z.object({
  name: z
    .string()
    .min(1, "Domain name is required")
    .max(64, "Domain name must be 64 characters or less"),
  description: z.string().optional(),
  policyTemplate: PolicyTemplateSchema.optional(),
});

export type CreateDomainAdminInput = z.infer<typeof CreateDomainAdminInputSchema>;

export const UpdateDomainAdminInputSchema = z.object({
  id: z.string().min(1, "Domain ID is required"),
  name: z.string().min(1).max(64).optional(),
  description: z.string().optional(),
  policyTemplate: PolicyTemplateSchema.optional(),
});

export type UpdateDomainAdminInput = z.infer<typeof UpdateDomainAdminInputSchema>;

/**
 * Metadata tracking which decorator keys were inherited from a domain template.
 */
export const InheritedMetadataSchema = z.object({
  domainId: z.string(),
  domainName: z.string(),
  keys: z.array(z.string()),
});

export type InheritedMetadata = z.infer<typeof InheritedMetadataSchema>;

export interface DomainWithStats {
  id: string;
  name: string;
  description: string;
  policyTemplate: PolicyTemplate | null;
  policyTemplateStatus: "Configured" | "No template";
  entityCount: number;
  isSystem: boolean;
  createdAt: Date;
  updatedAt: Date;
}
