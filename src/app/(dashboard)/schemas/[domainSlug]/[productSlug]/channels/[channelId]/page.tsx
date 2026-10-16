import { redirect } from "next/navigation";
import { assetHref } from "@/lib/navigation/asset-href";

/** The old Channel URL: channels live inside events now and no id mapping is kept, so it lands on the product's Events list. */
export default async function ChannelRedirect({ params }: { params: Promise<{ domainSlug: string; productSlug: string; channelId: string }> }) {
  const { domainSlug, productSlug } = await params;
  redirect(assetHref({ kind: "events", domainSlug, productSlug }));
}
