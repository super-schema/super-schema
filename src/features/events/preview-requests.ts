import type { EventDocument } from "@/lib/events/document/types";
import type { EntityPin } from "@/lib/events/types";
import type { EventEmission } from "@/services/events/event-emit.service";
import type { ActionResult } from "@/types/action-result";

async function previewRequest<T>(body: Record<string, unknown>): Promise<ActionResult<T>> {
  const response = await fetch("/api/events/preview", {
    method: "POST",
    headers: { "Content-Type": "application/json" },
    body: JSON.stringify(body),
    signal: AbortSignal.timeout(45_000),
  });
  if (!response.ok) throw new Error("Preview request failed");
  const result: unknown = await response.json();
  if (typeof result !== "object" || result === null || !("success" in result) || typeof result.success !== "boolean") {
    throw new Error("Invalid preview response");
  }
  return result as ActionResult<T>;
}

export function requestPinJsonSchema(productId: string, pin: EntityPin): Promise<ActionResult<{ schema: Record<string, unknown> }>> {
  return previewRequest({ kind: "pin-schema", productId, pin });
}

export function requestEventPreview(eventId: string, productId: string, document: EventDocument): Promise<ActionResult<EventEmission>> {
  return previewRequest({ kind: "document", eventId, productId, document });
}
