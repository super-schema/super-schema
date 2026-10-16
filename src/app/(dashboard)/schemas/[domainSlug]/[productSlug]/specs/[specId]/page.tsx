import { redirect } from "next/navigation";
import { assetHref } from "@/lib/navigation/asset-href";

/**
 * The old Event Spec URL. Events are self-contained now (`<product>/events/<id>`), so the same id moves there. A stored legacy
 * (v1) spec has no event page: the event route answers 404 for it until the legacy-data migration. The old page's `?version=` and
 * `?tab=` have no equivalent and are dropped.
 */
export default async function EventSpecRedirect({ params }: { params: Promise<{ domainSlug: string; productSlug: string; specId: string }> }) {
  const { domainSlug, productSlug, specId } = await params;
  redirect(assetHref({ kind: "event", id: specId, domainSlug, productSlug }));
}
