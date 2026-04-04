import { z } from "zod";

export const ComponentStatusSchema = z.object({
  name: z.string(),
  status: z.enum(["healthy", "degraded", "unhealthy"]),
  message: z.string().optional(),
  latencyMs: z.number().optional(),
});

export type ComponentStatus = z.infer<typeof ComponentStatusSchema>;

export const HealthCheckResponseSchema = z.object({
  status: z.enum(["healthy", "degraded", "unhealthy"]),
  components: z.object({
    database: ComponentStatusSchema,
    compiler: ComponentStatusSchema,
    emitters: ComponentStatusSchema,
  }),
  timestamp: z.string(),
});

export type HealthCheckResponse = z.infer<typeof HealthCheckResponseSchema>;

export const UsageMetricsSchema = z.object({
  totalEntities: z.number(),
  totalFields: z.number(),
  totalDomains: z.number(),
  totalUsers: z.number(),
  totalEmissions: z.number(),
});

export type UsageMetrics = z.infer<typeof UsageMetricsSchema>;

export const ActivityMetricsSchema = z.object({
  activeUsers24h: z.number(),
  emissionsToday: z.number(),
  schemaChangesToday: z.number(),
  governanceRequestsPending: z.number(),
});

export type ActivityMetrics = z.infer<typeof ActivityMetricsSchema>;

export const ErrorSummarySchema = z.object({
  compilationErrors24h: z.number(),
  emissionValidationFailures24h: z.number(),
  apiErrors24h: z.number(),
});

export type ErrorSummary = z.infer<typeof ErrorSummarySchema>;

export interface AuditLogEntry {
  id: string;
  action: string;
  entityType: string;
  entityId: string;
  userId: string;
  timestamp: Date;
  details?: Record<string, unknown>;
}
