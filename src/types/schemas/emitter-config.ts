import { z } from "zod";

export const EmitterConfigSchema = z.object({
  emitterName: z.string().min(1),
  enabled: z.boolean(),
  configOverrides: z.record(z.string(), z.unknown()).optional(),
});

export type EmitterConfig = z.infer<typeof EmitterConfigSchema>;

export const UpdateEmitterConfigInputSchema = z.object({
  emitterName: z.string().min(1),
  enabled: z.boolean().optional(),
  configOverrides: z.record(z.string(), z.unknown()).optional(),
});

export type UpdateEmitterConfigInput = z.infer<typeof UpdateEmitterConfigInputSchema>;

export const TestEmitterInputSchema = z.object({
  emitterName: z.string().min(1),
  entityId: z.string().min(1),
});

export type TestEmitterInput = z.infer<typeof TestEmitterInputSchema>;

export const CreateTypeMappingOverrideInputSchema = z.object({
  targetFormat: z.string().min(1),
  sourceType: z.string().min(1),
  mappedType: z.string().min(1),
  isOverride: z.literal(true),
});

export type CreateTypeMappingOverrideInput = z.infer<typeof CreateTypeMappingOverrideInputSchema>;

export interface EmitterConfigRecord {
  id: string;
  emitterName: string;
  enabled: boolean;
  configOverrides: Record<string, unknown> | null;
  version: string;
  targetFormat: string;
  description: string;
  updatedBy: string;
  updatedAt: Date;
  createdAt: Date;
}

export interface EmitterConfigWithStats extends EmitterConfigRecord {
  lastEmissionAt: Date | null;
  totalEmissions: number;
}

export interface TestEmitterResult {
  output: string;
  valid: boolean;
  validationDetails: string[];
  compilationTimeMs: number;
}

export interface TypeMappingPolicyRecord {
  id: string;
  targetFormat: string;
  sourceType: string;
  mappedType: string;
  isLossy: boolean;
  isOverride: boolean;
}
