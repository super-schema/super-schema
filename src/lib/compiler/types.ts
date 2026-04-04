/**
 * ICompilerService interface and related types.
 *
 * All consumers depend on this interface, never on the concrete
 * TypeSpecCompilerService. This enables:
 * - Unit tests to use MockCompilerService (fast, no TypeSpec dependency)
 * - Integration tests to use TypeSpecCompilerService (real compiler)
 * - Future IR replacement without changing emitters
 */

import type { SuperSchemaModel, MappingPolicy } from "@/types/super-schema-model";

// ---------------------------------------------------------------------------
// Compilation diagnostic
// ---------------------------------------------------------------------------

export interface CompilationDiagnostic {
  message: string;
  line: number;
  column: number;
  fieldName?: string;
  suggestedFix?: string;
  severity: "error" | "warning";
}

// ---------------------------------------------------------------------------
// Compilation result
// ---------------------------------------------------------------------------

export interface CompilationResult {
  success: boolean;
  model?: SuperSchemaModel;
  diagnostics: CompilationDiagnostic[];
  generatedSource?: string;
}

// ---------------------------------------------------------------------------
// Emitter warning
// ---------------------------------------------------------------------------

export interface EmitterWarning {
  message: string;
  fieldName?: string;
}

// ---------------------------------------------------------------------------
// Emitter result
// ---------------------------------------------------------------------------

export interface EmitterResult {
  output: string;
  warnings: EmitterWarning[];
  targetFormat: string;
}

// ---------------------------------------------------------------------------
// Validation error
// ---------------------------------------------------------------------------

export interface ValidationError {
  message: string;
  path?: string;
  line?: number;
  column?: number;
}

// ---------------------------------------------------------------------------
// Validation result
// ---------------------------------------------------------------------------

export interface ValidationResult {
  valid: boolean;
  errors: ValidationError[];
}

// ---------------------------------------------------------------------------
// ICompilerService interface
// ---------------------------------------------------------------------------

export interface ICompilerService {
  /**
   * Compile TypeSpec source and return the compiled program or error diagnostics.
   */
  compile(source: string): Promise<CompilationResult>;

  /**
   * Emit a schema for a specific target using the intermediate model.
   */
  emit(
    model: SuperSchemaModel,
    target: string,
    policies: MappingPolicy[]
  ): Promise<EmitterResult>;

  /**
   * Validate emitted output against the target format's specification.
   */
  validate(output: string, targetFormat: string): Promise<ValidationResult>;
}

// ---------------------------------------------------------------------------
// Emitter interface — consumers of the SuperSchemaModel
// ---------------------------------------------------------------------------

export interface Emitter {
  name: string;
  version: string;
  targetFormat: string;
  emit(model: SuperSchemaModel, policies: MappingPolicy[]): EmitterResult;
  validate(output: string): ValidationResult;
}
