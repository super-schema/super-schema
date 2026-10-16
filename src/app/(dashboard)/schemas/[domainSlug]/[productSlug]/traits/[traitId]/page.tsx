import { redirect } from "next/navigation";
import { assetHref } from "@/lib/navigation/asset-href";

/**
 * The old product-level Trait URL: traits live inside events now (the Domain and Enterprise trait pages are unchanged), so it
 * lands on the product's Events list.
 */
export default async function ProductTraitRedirect({ params }: { params: Promise<{ domainSlug: string; productSlug: string; traitId: string }> }) {
  const { domainSlug, productSlug } = await params;
  redirect(assetHref({ kind: "events", domainSlug, productSlug }));
}
