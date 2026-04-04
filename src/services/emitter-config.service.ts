/**
 * Emitter Configuration Service — manages emitter enable/disable state,
 * type mapping administration, and test emitter functionality.
 *
 * Uses in-memory store for MVP. All functions return Result<T>.
 */

import { ok, err } from "@/types/result";
import type { Result } from "@/types/result";
import type { ServiceContext } from "@/types/service-context";
import {
  UpdateEmitterConfigInputSchema,
  type EmitterConfigRecord,
  type EmitterConfigWithStats,
  type TestEmitterResult,
  type TypeMappingPolicyRecord,
  type UpdateEmitterConfigInput,
} from "@/types/schemas/emitter-config";

// ---------------------------------------------------------------------------
// In-memory stores (MVP)
// ---------------------------------------------------------------------------

let configStore: EmitterConfigRecord[] = [];
let emissionStats: Map<string, { lastEmissionAt: Date | null; totalEmissions: number }> = new Map();
let typeMappingStore: TypeMappingPolicyRecord[] = [];
let nextConfigId = 1;
let nextMappingId = 1;

export function _resetEmitterConfigStore(): void {
  configStore = [];
  emissionStats = new Map();
  typeMappingStore = [];
  nextConfigId = 1;
  nextMappingId = 1;
}

export function _seedEmitterConfigs(configs: EmitterConfigRecord[]): void {
  configStore = [...configs];
}

export function _seedTypeMappings(mappings: TypeMappingPolicyRecord[]): void {
  typeMappingStore = [...mappings];
}

export function _getConfigStore(): EmitterConfigRecord[] {
  return configStore;
}

// Seed default emitters on module load
function ensureDefaults(): void {
  if (configStore.length > 0) return;
  const defaults = [
    { name: "bigquery", format: "SQL", version: "1.0.0", description: "Google BigQuery SQL DDL emitter" },
    { name: "avro", format: "JSON", version: "1.0.0", description: "Apache Avro schema emitter" },
    { name: "openapi", format: "YAML", version: "1.0.0", description: "OpenAPI 3.0 specification emitter" },
  ];
  for (const d of defaults) {
    configStore.push({
      id: `emitter-${nextConfigId++}`,
      emitterName: d.name,
      enabled: true,
      configOverrides: null,
      version: d.version,
      targetFormat: d.format,
      description: d.description,
      updatedBy: "system",
      updatedAt: new Date(),
      createdAt: new Date(),
    });
  }
}

// ---------------------------------------------------------------------------
// getEmitterConfigs — fetch all configs with stats (Admin only)
// ---------------------------------------------------------------------------

export async function getEmitterConfigs(
  ctx: ServiceContext
): Promise<Result<EmitterConfigWithStats[]>> {
  if (ctx.userRole !== "ADMIN") {
    return err({
      code: "FORBIDDEN",
      message: "Requires ADMIN role",
      suggestedFix: "Contact your administrator",
    });
  }

  ensureDefaults();

  const results: EmitterConfigWithStats[] = configStore.map((c) => {
    const stats = emissionStats.get(c.emitterName) ?? { lastEmissionAt: null, totalEmissions: 0 };
    return { ...c, ...stats };
  });

  return ok(results);
}

// ---------------------------------------------------------------------------
// getEmitterConfigByName — single config with details (Admin only)
// ---------------------------------------------------------------------------

export async function getEmitterConfigByName(
  name: string,
  ctx: ServiceContext
): Promise<Result<EmitterConfigWithStats>> {
  if (ctx.userRole !== "ADMIN") {
    return err({
      code: "FORBIDDEN",
      message: "Requires ADMIN role",
      suggestedFix: "Contact your administrator",
    });
  }

  ensureDefaults();

  const config = configStore.find((c) => c.emitterName === name);
  if (!config) {
    return err({
      code: "NOT_FOUND",
      message: `Emitter "${name}" not found`,
      suggestedFix: "Verify the emitter name.",
    });
  }

  const stats = emissionStats.get(name) ?? { lastEmissionAt: null, totalEmissions: 0 };
  return ok({ ...config, ...stats });
}

// ---------------------------------------------------------------------------
// updateEmitterConfig — toggle enabled, update config (Admin only)
// ---------------------------------------------------------------------------

export async function updateEmitterConfig(
  input: UpdateEmitterConfigInput,
  ctx: ServiceContext
): Promise<Result<EmitterConfigRecord>> {
  if (ctx.userRole !== "ADMIN") {
    return err({
      code: "FORBIDDEN",
      message: "Requires ADMIN role",
      suggestedFix: "Contact your administrator",
    });
  }

  const parsed = UpdateEmitterConfigInputSchema.safeParse(input);
  if (!parsed.success) {
    return err({
      code: "VALIDATION_ERROR",
      message: parsed.error.issues[0].message,
      suggestedFix: "Check the emitter config input.",
    });
  }

  ensureDefaults();

  const index = configStore.findIndex((c) => c.emitterName === parsed.data.emitterName);
  if (index === -1) {
    return err({
      code: "NOT_FOUND",
      message: `Emitter "${parsed.data.emitterName}" not found`,
      suggestedFix: "Verify the emitter name.",
    });
  }

  const existing = configStore[index];
  configStore[index] = {
    ...existing,
    enabled: parsed.data.enabled ?? existing.enabled,
    configOverrides: parsed.data.configOverrides !== undefined
      ? parsed.data.configOverrides ?? null
      : existing.configOverrides,
    updatedBy: ctx.userId,
    updatedAt: new Date(),
  };

  return ok(configStore[index]);
}

