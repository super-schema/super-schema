import { TraitRoutePage } from "@/features/events/traits/TraitRoutePage";

export default async function DomainTraitPage({ params }: { params: Promise<{ domainSlug: string; traitId: string }> }) {
  const { domainSlug, traitId } = await params;
  return <TraitRoutePage domainSlug={domainSlug} productSlug={null} traitId={traitId} />;
}
