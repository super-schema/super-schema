import { NextResponse } from "next/server";
import { auth } from "@/lib/auth";
import { prisma } from "@/lib/db";
import { generateEntityFromDescription, isAiConfigured } from "@/services/ai.service";
import { GenerateEntityInputSchema } from "@/types/schemas/ai";

export async function POST(req: Request) {
  const session = await auth();
  if (!session?.user?.id) {
    return NextResponse.json({ error: "Not authenticated" }, { status: 401 });
  }

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

  const domain = await prisma.domain.findUnique({
    where: { id: parsed.data.domainId },
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
