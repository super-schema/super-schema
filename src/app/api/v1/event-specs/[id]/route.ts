/**
 * GET /api/v1/event-specs/:id?version=<MAJOR.MINOR|draft>&format=yaml|json (spec §7.4, Story 18.7).
 * `:id` is the id of a self-contained event (document v2); the path keeps its published name.
 *
 * version omitted → latest published version (404 when never published; pass version=draft);
 * a published version is the stored document, never regenerated (spec §7.2 step 1).
 * The body is the raw AsyncAPI document; errors use the v1 JSON error envelope.
 *
 * Tenant scoping (R67): the emit service checks that the event belongs to the product it is given, but trusts the id, so
 * this route resolves the caller's tenant (`withApiAuth`: a session's active tenant, the API key's) and looks the event up inside it
 * BEFORE any other read (the product it passes on is the event's own), then asks the policy whether a role of the caller covers the
 * event's own domain and product (`event.read`). An event of another tenant, one no role of theirs covers and an event that does not
 * exist produce the same 404 — nothing downstream runs, nothing in the body depends on which case it was.
 *
 * Error bodies never carry service / database text: ServiceError codes are mapped to a status and a fixed message
 * (the original is logged server-side); only already-sanitised draft diagnostics are returned, field-whitelisted.
 */
import type { NextResponse } from "next/server";
import { checkRateLimit } from "@/app/api/v1/rate-limit";
import { isUsableId, optionalParam, queryProblem } from "@/app/api/v1/request";
import { apiError, apiServerError } from "@/app/api/v1/error-handler";
import { withApiAuth } from "@/lib/access/api";
import { ctxCan } from "@/lib/access";
import { formatVersionLabel } from "@/lib/entity-versioning/version-math";
import type { Diagnostic } from "@/lib/event-specs";
import { emitEventDraft, emitEventStoredVersion, type EventEmission } from "@/services/events/event-emit.service";
import type { Result, ServiceError } from "@/types/result";

const CONTENT_TYPE = { yaml: "application/yaml; charset=utf-8", json: "application/json; charset=utf-8" } as const;
const VERSION_PARAM = /^(\d+)\.(\d+)$/;
/** `EventSpecVersion.major` / `.minor` are Postgres `integer`; anything larger cannot exist (and would make the driver throw). */
const MAX_VERSION_PART = 2_147_483_647;
const MAX_STEM_LENGTH = 100;
const FALLBACK_STEM = "event-spec";
const DRAFT = "draft";

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

export const GET = withApiAuth<{ id: string }>("event.read", async (request, api, { params }) => {
  const ctx = api.ctx;

  try {
    const { id } = await params;
    // PostgreSQL text holds no NUL byte: an id with one cannot be an event's, and the lookup would throw.
    if (!isUsableId(id)) return specNotFound();
    const url = new URL(request.url);
    const bad = queryProblem(url);
    if (bad) return bad;

    // An empty parameter is no parameter: `?format=` is the default format, `?version=` the latest published version.
    const format = optionalParam(url, "format") ?? "yaml";
    if (format !== "yaml" && format !== "json") {
      return apiError({ code: "VALIDATION_ERROR", message: 'format must be "yaml" or "json"', suggestedFix: "Use ?format=yaml (default) or ?format=json." });
    }
    const versionParam = optionalParam(url, "version");
    if (versionParam !== undefined && versionParam !== "draft" && !VERSION_PARAM.test(versionParam)) {
      return apiError({ code: "VALIDATION_ERROR", message: 'version must be "draft" or MAJOR.MINOR', suggestedFix: "Use e.g. ?version=2.1, ?version=draft, or omit it for the latest published version." });
    }

    // R67: the caller can only reach events of the tenant it acts in, and only those a role of theirs covers. Missing, foreign and unseen are indistinguishable.
    const tenantId = api.tenantId as string; // content action: `withApiAuth` always resolves it
    const owned = await ctx.prisma.eventSpec.findFirst({
      where: { id, tenantId },
      select: { name: true, productId: true, domainId: true, product: { select: { domainId: true } }, latestVersion: { select: { major: true, minor: true } } },
    });
    if (!owned || !owned.productId) return specNotFound();
    if (!ctxCan(ctx, "event.read", { tenantId, domainId: owned.domainId ?? owned.product?.domainId ?? null, productId: owned.productId })) return specNotFound();
    const { name: specName, productId } = owned;

    let version: string;
    if (versionParam === DRAFT) version = DRAFT;
    else if (versionParam !== undefined) {
      const label = toVersionLabel(versionParam);
      if (!label) return versionNotFound();
      version = label;
    } else {
      if (!owned.latestVersion) {
        return apiError({ code: "NOT_FOUND", message: "The event spec has no published version", suggestedFix: "Pass ?version=draft to emit the current draft." });
      }
      version = formatVersionLabel(owned.latestVersion);
    }

    const emission: Result<EventEmission> =
      version === DRAFT ? await emitEventDraft(id, productId, ctx) : await emitEventStoredVersion(id, productId, version, ctx);
    if (!emission.success) return serviceFailure(emission.error, "emission", version === DRAFT ? specNotFound : versionNotFound);
    const { document, yaml, json, diagnostics } = emission.data;
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
}, { before: (request) => checkRateLimit(request) });
