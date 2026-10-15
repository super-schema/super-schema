import { z } from "zod";

// ============================================================
// Story 6.1 — Compliance Query Types
// ============================================================

export const RetentionRangeEnum = z.enum([
  "any",
  "lt_1_year",
  "1_to_3_years",
  "3_to_7_years",
  "gt_7_years",
]);
export type RetentionRange = z.infer<typeof RetentionRangeEnum>;

export const AnonymizationEnum = z.enum([
  "any",
  "none",
  "hash",
  "mask",
  "redact",
  "pseudonymize",
]);
export type AnonymizationMethod = z.infer<typeof AnonymizationEnum>;

export const EncryptionEnum = z.enum([
  "any",
  "none",
  "AES-256",
  "field-level",
]);
export type EncryptionMethod = z.infer<typeof EncryptionEnum>;

export const ComplianceFilterSchema = z
  .object({
    classifications: z.array(z.string()).default([]),
    retention: RetentionRangeEnum.default("any"),
    anonymization: AnonymizationEnum.default("any"),
    encryption: EncryptionEnum.default("any"),
    targets: z.array(z.string()).default([]),
    domains: z.array(z.string()).default([]),
    textSearch: z.string().default(""),
  })
  .partial();

export type ComplianceFilter = z.infer<typeof ComplianceFilterSchema>;

export const PaginationSchema = z.object({
  page: z.number().int().min(1).default(1),
  pageSize: z.number().int().min(1).max(250).default(25),
  sortBy: z.string().default("entityName"),
  sortOrder: z.enum(["asc", "desc"]).default("asc"),
});

export type Pagination = z.infer<typeof PaginationSchema>;

export type ComplianceFieldResult = {
  entityId: string;
  entityName: string;
  entitySlug?: string;
  /** Route slugs for links; `null` for a tenant-level (Enterprise) entity. */
  domainSlug: string | null;
  productSlug: string | null;
  fieldId: string;
  fieldName: string;
  fieldType: string;
  classification: string | null;
  retention: string | null;
  anonymization: string | null;
  encryption: string | null;
  targetSystems: string[];
  domain: string;
  /** null for tenant-level entities (no domain placement). */
  domainId: string | null;
};

// ============================================================
// Story 6.2 — Gap Detection Types
// ============================================================

export const GapTypeEnum = z.enum([
  "PII_NO_ANONYMIZATION",
  "SENSITIVE_NO_ENCRYPTION",
  "UNCLASSIFIED",
  "NO_RETENTION",
]);
export type GapType = z.infer<typeof GapTypeEnum>;

export const GapSeverityEnum = z.enum(["CRITICAL", "WARNING"]);
export type GapSeverity = z.infer<typeof GapSeverityEnum>;

export type ComplianceGap = {
  entityId: string;
  entityName: string;
  entitySlug?: string;
  /** Route slugs for links; `null` for a tenant-level (Enterprise) entity. */
  domainSlug: string | null;
  productSlug: string | null;
  fieldId: string;
  fieldName: string;
  gapType: GapType;
  severity: GapSeverity;
  suggestedFix: string;
};

export type GapSummary = {
  criticalCount: number;
  warningCount: number;
  affectedEntityCount: number;
  countsByGapType: Record<string, number>;
};

export const GapFilterSchema = z
  .object({
    domains: z.array(z.string()).default([]),
    entities: z.array(z.string()).default([]),
  })
  .partial();

export type GapFilter = z.infer<typeof GapFilterSchema>;

// ============================================================
// Story 6.5 — Audit Trail Types
// ============================================================

export const AuditTrailFilterSchema = z
  .object({
    actionTypes: z.array(z.string()).default([]),
    userId: z.string().optional(),
    entityType: z.string().optional(),
    entityName: z.string().optional(),
    dateRange: z
      .object({
        from: z.coerce.date(),
        to: z.coerce.date(),
      })
      .optional(),
  })
  .partial();

export type AuditTrailFilter = z.infer<typeof AuditTrailFilterSchema>;

export const AuditPaginationSchema = z.object({
  page: z.number().int().min(1).default(1),
  pageSize: z.number().int().min(1).max(250).default(50),
});

export type AuditPagination = z.infer<typeof AuditPaginationSchema>;

export type AuditTrailEntry = {
  id: string;
  action: string;
  entityType: string;
  entityId: string;
  entityName: string | null;
  userId: string;
  userName: string | null;
  userAvatar: string | null;
  timestamp: Date;
  beforeState: unknown;
  afterState: unknown;
  changeSummary: string;
};

// ============================================================
// Story 6.4 — Annotation Types
// ============================================================

export const CreateAnnotationInputSchema = z.object({
  entityId: z.string().optional(),
  fieldId: z.string().optional(),
  content: z.string().min(1, "Annotation content is required"),
  taggedUserIds: z.array(z.string()).default([]),
});

export type CreateAnnotationInput = z.infer<
  typeof CreateAnnotationInputSchema
>;

export type Annotation = {
  id: string;
  entityId: string | null;
  fieldId: string | null;
  authorId: string;
  authorName: string | null;
  authorAvatar: string | null;
  content: string;
  taggedUserIds: string[];
  resolved: boolean;
  createdAt: Date;
  updatedAt: Date;
};

// ============================================================
// Story 6.3 — Export Types
// ============================================================

export type ExportFormat = "csv" | "json";

export type ComplianceExportOptions = {
  format: ExportFormat;
  filters: ComplianceFilter;
  includeGaps: boolean;
  sortBy?: string;
  sortOrder?: "asc" | "desc";
};
