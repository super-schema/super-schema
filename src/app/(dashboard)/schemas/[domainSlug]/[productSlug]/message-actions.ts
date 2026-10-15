"use server";

import { runMutation, withOwnedTarget } from "@/lib/action-context";
import { createMessage, deleteMessage, updateMessage, type MessageInput } from "@/services/events/message.service";
import type { MessageDetail } from "@/lib/events/types";
import type { ActionResult } from "@/types/action-result";

const productOwner = (productId: string) => ({ level: "PRODUCT" as const, productId });

/**
 * The `productId` is CLIENT-supplied and the service only compares the row against it: `withOwnedTarget` first requires that
 * product to lie in the ACTIVE tenant (a foreign one is the NOT_FOUND of an unknown product and the service never runs).
 */
export async function createMessageAction(productId: string, input: MessageInput): Promise<ActionResult<MessageDetail>> {
  return runMutation((ctx) => withOwnedTarget(productOwner(productId), () => createMessage(productId, input, ctx)), "createMessageAction");
}

export async function updateMessageAction(messageId: string, productId: string, input: MessageInput): Promise<ActionResult<MessageDetail>> {
  return runMutation((ctx) => withOwnedTarget(productOwner(productId), () => updateMessage(messageId, input, productOwner(productId), ctx)), "updateMessageAction");
}

export async function deleteMessageAction(messageId: string, productId: string): Promise<ActionResult<{ id: string }>> {
  return runMutation((ctx) => withOwnedTarget(productOwner(productId), () => deleteMessage(messageId, productOwner(productId), ctx)), "deleteMessageAction");
}
