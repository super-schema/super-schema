import { redirect } from "next/navigation";
import { assetHref } from "@/lib/navigation/asset-href";

/** The old Message URL: messages live inside events now and no id mapping is kept, so it lands on the product's Events list. */
export default async function MessageRedirect({ params }: { params: Promise<{ domainSlug: string; productSlug: string; messageId: string }> }) {
  const { domainSlug, productSlug } = await params;
  redirect(assetHref({ kind: "events", domainSlug, productSlug }));
}
