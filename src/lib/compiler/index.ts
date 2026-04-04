/**
 * Barrel export for the compiler module.
 */

// Types & interfaces
export type {
  ICompilerService,
  CompilationResult,
  CompilationDiagnostic,
  EmitterResult,
  EmitterWarning,
  ValidationResult,
  ValidationError,
  Emitter,
} from "./types";

// SuperSchemaModel & related types
export type {
  SuperSchemaModel,
  SuperSchemaField,
  SuperSchemaRelationship,
  SuperSchemaEntityMetadata,
  LogicalType,
  DecoratorSet,
  MappingPolicy,
  ComplexTypeInfo,
  NestedFieldInfo,
} from "@/types/super-schema-model";

// Compiler service (pure function)
export { compileEntity } from "./compiler.service";
export type { PrismaEntityInput, PrismaFieldInput } from "./compiler.service";

// TypeSpec generator
export {
  generateTypeSpec,
  generateTypeSpecWithSourceMap,
} from "./typespec-generator";
export type { SourceMapEntry } from "./typespec-generator";

// Error mapper
export { mapDiagnosticsToFields } from "./error-mapper";

// Mock compiler service
export { MockCompilerService } from "./mock-compiler";
export type { MockCompilerConfig } from "./mock-compiler";
