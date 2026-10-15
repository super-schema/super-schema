import Link from "next/link";
import { assetHref } from "@/lib/navigation/asset-href";
import { HideEmptyRightPanel } from "@/components/layout/HideEmptyRightPanel";

const linkClass =
  "inline-flex h-8 items-center rounded-lg border border-border bg-background px-space-3 text-body-small text-foreground transition-colors hover:bg-muted focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-ring";

/**
 * Rendered by every `notFound()` under the dashboard (domain / product / entity / event-asset / trait routes). It sits
 * inside the dashboard layout, so the top bar, tenant switcher and explorer stay available: an asset can vanish when the
 * active organization changes or when it is deleted elsewhere, and the user must still be able to navigate away.
 *
 * The h1 keeps Next's default 404 marker (`next-error-h1`) and copy: `tests/e2e/navigation.spec.ts` detects a rendered 404
 * by them. The phrase must appear exactly once on the page.
 */
export default function DashboardNotFound() {
  return (
    <div className="animate-auth-fade-up mx-auto flex max-w-xl flex-col items-start gap-space-4 py-space-8" data-testid="dashboard-not-found">
      <HideEmptyRightPanel />
      <p className="text-caption text-muted-foreground">Error 404</p>
      <h1 className="next-error-h1 text-display text-foreground">This page could not be found.</h1>
      <p className="text-body text-muted-foreground">
        The asset may have been deleted or renamed, or it belongs to a different organization than the one currently selected in the
        top bar. Pick another organization there, browse from the explorer, or use one of these links.
      </p>
      <nav aria-label="Where to go next" className="flex flex-wrap gap-space-2">
        <Link href="/schemas" className={linkClass}>Domains</Link>
        <Link href={assetHref({ kind: "enterprise" })} className={linkClass}>Enterprise</Link>
      </nav>
    </div>
  );
}
