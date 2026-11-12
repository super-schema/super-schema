import { NextResponse } from "next/server";
import { getPrincipal } from "@/lib/access/principal";
import { callbackUrl, finishGitHubLink } from "@/services/gitops/settings";
export const runtime = "nodejs";
export async function GET(request: Request) {
  const principal = await getPrincipal();
  if (!principal)
    return NextResponse.json({ error: "Not authenticated" }, { status: 401 });
  const u = new URL(request.url);
  try {
    await finishGitHubLink(
      principal.userId,
      u.searchParams.get("state") ?? "",
      u.searchParams.get("code") ?? "",
    );
    return NextResponse.redirect(
      new URL("/admin/workflows/gitops?connected=github", callbackUrl()),
    );
  } catch {
    return NextResponse.json(
      {
        error:
          "GitHub linking failed. Return to GitOps and restart Connect GitHub.",
      },
      { status: 400 },
    );
  }
}
