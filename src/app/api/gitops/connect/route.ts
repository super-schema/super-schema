import { NextResponse } from "next/server";
import { getPrincipal } from "@/lib/access/principal";
import { beginGitHubLink } from "@/services/gitops/settings";
export const runtime = "nodejs";
export async function GET(request: Request) {
  const principal = await getPrincipal();
  if (!principal)
    return NextResponse.json({ error: "Not authenticated" }, { status: 401 });
  try {
    return NextResponse.redirect(
      await beginGitHubLink(
        principal.userId,
        new URL(request.url).searchParams.get("returnTo") === "settings"
          ? "settings"
          : "workspace",
      ),
    );
  } catch {
    return NextResponse.json(
      {
        error: "Configure the GitHub App and AUTH_URL before connecting GitHub",
      },
      { status: 503 },
    );
  }
}
