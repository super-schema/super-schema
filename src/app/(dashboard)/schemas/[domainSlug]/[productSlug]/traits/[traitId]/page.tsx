import { TraitRoutePage } from "@/features/events/traits/TraitRoutePage";

export default async function ProductTraitPage({ params }: { params: Promise<{ domainSlug: string; productSlug: string; traitId: string }> }) {
  const { domainSlug, productSlug, traitId } = await params;
  return <TraitRoutePage domainSlug={domainSlug} productSlug={productSlug} traitId={traitId} />;
}
