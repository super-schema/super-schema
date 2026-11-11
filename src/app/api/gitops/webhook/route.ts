import { NextResponse } from "next/server";
import { GitOpsError } from "@/lib/gitops/contracts";
import { receiveWebhook } from "@/services/gitops/sync";
export const runtime = "nodejs";
export async function POST(request: Request) {
  const reader = request.body?.getReader();
  if (!reader)
    return NextResponse.json(
      { error: "Missing webhook body" },
      { status: 400 },
    );
  const chunks: Uint8Array[] = [];
  let bytes = 0;
  try {
    for (;;) {
      const part = await reader.read();
      if (part.done) break;
      bytes += part.value.byteLength;
      if (bytes > 2 * 1024 * 1024) {
        await reader.cancel();
        return NextResponse.json(
          { error: "Webhook exceeds 2 MiB" },
          { status: 413 },
        );
      }
      chunks.push(part.value);
    }
    const queued = await receiveWebhook(
      Buffer.concat(chunks).toString("utf8"),
      request.headers.get("x-hub-signature-256"),
      request.headers.get("x-github-event") ?? "",
      request.headers.get("x-github-delivery") ?? "",
    );
    return NextResponse.json({ queued }, { status: 202 });
  } catch (e) {
    if (e instanceof GitOpsError && e.code === "UNAUTHORIZED")
      return NextResponse.json({ error: "Invalid signature" }, { status: 401 });
    if (e instanceof SyntaxError)
      return NextResponse.json(
        { error: "Invalid webhook JSON" },
        { status: 400 },
      );
    if ((e as { code?: string })?.code === "P2002")
      return NextResponse.json({ queued: 0 }, { status: 202 });
    return NextResponse.json(
      { error: "Webhook could not be queued" },
      { status: 503 },
    );
  }
}
