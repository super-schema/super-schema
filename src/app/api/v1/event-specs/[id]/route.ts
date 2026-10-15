/**
 * GET /api/v1/event-specs/:id?version=<MAJOR.MINOR|draft>&format=yaml|json (spec §7.4, Story 18.7).
 *
 * version omitted → latest published version (404 when never published; pass version=draft);
 * a published version is the stored document, never regenerated (spec §7.2 step 1).
 * The body is the raw AsyncAPI document; errors use the v1 JSON error envelope.
 *
 * Tenant scoping (R67): `emitEventSpec` reads by id and trusts the row's own tenant, so this route resolves the caller's
 * tenant and looks the spec up inside it BEFORE any other read. A spec of another tenant and a spec that does not exist
 * produce the same 404 — nothing downstream runs, nothing in the body depends on which case it was.
 *
 * Error bodies never carry service / database text: ServiceError codes are mapped to a status and a fixed message
 * (the original is logged server-side); only already-sanitised draft diagnostics are returned, field-whitelisted.
 */
import type { NextResponse } from "next/server";
import { authenticateRequest } from "@/app/api/v1/middleware";
import { checkRateLimit } from "@/app/api/v1/rate-limit";
import { apiError, apiServerError, apiUnauthorized } from "@/app/api/v1/error-handler";
import { getActiveTenantId } from "@/lib/active-tenant";
import type { Diagnostic } from "@/lib/event-specs";
import { emitEventSpec, getLatestEventSpecVersionLabel, type EmitTarget } from "@/services/events/event-spec-emit.service";
import type { ServiceError } from "@/types/result";

const CONTENT_TYPE = { yaml: "application/yaml; charset=utf-8", json: "application/json; charset=utf-8" } as const;
const VERSION_PARAM = /^(\d+)\.(\d+)$/;
/** `EventSpecVersion.major` / `.minor` are Postgres `integer`; anything larger cannot exist (and would make the driver throw). */
const MAX_VERSION_PART = 2_147_483_647;
const MAX_STEM_LENGTH = 100;
const FALLBACK_STEM = "event-spec";

/** A header-safe file stem: ASCII letters, digits, `.`, `_`, `-` only; no leading / trailing separators; bounded. */
function fileStem(name: string): string {
  const stem = name
    .replace(/[^A-Za-z0-9._-]+/g, "-")
    .replace(/-{2,}/g, "-")
    .slice(0, MAX_STEM_LENGTH)
    .replace(/^[.-]+|[.-]+$/g, "");
  return stem || FALLBACK_STEM;
}

/** `"01.00"` → `"1.0"`; null when no such version can exist (major < 1, or a part beyond the database's integer range). */
function toVersionLabel(param: string): string | null {
  const match = VERSION_PARAM.exec(param);
  if (!match) return null;
  const major = Number(match[1]);
  const minor = Number(match[2]);
  if (major < 1 || major > MAX_VERSION_PART || minor > MAX_VERSION_PART) return null;
  return `${major}.${minor}`;
}

const publicDiagnostics = (list: Diagnostic[]) => list.map(({ severity, code, message, pointer }) => ({ severity, code, message, pointer }));

const specNotFound = () =>
  apiError({ code: "NOT_FOUND", message: "Event spec not found", suggestedFix: "Check the event spec id." });

const versionNotFound = () =>
  apiError({
    code: "NOT_FOUND",
    message: "That version of the event spec was not found",
    suggestedFix: "Omit ?version for the latest published version, or pass ?version=draft.",
  });

/** A service failure as a fixed-text response: 404 / 400 keep their meaning, everything else is a logged, generic 500. */
function serviceFailure(error: ServiceError, step: string, notFound: () => NextResponse): NextResponse {
  if (error.code === "NOT_FOUND") return notFound();
  if (error.code === "VALIDATION_ERROR") return apiError({ code: "VALIDATION_ERROR", message: "The request could not be processed" });
  console.error(`GET /api/v1/event-specs/:id ${step} failed:`, error);
  return apiServerError();
}

export async function GET(request: Request, { params }: { params: Promise<{ id: string }> }) {
  const limited = checkRateLimit(request);
  if (limited) return limited;
  const auth = await authenticateRequest(request);
  if (!auth.authenticated || !auth.context) return apiUnauthorized();
  const ctx = auth.context;

  try {
    const { id } = await params;
    const url = new URL(request.url);

    const format = url.searchParams.get("format") ?? "yaml";
    if (format !== "yaml" && format !== "json") {
      return apiError({ code: "VALIDATION_ERROR", message: 'format must be "yaml" or "json"', suggestedFix: "Use ?format=yaml (default) or ?format=json." });
    }
    const versionParam = url.searchParams.get("version");
    if (versionParam !== null && versionParam !== "draft" && !VERSION_PARAM.test(versionParam)) {
      return apiError({ code: "VALIDATION_ERROR", message: 'version must be "draft" or MAJOR.MINOR', suggestedFix: "Use e.g. ?version=2.1, ?version=draft, or omit it for the latest published version." });
    }

    // R67: the caller can only reach specs of its own tenant. Missing and foreign are indistinguishable.
    const tenantId = await getActiveTenantId();
    const owned = await ctx.prisma.eventSpec.findFirst({ where: { id, tenantId }, select: { id: true } });
    if (!owned) return specNotFound();

    let target: EmitTarget;
    if (versionParam === "draft") target = { draft: true };
    else if (versionParam !== null) {
      const label = toVersionLabel(versionParam);
      if (!label) return versionNotFound();
      target = { versionLabel: label };
    } else {
      const latest = await getLatestEventSpecVersionLabel(id, ctx);
      if (!latest.success) return serviceFailure(latest.error, "latest-version lookup", specNotFound);
      if (!latest.data) {
        return apiError({ code: "NOT_FOUND", message: "The event spec has no published version", suggestedFix: "Pass ?version=draft to emit the current draft." });
      }
      target = { versionLabel: latest.data };
    }

    const emission = await emitEventSpec(id, target, ctx);
    if (!emission.success) return serviceFailure(emission.error, "emission", "draft" in target ? specNotFound : versionNotFound);
    const { document, yaml, json, version, specName, diagnostics } = emission.data;
    if (!document || !yaml || !json) {
      return apiError({
        code: "VALIDATION_ERROR",
        message: "The draft could not be assembled into a document",
        details: { diagnostics: publicDiagnostics(diagnostics) },
        suggestedFix: "Resolve the listed diagnostics in the draft, then retry.",
      });
    }
    return new Response(format === "json" ? json : yaml, {
      status: 200,
      headers: {
        "Content-Type": CONTENT_TYPE[format],
        "Content-Disposition": `inline; filename="${fileStem(specName)}-${version}.asyncapi.${format}"`,
        "X-Event-Spec-Version": version,
        "X-Content-Type-Options": "nosniff",
        "Cache-Control": "private, no-store",
      },
    });
  } catch (e) {
    console.error("GET /api/v1/event-specs/:id error:", e);
    return apiServerError();
  }
}
