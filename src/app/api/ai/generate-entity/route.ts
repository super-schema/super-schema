import { NextResponse } from "next/server";
import { requireSession } from "@/lib/require-session";
import { prisma } from "@/lib/db";
import { getActiveTenantId } from "@/lib/active-tenant";
import { generateEntityFromDescription, isAiConfigured } from "@/services/ai.service";
import { GenerateEntityInputSchema } from "@/types/schemas/ai";

export async function POST(req: Request) {
  const denied = await requireSession();
  if (denied) return denied;

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
  const tenantId = await getActiveTenantId();
  const domain = await prisma.domain.findFirst({
    where: { id: parsed.data.domainId, tenantId },
    include: { entities: { select: { name: true } } },
  });
  if (!domain) {
    return NextResponse.json({ error: "Domain not found" }, { status: 404 });
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
}
