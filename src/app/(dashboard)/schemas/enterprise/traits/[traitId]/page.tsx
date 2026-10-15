import { TraitRoutePage } from "@/features/events/traits/TraitRoutePage";

export default async function EnterpriseTraitPage({ params }: { params: Promise<{ traitId: string }> }) {
  const { traitId } = await params;
  return <TraitRoutePage domainSlug={null} productSlug={null} traitId={traitId} />;
}
