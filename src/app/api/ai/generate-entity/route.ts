import { NextResponse } from "next/server";
import { prisma } from "@/lib/db";
import { APP_ERRORS, withApiAuth } from "@/lib/access/api";
import { authorizePrincipal } from "@/lib/action-context";
import { generateEntityFromDescription, isAiConfigured } from "@/services/ai.service";
import { GenerateEntityInputSchema } from "@/types/schemas/ai";

/**
 * Suggest an entity for a domain from a description. The domain must be one of the tenant in view AND one the caller may write to with `ai.generate`
 * (an author of that domain or above): its name and its entity names go to the AI provider. A domain of another tenant, one no role of the caller
 * covers and one that does not exist are the same 404; a role that covers it but is too low is a 403. A user with no role at all is told 404 before
 * anything else. Answers to a session only.
 */
export const POST = withApiAuth(
  "ai.generate",
  async (req, api) => {
    if (!isAiConfigured()) {
      return NextResponse.json(
        {
          error:
            "AI generation is not configured on this server. Set AI_PROVIDER and AI_BASE_URL, or create the entity manually.",
        },
        { status: 503 }
      );
    }

    const body = await req.json().catch(() => null);
    const parsed = GenerateEntityInputSchema.safeParse(body);
    if (!parsed.success) {
      return NextResponse.json(
        { error: parsed.error.issues[0]?.message ?? "Invalid request" },
        { status: 400 }
      );
    }

    // The domain must be one of the tenant being viewed: its entity names go to the AI provider, and a domain of another tenant answers
    // exactly like one that does not exist (the same 404), so an id cannot be used to probe or to read another tenant.
    const tenantId = api.tenantId as string; // content action: `withApiAuth` always resolves it
    const domain = await prisma.domain.findFirst({
      where: { id: parsed.data.domainId, tenantId },
      include: { entities: { select: { name: true } } },
    });
    // The decision over the domain's own place: no role of the caller's covers it = "Domain not found" (as for a missing one), a role that does but is too low = 403.
    const decided = authorizePrincipal(api.principal, "ai.generate", { tenantId, domainId: domain?.id ?? parsed.data.domainId, productId: null }, { code: "NOT_FOUND", message: "Domain not found" });
    if (!domain || (!decided.success && decided.error.code === "NOT_FOUND")) {
      return NextResponse.json({ error: "Domain not found" }, { status: 404 });
    }
    if (!decided.success) {
      return NextResponse.json({ error: decided.error.message }, { status: 403 });
    }

    const result = await generateEntityFromDescription(parsed.data.description, {
      domainName: domain.name,
      existingEntityNames: domain.entities.map((e) => e.name),
    });

    if (!result.success) {
      const status = result.error.code === "AI_NOT_CONFIGURED" ? 503 : 502;
      return NextResponse.json({ error: result.error.message }, { status });
    }

    return NextResponse.json({ suggestion: result.data });
  },
  { respond: APP_ERRORS, allowApiKey: false }
);
