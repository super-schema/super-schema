import { notFound } from "next/navigation";
import { EventSpecPage } from "@/features/events/event-specs/EventSpecPage";
import { loadEventSpecPage } from "@/features/events/event-specs/load-event-spec-page";

export default async function EventSpecRoute({
  params, searchParams,
}: {
  params: Promise<{ domainSlug: string; productSlug: string; specId: string }>;
  searchParams?: Promise<Record<string, string | string[] | undefined>>;
}) {
  const { domainSlug, productSlug, specId } = await params;
  const query = (await searchParams) ?? {};
  const pick = (v: string | string[] | undefined) => (typeof v === "string" ? v : undefined);
  const data = await loadEventSpecPage({ domainSlug, productSlug, specId, version: pick(query.version), tab: pick(query.tab) });
  if (!data) notFound();
  return <EventSpecPage {...data} />;
}
