"use server";

/**
 * "Import OpenAPI" on the entity API tab: preview the operations an OpenAPI document holds, then create the chosen ones on the
 * entity's API service.
 *
 * - `previewOpenApiOperationsAction` parses pasted / uploaded text, or fetches a URL (the importer's guarded fetch: https, public
 *   hosts, size / time limits, the process-wide URL import limiter), and maps it with `import-openapi.ts`. It writes nothing. The
 *   caller must hold `asset.write` over the entity (the right the import itself needs), checked before anything is parsed or fetched.
 * - `importOpenApiOperationsAction` takes the operations back from the browser (untrusted: each is re-validated), creates the entity
 *   service when there is none yet (`getOrCreateEntityServiceAction`), skips what the service already has (same method + path),
 *   renames a clashing name / operationId, and creates the rest in ONE transaction.
 */

import { prisma } from "@/lib/db";
import { revalidatePath } from "next/cache";
import { getPrincipal } from "@/lib/access/principal";
import { guardSubject, sanitizeActionError, unexpectedFailure } from "@/lib/action-context";
import { withCompileTimeout } from "@/lib/compiler/import-limits";
import { urlImportLimiter } from "@/lib/importers/import-limiter";
import { DEFAULT_LIMITS } from "@/lib/importers/jsonschema-ref-resolver";
import {
  fetchOpenApiText,
  MAX_IMPORTED_OPERATIONS,
  parseOpenApiText,
  type OpenApiImportResult,
} from "@/lib/api-operations/import-openapi";
import { checkApiOperation, formatIssues, parseApiOperation, pathTemplateKey, validateApiOperation } from "@/lib/api-operations/validate";
import { OPERATION_DETAILS_INCLUDE, operationChildRows, operationColumns, operationFromRecord, operationRecordFromRow } from "@/lib/api-operations/records";
import { err, type Result } from "@/types/result";
import type { ApiOperation, ApiOperationRecord } from "@/types/schemas/api-operation";
import { getOrCreateEntityServiceAction } from "./actions";

export type OpenApiSource = { kind: "text"; content: string } | { kind: "url"; url: string };

const PREVIEW_LABEL = "previewOpenApiOperationsAction";
/** The guarded fetch's overall timeout plus time to validate and map. */
const URL_PREVIEW_TIMEOUT_MS = DEFAULT_LIMITS.overallTimeoutMs + 30_000;

export async function previewOpenApiOperationsAction(entityId: string, source: OpenApiSource): Promise<Result<OpenApiImportResult>> {
  return sanitizeActionError(runPreview(entityId, source), PREVIEW_LABEL);
}

async function runPreview(entityId: string, source: OpenApiSource): Promise<Result<OpenApiImportResult>> {
  if (typeof entityId !== "string" || !entityId) return err({ code: "VALIDATION_ERROR", message: "Entity id is required" });
  const access = await guardSubject("asset.write", { kind: "entity", id: entityId }, { label: "Entity" });
  if (!access.allowed) return err({ code: access.refusal.code ?? "NOT_FOUND", message: access.refusal.error });

  if (source?.kind === "text") return withTimeout(() => parseOpenApiText(source.content));
  if (source?.kind !== "url") return err({ code: "VALIDATION_ERROR", message: "Provide OpenAPI content or a URL" });

  const principal = await getPrincipal();
  if (!principal) return err({ code: "UNAUTHORIZED", message: "Not authenticated" });
  if (typeof source.url !== "string" || !source.url.trim()) {
    return err({ code: "VALIDATION_ERROR", message: "An OpenAPI URL is required", suggestedFix: "Provide an https URL of an OpenAPI document." });
  }
  // Same admission control as the JSON Schema URL import: one slot per running fetch, a per-user window.
  const slot = urlImportLimiter.acquire(principal.userId);
  if (!slot.ok) {
    return err({
      code: slot.reason === "busy" ? "IMPORT_BUSY" : "RATE_LIMITED",
      message: slot.message,
      suggestedFix: `Try again in ${Math.ceil(slot.retryAfterMs / 1000)} seconds.`,
    });
  }
  const running = (async () => {
    const fetched = await fetchOpenApiText(source.url);
    return fetched.success ? parseOpenApiText(fetched.data) : fetched;
  })();
  void running.then(slot.release, slot.release);
  return withTimeout(() => running, URL_PREVIEW_TIMEOUT_MS);
}

async function withTimeout(task: () => Promise<Result<OpenApiImportResult>>, ms?: number): Promise<Result<OpenApiImportResult>> {
  const result = await withCompileTimeout(task, ms);
  return result.success ? result.data : result;
}

export interface ImportOpenApiOperationsInput {
  /** The entity's API service; null when the entity has none yet (it is created). */
  serviceId: string | null;
  domainId: string | null;
  entityId: string;
  entityName: string;
  /** Operations from `previewOpenApiOperationsAction` (the ones the user kept). */
  operations: unknown[];
}

