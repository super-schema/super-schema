import { timingSafeEqual } from "node:crypto";
import { processDueDeployments } from "@/services/deployment-workflow.service";

export const runtime = "nodejs";
export const maxDuration = 900;
export async function POST(request: Request) {
  const configured = process.env.DEPLOYMENT_WORKER_TOKEN;
  const supplied = request.headers.get("authorization")?.match(/^Bearer (.+)$/)?.[1] ?? "";
  const actual = Buffer.from(supplied), expected = Buffer.from(configured ?? "");
  if (!configured || actual.length !== expected.length || !timingSafeEqual(actual, expected)) return Response.json({ error: "Unauthorized" }, { status: 401 });
  try { return Response.json({ processed: await processDueDeployments(5) }); }
  catch { return Response.json({ error: "Deployment worker failed; queued work remains durable" }, { status: 500 }); }
}
