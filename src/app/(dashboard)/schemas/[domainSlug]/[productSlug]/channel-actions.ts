"use server";

import { runMutation, sanitizeActionError } from "@/lib/action-context";
import {
  createChannel, deleteChannel, setChannelMessages, updateChannel, type ChannelInput,
} from "@/services/events/channel.service";
import type { ChannelDetail } from "@/lib/events/types";
import type { ActionResult } from "@/types/action-result";

const productOwner = (productId: string) => ({ level: "PRODUCT" as const, productId });

/**
 * Every action is `runMutation` (session + `/schemas` layout revalidation on success) around a service call whose ownership check
 * (tenant + domain + product) runs before any write. `sanitizeActionError` keeps raw database text out of the browser: the forms
 * render whatever comes back.
 */
export async function createChannelAction(productId: string, input: ChannelInput): Promise<ActionResult<ChannelDetail>> {
  return runMutation((ctx) => sanitizeActionError(createChannel(productId, input, ctx), "createChannelAction"));
}

export async function updateChannelAction(channelId: string, productId: string, input: ChannelInput): Promise<ActionResult<ChannelDetail>> {
  return runMutation((ctx) => sanitizeActionError(updateChannel(channelId, input, productOwner(productId), ctx), "updateChannelAction"));
}

export async function setChannelMessagesAction(channelId: string, productId: string, messageIds: string[]): Promise<ActionResult<ChannelDetail>> {
  return runMutation((ctx) => sanitizeActionError(setChannelMessages(channelId, messageIds, productOwner(productId), ctx), "setChannelMessagesAction"));
}

export async function deleteChannelAction(channelId: string, productId: string): Promise<ActionResult<{ id: string }>> {
  return runMutation((ctx) => sanitizeActionError(deleteChannel(channelId, productOwner(productId), ctx), "deleteChannelAction"));
}
