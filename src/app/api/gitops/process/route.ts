import { NextResponse } from "next/server";
import { authorizedGitOpsWorker } from "@/lib/gitops/worker-auth";
import { processGitOpsJobs } from "@/services/gitops/sync";
import { getGitOpsWorkerSettings } from "@/lib/gitops/config.mjs";
export const runtime = "nodejs";
export const maxDuration = 300;
export async function POST(request: Request) {
  if (!authorizedGitOpsWorker(request.headers.get("authorization")))
    return NextResponse.json({ error: "Unauthorized" }, { status: 401 });
  try {
    return NextResponse.json({
      processed: await processGitOpsJobs(getGitOpsWorkerSettings().batchSize),
    });
  } catch {
    return NextResponse.json(
      { error: "GitOps worker unavailable" },
      { status: 503 },
    );
  }
}
