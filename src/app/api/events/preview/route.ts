import { pinJsonSchemaAction, previewEventDocumentAction } from "@/app/(dashboard)/schemas/[domainSlug]/[productSlug]/event-actions";
import type { EntityPin } from "@/lib/events/types";

export const runtime = "nodejs";
const MAX_REQUEST_BYTES = 1024 * 1024;
const invalid = () => Response.json({ success: false, error: "Invalid preview request", code: "VALIDATION_ERROR" }, { status: 400 });

/** Read-only compiler requests use HTTP so they cannot queue ahead of Save draft in the Server Action dispatcher. */
export async function POST(request: Request): Promise<Response> {
  let body: unknown;
  try {
    const reader = request.body?.getReader();
    if (!reader) return invalid();
    const chunks: Uint8Array[] = [];
    let size = 0;
    while (true) {
      const { value, done } = await reader.read();
      if (done) break;
      size += value.byteLength;
      if (size > MAX_REQUEST_BYTES) {
        await reader.cancel();
        return Response.json({ success: false, error: "Preview request is too large", code: "TOO_LARGE" }, { status: 413 });
      }
      chunks.push(value);
    }
    body = JSON.parse(Buffer.concat(chunks).toString("utf8"));
  } catch {
    return invalid();
  }
  if (typeof body !== "object" || body === null || Array.isArray(body)) return invalid();
  const input = body as Record<string, unknown>;
  if (typeof input.productId !== "string" || !input.productId.trim()) return invalid();
  // Calling these functions on the server preserves their active-tenant, product and entity/closure read guards.
  if (input.kind === "pin-schema") return Response.json(await pinJsonSchemaAction(input.productId, input.pin as EntityPin));
  if (input.kind === "document" && typeof input.eventId === "string" && input.eventId.trim()) {
    return Response.json(await previewEventDocumentAction(input.eventId, input.productId, input.document));
  }
  return invalid();
}