// ---------------------------------------------------------------------------
// testEmitter — run emitter against sample entity (Admin only)
// ---------------------------------------------------------------------------

export async function testEmitter(
  emitterName: string,
  _entityId: string,
  ctx: ServiceContext
): Promise<Result<TestEmitterResult>> {
  if (ctx.userRole !== "ADMIN") {
    return err({
      code: "FORBIDDEN",
      message: "Requires ADMIN role",
      suggestedFix: "Contact your administrator",
    });
  }

  ensureDefaults();

  const config = configStore.find((c) => c.emitterName === emitterName);
  if (!config) {
    return err({
      code: "NOT_FOUND",
      message: `Emitter "${emitterName}" not found`,
      suggestedFix: "Verify the emitter name.",
    });
  }

  // Simulated test output for MVP
  const output = `-- Test output for ${emitterName} emitter\n-- Entity: sample\nCREATE TABLE sample (\n  id STRING NOT NULL\n);`;

  return ok({
    output,
    valid: true,
    validationDetails: ["Schema is valid", "All types resolved"],
    compilationTimeMs: 42,
  });
}

// ---------------------------------------------------------------------------
// getEnabledEmitters — returns enabled emitter names (no RBAC, internal)
// ---------------------------------------------------------------------------

export async function getEnabledEmitters(
  _ctx: ServiceContext
): Promise<Result<string[]>> {
  ensureDefaults();
  const enabled = configStore.filter((c) => c.enabled).map((c) => c.emitterName);
  return ok(enabled);
}

// ---------------------------------------------------------------------------
// Type mapping administration
// ---------------------------------------------------------------------------

export async function getTypeMappingsForTarget(
  targetFormat: string,
  ctx: ServiceContext
): Promise<Result<TypeMappingPolicyRecord[]>> {
  if (ctx.userRole !== "ADMIN") {
    return err({
      code: "FORBIDDEN",
      message: "Requires ADMIN role",
      suggestedFix: "Contact your administrator",
    });
  }

  const mappings = typeMappingStore.filter((m) => m.targetFormat === targetFormat);
  return ok(mappings);
}

export async function createTypeMappingOverride(
  input: { targetFormat: string; sourceType: string; mappedType: string },
  ctx: ServiceContext
): Promise<Result<TypeMappingPolicyRecord>> {
  if (ctx.userRole !== "ADMIN") {
    return err({
      code: "FORBIDDEN",
      message: "Requires ADMIN role",
      suggestedFix: "Contact your administrator",
    });
  }

  const mapping: TypeMappingPolicyRecord = {
    id: `mapping-${nextMappingId++}`,
    targetFormat: input.targetFormat,
    sourceType: input.sourceType,
    mappedType: input.mappedType,
    isLossy: false,
    isOverride: true,
  };

  typeMappingStore.push(mapping);
  return ok(mapping);
}

export async function updateTypeMapping(
  id: string,
  mappedType: string,
  ctx: ServiceContext
): Promise<Result<TypeMappingPolicyRecord>> {
  if (ctx.userRole !== "ADMIN") {
    return err({
      code: "FORBIDDEN",
      message: "Requires ADMIN role",
      suggestedFix: "Contact your administrator",
    });
  }

  const index = typeMappingStore.findIndex((m) => m.id === id);
  if (index === -1) {
    return err({
      code: "NOT_FOUND",
      message: `Type mapping "${id}" not found`,
      suggestedFix: "Verify the mapping ID.",
    });
  }

  typeMappingStore[index] = { ...typeMappingStore[index], mappedType };
  return ok(typeMappingStore[index]);
}

export async function deleteTypeMappingOverride(
  id: string,
  ctx: ServiceContext
): Promise<Result<void>> {
  if (ctx.userRole !== "ADMIN") {
    return err({
      code: "FORBIDDEN",
      message: "Requires ADMIN role",
      suggestedFix: "Contact your administrator",
    });
  }

  const index = typeMappingStore.findIndex((m) => m.id === id);
  if (index === -1) {
    return err({
      code: "NOT_FOUND",
      message: `Type mapping "${id}" not found`,
      suggestedFix: "Verify the mapping ID.",
    });
  }

  if (!typeMappingStore[index].isOverride) {
    return err({
      code: "FORBIDDEN",
      message: "Cannot delete system default type mappings",
      suggestedFix: "Only override mappings can be deleted.",
    });
  }

  typeMappingStore.splice(index, 1);
  return ok(undefined);
}
