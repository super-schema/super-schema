"use server";

import { runMutation } from "@/lib/action-context";
import { createMessage, deleteMessage, updateMessage, type MessageInput } from "@/services/events/message.service";
import type { MessageDetail } from "@/lib/events/types";
import type { ActionResult } from "@/types/action-result";

const productOwner = (productId: string) => ({ level: "PRODUCT" as const, productId });

export async function createMessageAction(productId: string, input: MessageInput): Promise<ActionResult<MessageDetail>> {
  return runMutation((ctx) => createMessage(productId, input, ctx), "createMessageAction");
}

export async function updateMessageAction(messageId: string, productId: string, input: MessageInput): Promise<ActionResult<MessageDetail>> {
  return runMutation((ctx) => updateMessage(messageId, input, productOwner(productId), ctx), "updateMessageAction");
}

export async function deleteMessageAction(messageId: string, productId: string): Promise<ActionResult<{ id: string }>> {
  return runMutation((ctx) => deleteMessage(messageId, productOwner(productId), ctx), "deleteMessageAction");
}
