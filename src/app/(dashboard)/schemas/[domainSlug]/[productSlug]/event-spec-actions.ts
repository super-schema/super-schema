"use server";

import { runMutation, withOwnedTarget } from "@/lib/action-context";
import {
  createEventSpec, deleteEventSpec, renameEventSpec, updateEventSpecDocument, type CreateEventSpecInput,
} from "@/services/events/event-spec.service";
import type { EventSpecDetail } from "@/lib/events/types";
import type { ActionResult } from "@/types/action-result";

const productOwner = (productId: string) => ({ level: "PRODUCT" as const, productId });

/**
 * The `productId` is CLIENT-supplied and the service only compares the row against it: `withOwnedTarget` first requires that
 * product to lie in the ACTIVE tenant (a foreign one is the NOT_FOUND of an unknown product and the service never runs).
 */
export async function createEventSpecAction(productId: string, input: CreateEventSpecInput): Promise<ActionResult<EventSpecDetail>> {
  return runMutation((ctx) => withOwnedTarget(productOwner(productId), () => createEventSpec(productId, input, ctx)), "createEventSpecAction");
}

export async function updateEventSpecDocumentAction(specId: string, productId: string, document: unknown): Promise<ActionResult<EventSpecDetail>> {
  return runMutation((ctx) => withOwnedTarget(productOwner(productId), () => updateEventSpecDocument(specId, document, productOwner(productId), ctx)), "updateEventSpecDocumentAction");
}

export async function renameEventSpecAction(specId: string, productId: string, name: string): Promise<ActionResult<EventSpecDetail>> {
  return runMutation((ctx) => withOwnedTarget(productOwner(productId), () => renameEventSpec(specId, name, productOwner(productId), ctx)), "renameEventSpecAction");
}

export async function deleteEventSpecAction(specId: string, productId: string): Promise<ActionResult<{ id: string }>> {
  return runMutation((ctx) => withOwnedTarget(productOwner(productId), () => deleteEventSpec(specId, productOwner(productId), ctx)), "deleteEventSpecAction");
}
