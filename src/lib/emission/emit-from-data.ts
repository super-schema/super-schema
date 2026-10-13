/**
 * emitFromData() — pure function that runs the emission pipeline
 * from pre-loaded entity + fields data.
 *
 * No Prisma dependency — suitable for unit testing.
 */

import { compileEntity } from "@/lib/compiler/compiler.service";
import type { PrismaEntityInput, PrismaFieldInput } from "@/lib/compiler/compiler.service";
import { generateTypeSpec } from "@/lib/compiler/typespec-generator";
import { getAllEmitters } from "@/emitters";
import { getDefaultPolicies } from "@/lib/type-mapping/default-mappings";
import type { ScopedMappingPolicy } from "@/lib/type-mapping/types";
import type { EmissionResult, TargetOutput, ValidationStatus } from "./emission.types";

/**
 * Run the emission pipeline from pre-loaded entity + fields data.
 * Pure function — no I/O, no database access.
 *
 * 1. Compile entity + fields to SuperSchemaModel IR
 * 2. Generate TypeSpec source
 * 3. Run all registered emitters with default + override policies
 * 4. Collect and return results
 *
 * @param overridePolicies - Optional override policies to merge with defaults
 * @param formatOptionsByTarget - Optional per-emitter binding options, keyed
 *   by emitter name (e.g. `{ avro: { perField: {...} } }`)
 */
export function emitFromData(
  entity: PrismaEntityInput,
  fields: PrismaFieldInput[],
  overridePolicies?: ScopedMappingPolicy[],
  formatOptionsByTarget?: Record<string, Record<string, unknown>>
): EmissionResult {
  // Compile to IR
  const model = compileEntity(entity, fields);

  // Generate TypeSpec source
  const typespec = generateTypeSpec(model);

  // Get default mapping policies, merged with any overrides
  const policies = [
    ...getDefaultPolicies(),
    ...(overridePolicies ?? []),
  ];

  // Run all emitters
  const emitters = getAllEmitters();
  const targets: Record<string, TargetOutput> = {};

  let validCount = 0;
  let warningCount = 0;
  let invalidCount = 0;

  for (const emitter of emitters) {
    // Emit
    const emitterResult = emitter.emit(model, policies, formatOptionsByTarget?.[emitter.name]);

    // Validate
    const validationResult = emitter.validate(emitterResult.output);

    // Determine status
    let validationStatus: ValidationStatus;
    if (!validationResult.valid) {
      validationStatus = "INVALID";
      invalidCount++;
    } else if (emitterResult.warnings.length > 0) {
      validationStatus = "WARNING";
      warningCount++;
    } else {
      validationStatus = "VALID";
      validCount++;
    }

    targets[emitter.name] = {
      name: emitter.name,
      targetFormat: emitter.targetFormat,
      output: emitterResult.output,
      isValid: validationResult.valid,
      validationStatus,
      warnings: emitterResult.warnings,
      errors: validationResult.errors,
    };
  }

  const totalTargets = emitters.length;
  const success = invalidCount === 0;

  return {
    typespec,
    targets,
    success,
    summary: {
      totalTargets,
      validCount,
      warningCount,
      invalidCount,
    },
  };
}