export type ImportOpenApiOperationsResult =
  | { success: true; serviceId: string; created: ApiOperationRecord[]; warnings: string[] }
  | { success?: undefined; error: string; code?: string };

const effectiveId = (op: ApiOperation) => op.operationId ?? op.name;

function freeName(base: string, taken: Set<string>): string {
  let name = base;
  for (let i = 2; taken.has(name); i++) name = `${base}_${i}`;
  return name;
}

export async function importOpenApiOperationsAction(input: ImportOpenApiOperationsInput): Promise<ImportOpenApiOperationsResult> {
  if (!input || typeof input !== "object") return { error: "Expected an import request", code: "VALIDATION_ERROR" };
  const { serviceId, domainId, entityId, entityName, operations } = input;
  if (!Array.isArray(operations) || operations.length === 0) return { error: "Select at least one operation to import", code: "VALIDATION_ERROR" };
  if (operations.length > MAX_IMPORTED_OPERATIONS) {
    return { error: `At most ${MAX_IMPORTED_OPERATIONS} operations can be imported at once`, code: "VALIDATION_ERROR" };
  }
  if (serviceId !== null && (typeof serviceId !== "string" || !serviceId)) return { error: "Service id is invalid", code: "VALIDATION_ERROR" };

  // Shape + own rules first: a malformed payload is refused before any query.
  const warnings: string[] = [];
  const candidates: ApiOperation[] = [];
  operations.forEach((raw, i) => {
    const parsed = parseApiOperation(raw);
    const label = parsed.success ? `${parsed.data.httpMethod} ${parsed.data.httpPath}` : `Operation ${i + 1}`;
    if (!parsed.success) return void warnings.push(`${label} was not imported: ${formatIssues(parsed.issues)}`);
    const issues = checkApiOperation(parsed.data);
    if (issues.length) return void warnings.push(`${label} was not imported: ${formatIssues(issues)}`);
    candidates.push(parsed.data);
  });
  if (candidates.length === 0) return { error: warnings[0] ?? "No valid operation to import", code: "VALIDATION_ERROR" };

  try {
    let targetServiceId = serviceId;
    if (targetServiceId === null) {
      const service = await getOrCreateEntityServiceAction(domainId ?? "", entityId, entityName);
      if (!("success" in service) || !service.success || !service.serviceId) {
        return { error: "error" in service && service.error ? service.error : "The entity API could not be created", code: "code" in service ? (service.code as string) : undefined };
      }
      targetServiceId = service.serviceId;
    }
    const access = await guardSubject("asset.write", { kind: "service", id: targetServiceId }, { label: "API service" });
    if (!access.allowed) return { error: access.refusal.error, code: access.refusal.code };

    const rows = await prisma.operation.findMany({ where: { serviceId: targetServiceId }, include: OPERATION_DETAILS_INCLUDE });
    const existing = (rows ?? []).map(operationRecordFromRow).map(operationFromRecord);
    const accepted: ApiOperation[] = [];
    for (const candidate of candidates) {
      const label = `${candidate.httpMethod} ${candidate.httpPath}`;
      const siblings = [...existing, ...accepted];
      const key = pathTemplateKey(candidate.httpPath);
      const duplicate = siblings.find((s) => s.httpMethod === candidate.httpMethod && pathTemplateKey(s.httpPath) === key);
      if (duplicate) {
        warnings.push(`${label} already exists ("${duplicate.name}"); skipped.`);
        continue;
      }
      // A clashing name / operationId is renamed, not refused: the imported document's ids are only suggestions here.
      let op = candidate;
      const taken = new Set(siblings.flatMap((s) => [s.name, effectiveId(s)]));
      if (taken.has(op.name) || taken.has(effectiveId(op))) {
        const name = freeName(op.name, taken);
        const operationId = op.operationId ? freeName(op.operationId, taken) : undefined;
        warnings.push(`${label}: "${effectiveId(op)}" is already used by another operation; imported as "${operationId ?? name}".`);
        op = { ...op, name, operationId };
      }
      const validation = await validateApiOperation(op, siblings);
      if (!validation.valid) {
        warnings.push(`${label} was not imported: ${formatIssues(validation.issues)}`);
        continue;
      }
      for (const w of validation.warnings) warnings.push(`${label}: ${w.message}`);
      accepted.push(validation.operation);
    }

    if (accepted.length === 0) return { success: true, serviceId: targetServiceId, created: [], warnings };

    const created = await prisma.$transaction(
      accepted.map((op) => {
        const children = operationChildRows(op);
        return prisma.operation.create({
          data: { serviceId: targetServiceId, ...operationColumns(op), parameters: { create: children.parameters }, responses: { create: children.responses } },
          include: OPERATION_DETAILS_INCLUDE,
        });
      })
    );
    revalidatePath("/schemas");
    return { success: true, serviceId: targetServiceId, created: created.map(operationRecordFromRow), warnings };
  } catch (e: unknown) {
    return { ...unexpectedFailure("importOpenApiOperationsAction", e) };
  }
}
