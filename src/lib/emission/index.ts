/**
 * Emission pipeline barrel export.
 */

export { emitEntity, emitFromData } from "./emission.service";
export { emitFromData as emitFromDataPure } from "./emit-from-data";
export type {
  EmissionResult,
  TargetOutput,
  ValidationStatus,
} from "./emission.types";
