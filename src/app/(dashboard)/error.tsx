"use client";

import Link from "next/link";
import { HideEmptyRightPanel } from "@/components/layout/HideEmptyRightPanel";
import { assetHref } from "@/lib/navigation/asset-href";

const buttonClass =
  "inline-flex h-8 items-center rounded-lg border border-border bg-background px-space-3 text-body-small text-foreground transition-colors hover:bg-muted focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-ring";

/**
 * Error boundary for every dashboard route. It renders inside the dashboard layout, so the top bar, tenant switcher and
 * explorer survive a render failure. The error text is deliberately never shown (it can carry server internals); only
 * the opaque digest is, so a report can be matched to the server log.
 */
export default function DashboardError({ error, reset }: { error: Error & { digest?: string }; reset: () => void }) {
  return (
    <div role="alert" className="mx-auto flex max-w-xl flex-col items-start gap-space-4 py-space-8" data-testid="dashboard-error">
      <HideEmptyRightPanel />
      <h1 className="text-display text-foreground">Something went wrong</h1>
      <p className="text-body text-muted-foreground">
        This page could not be displayed. Try again, or continue from the explorer or one of the links below.
      </p>
      {error.digest && <p className="text-caption text-muted-foreground">Reference: <code className="font-mono">{error.digest}</code></p>}
      <div className="flex flex-wrap gap-space-2">
        <button type="button" onClick={reset} className={buttonClass} data-testid="dashboard-error-retry">Try again</button>
        <Link href="/schemas" className={buttonClass}>Domains</Link>
        <Link href={assetHref({ kind: "enterprise" })} className={buttonClass}>Enterprise</Link>
      </div>
    </div>
  );
}
