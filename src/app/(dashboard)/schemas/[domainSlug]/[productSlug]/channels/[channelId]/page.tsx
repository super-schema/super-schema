import { notFound } from "next/navigation";
import { ChannelEditor } from "@/features/events/channels/ChannelEditor";
import { loadChannelPage } from "@/features/events/channels/load-channel-page";

export default async function ChannelPage({ params }: { params: Promise<{ domainSlug: string; productSlug: string; channelId: string }> }) {
  const { domainSlug, productSlug, channelId } = await params;
  const data = await loadChannelPage({ domainSlug, productSlug, channelId });
  if (!data) notFound();
  return <ChannelEditor {...data} />;
}
