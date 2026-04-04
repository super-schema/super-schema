/**
 * MockCompilerService — implements ICompilerService for testing
 * without requiring the TypeSpec compiler.
 *
 * Returns pre-defined outputs. Responses are configurable via constructor.
 */

import type {
  ICompilerService,
  CompilationResult,
  CompilationDiagnostic,
  EmitterResult,
  ValidationResult,
} from "./types";
import type { SuperSchemaModel, MappingPolicy } from "@/types/super-schema-model";

// ---------------------------------------------------------------------------
// Configuration for mock responses
// ---------------------------------------------------------------------------

export interface MockCompilerConfig {
  /** If set, compile() always returns this result. */
  compileResult?: CompilationResult;

  /** If set, compile() returns error for sources matching these patterns. */
  errorPatterns?: Array<{
    pattern: RegExp;
    diagnostics: CompilationDiagnostic[];
  }>;

  /** If set, emit() returns this result. */
  emitResult?: EmitterResult;

  /** If set, validate() returns this result. */
  validateResult?: ValidationResult;
}

// ---------------------------------------------------------------------------
// MockCompilerService
// ---------------------------------------------------------------------------

export class MockCompilerService implements ICompilerService {
  private config: MockCompilerConfig;
  public compileCalls: string[] = [];
  public emitCalls: Array<{ model: SuperSchemaModel; target: string; policies: MappingPolicy[] }> = [];
  public validateCalls: Array<{ output: string; targetFormat: string }> = [];

  constructor(config: MockCompilerConfig = {}) {
    this.config = config;
  }

  async compile(source: string): Promise<CompilationResult> {
    this.compileCalls.push(source);

    // Check error patterns first
    if (this.config.errorPatterns) {
      for (const { pattern, diagnostics } of this.config.errorPatterns) {
        if (pattern.test(source)) {
          return {
            success: false,
            diagnostics,
          };
        }
      }
    }

    // Return configured result or default success
    if (this.config.compileResult) {
      return this.config.compileResult;
    }

    return {
      success: true,
      diagnostics: [],
      generatedSource: source,
    };
  }

  async emit(
    model: SuperSchemaModel,
    target: string,
    policies: MappingPolicy[]
  ): Promise<EmitterResult> {
    this.emitCalls.push({ model, target, policies });

    if (this.config.emitResult) {
      return this.config.emitResult;
    }

    return {
      output: `// Mock ${target} output for ${model.entity.name}`,
      warnings: [],
      targetFormat: target,
    };
  }

  async validate(
    output: string,
    targetFormat: string
  ): Promise<ValidationResult> {
    this.validateCalls.push({ output, targetFormat });

    if (this.config.validateResult) {
      return this.config.validateResult;
    }

    return {
      valid: true,
      errors: [],
    };
  }

  /**
   * Update the mock configuration at runtime (useful in tests).
   */
  setConfig(config: Partial<MockCompilerConfig>): void {
    this.config = { ...this.config, ...config };
  }

  /**
   * Reset all recorded calls.
   */
  reset(): void {
    this.compileCalls = [];
    this.emitCalls = [];
    this.validateCalls = [];
  }
}
