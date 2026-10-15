import { notFound } from "next/navigation";
import { MessagePage } from "@/features/events/messages/MessagePage";
import { loadMessagePage } from "@/features/events/messages/load-message-page";

export default async function MessageRoute({
  params, searchParams,
}: {
  params: Promise<{ domainSlug: string; productSlug: string; messageId: string }>;
  searchParams?: Promise<Record<string, string | string[] | undefined>>;
}) {
  const { domainSlug, productSlug, messageId } = await params;
  const version = (await searchParams)?.version;
  const data = await loadMessagePage({ domainSlug, productSlug, messageId, version: typeof version === "string" ? version : undefined });
  if (!data) notFound();
  return <MessagePage {...data} />;
}
