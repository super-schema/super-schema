import { notFound } from "next/navigation";
import { TraitEditor } from "./TraitEditor";
import { loadTraitPage } from "./load-trait-page";

/** One server component for the three trait URLs (Enterprise / domain / product, spec §4.5). */
export async function TraitRoutePage({ domainSlug, productSlug, traitId }: { domainSlug: string | null; productSlug: string | null; traitId: string }) {
  const data = await loadTraitPage({ domainSlug, productSlug, traitId });
  if (!data) notFound();
  return <TraitEditor {...data} />;
}
