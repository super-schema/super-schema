import { notFound } from "next/navigation";
import { EventPage } from "@/features/events/event-page/EventPage";
import { loadEventPage } from "@/features/events/event-page/load-event-page";

export default async function EventRoute({
  params, searchParams,
}: {
  params: Promise<{ domainSlug: string; productSlug: string; eventId: string }>;
  searchParams?: Promise<Record<string, string | string[] | undefined>>;
}) {
  const { domainSlug, productSlug, eventId } = await params;
  const query = (await searchParams) ?? {};
  const pick = (v: string | string[] | undefined) => (typeof v === "string" ? v : undefined);
  const data = await loadEventPage({
    domainSlug, productSlug, eventId, tab: pick(query.tab), section: pick(query.section), item: pick(query.item), version: pick(query.version),
  });
  if (!data) notFound();
  return <EventPage data={data} />;
}
