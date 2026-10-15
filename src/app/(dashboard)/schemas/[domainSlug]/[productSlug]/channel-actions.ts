"use server";

import { runMutation } from "@/lib/action-context";
import {
  createChannel, deleteChannel, setChannelMessages, updateChannel, type ChannelInput,
} from "@/services/events/channel.service";
import type { ChannelDetail } from "@/lib/events/types";
import type { ActionResult } from "@/types/action-result";

const productOwner = (productId: string) => ({ level: "PRODUCT" as const, productId });

export async function createChannelAction(productId: string, input: ChannelInput): Promise<ActionResult<ChannelDetail>> {
  return runMutation((ctx) => createChannel(productId, input, ctx));
}

export async function updateChannelAction(channelId: string, productId: string, input: ChannelInput): Promise<ActionResult<ChannelDetail>> {
  return runMutation((ctx) => updateChannel(channelId, input, productOwner(productId), ctx));
}

export async function setChannelMessagesAction(channelId: string, productId: string, messageIds: string[]): Promise<ActionResult<ChannelDetail>> {
  return runMutation((ctx) => setChannelMessages(channelId, messageIds, productOwner(productId), ctx));
}

export async function deleteChannelAction(channelId: string, productId: string): Promise<ActionResult<{ id: string }>> {
  return runMutation((ctx) => deleteChannel(channelId, productOwner(productId), ctx));
}
