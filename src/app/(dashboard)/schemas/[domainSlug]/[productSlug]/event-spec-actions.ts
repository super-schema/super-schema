"use server";

import { runMutation } from "@/lib/action-context";
import {
  createEventSpec, deleteEventSpec, renameEventSpec, updateEventSpecDocument, type CreateEventSpecInput,
} from "@/services/events/event-spec.service";
import type { EventSpecDetail } from "@/lib/events/types";
import type { ActionResult } from "@/types/action-result";

const productOwner = (productId: string) => ({ level: "PRODUCT" as const, productId });

export async function createEventSpecAction(productId: string, input: CreateEventSpecInput): Promise<ActionResult<EventSpecDetail>> {
  return runMutation((ctx) => createEventSpec(productId, input, ctx), "createEventSpecAction");
}

export async function updateEventSpecDocumentAction(specId: string, productId: string, document: unknown): Promise<ActionResult<EventSpecDetail>> {
  return runMutation((ctx) => updateEventSpecDocument(specId, document, productOwner(productId), ctx), "updateEventSpecDocumentAction");
}

export async function renameEventSpecAction(specId: string, productId: string, name: string): Promise<ActionResult<EventSpecDetail>> {
  return runMutation((ctx) => renameEventSpec(specId, name, productOwner(productId), ctx), "renameEventSpecAction");
}

export async function deleteEventSpecAction(specId: string, productId: string): Promise<ActionResult<{ id: string }>> {
  return runMutation((ctx) => deleteEventSpec(specId, productOwner(productId), ctx), "deleteEventSpecAction");
}
