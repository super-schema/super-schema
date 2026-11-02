import { ok, err, type Result } from "@/types/result";
import type { Diagnostic, EmitOutput, ImportedEventSpec, ResolvedEventSpec } from "./types";
import { normalizeDiagnostics } from "./diagnostics";
import { assembleAsyncApi3 } from "./assemble";
import { documentSizeProblem, toJson, toYaml } from "./serialize";
import { StructuralAsyncApi3Validator, validatorFailure, type EventSpecValidator } from "./validator";

/**
 * Spec §7.1. One adapter per `EventSpec.specType`. A new emission scope (whole
 * spec), separate from the per-entity targets in `src/lib/schema-targets/catalog.ts`.
 */
export interface EventSpecAdapter {
  readonly specType: string;
  emit(input: ResolvedEventSpec): Promise<Result<EmitOutput>>;
  validate(document: object): Promise<Result<Diagnostic[]>>;
  import(content: string): Promise<Result<ImportedEventSpec>>;
}

export const ASYNCAPI_3_SPEC_TYPE = "asyncapi@3.0";

export type AsyncApi3AdapterOptions = {
  /**
   * Run in order; default: the built-in structural validator only (pure, dependency-free).
   * The `@asyncapi/parser` validator is opt-in and Node-only (server code, never client
   * components); it is not part of the barrel, import it from its own module:
   *   `new AsyncApi3Adapter({ validators: [new AsyncApiParserValidator()] })`
   *   (`@/lib/event-specs/validation/asyncapi-parser-validator`) — or combine both validators.
   */
  validators?: EventSpecValidator[];
};

export class AsyncApi3Adapter implements EventSpecAdapter {
  readonly specType = ASYNCAPI_3_SPEC_TYPE;
  private readonly validators: EventSpecValidator[];

  constructor(options: AsyncApi3AdapterOptions = {}) {
    this.validators = options.validators ?? [new StructuralAsyncApi3Validator()];
  }

  /**
   * Assemble (steps 3–5) → validate (step 6) → serialize (step 7). Document
   * problems are returned as diagnostics alongside the document — callers decide
   * (publish blocks on any `error`; draft preview shows them). Only a validator
   * failure yields an `err` Result.
   */
  async emit(input: ResolvedEventSpec): Promise<Result<EmitOutput>> {
    let assembled: ReturnType<typeof assembleAsyncApi3>;
    try {
      assembled = assembleAsyncApi3(input);
    } catch (e) {
      // The assembler copies user JSON with `structuredClone`, which runs out of stack on a binding nested thousands of levels deep.
      if (!(e instanceof RangeError)) throw e;
      return err({
        code: "VALIDATION_ERROR",
        message: "The AsyncAPI document cannot be emitted: it nests too deeply to copy. Shorten the bindings, examples or payload schemas.",
      });
    }
    // Refused before any validator runs and before anything is serialized: the cost of both grows with the document (see serialize.ts).
    const tooLarge = documentSizeProblem(assembled.document);
    if (tooLarge !== null) {
      return err({
        code: "VALIDATION_ERROR",
        message: `The AsyncAPI document cannot be emitted: ${tooLarge}. Shorten the bindings, examples or payload schemas.`,
      });
    }
    const validated = await this.validate(assembled.document);
    if (!validated.success) return validated;
    return ok({
      document: assembled.document,
      json: toJson(assembled.document),
      yaml: toYaml(assembled.document),
      diagnostics: normalizeDiagnostics([...assembled.diagnostics, ...validated.data]),
    });
  }

  async validate(document: object): Promise<Result<Diagnostic[]>> {
    const all: Diagnostic[] = [];
    for (const validator of this.validators) {
      let result: Result<Diagnostic[]>;
      try {
        result = await validator.validate(document);
      } catch (e) {
        // Raw exception text stays in the server log; callers (and through them the browser) get the generic message.
        return validatorFailure("VALIDATOR_FAILED", `validator "${validator.name}"`, e);
      }
      if (!result.success) return result;
      all.push(...result.data);
    }
    return ok(normalizeDiagnostics(all));
  }

  async import(content: string): Promise<Result<ImportedEventSpec>> {
    return err({
      code: "NOT_IMPLEMENTED",
      message: "AsyncAPI import is not implemented yet (Epic 19; needs @asyncapi/parser, registry-blocked)",
      details: { receivedBytes: content.length },
    });
  }
}

/** Adapter lookup by `EventSpec.specType` (spec §6.1; more spec types via Story 22.7). */
export function getEventSpecAdapter(specType: string, options?: AsyncApi3AdapterOptions): Result<EventSpecAdapter> {
  if (specType === ASYNCAPI_3_SPEC_TYPE) return ok(new AsyncApi3Adapter(options));
  return err({ code: "UNSUPPORTED_SPEC_TYPE", message: `No event spec adapter for spec type "${specType}"` });
}
