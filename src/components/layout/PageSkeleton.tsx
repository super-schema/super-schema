import { cn } from "@/lib/utils";

export type PageSkeletonVariant = "grid" | "workspace" | "entity";

const pulse = "animate-pulse rounded-md bg-muted/70";

function Bar({ className }: { className?: string }) {
  return <div className={cn(pulse, className)} />;
}

function Header() {
  return (
    <div className="mb-space-4 space-y-space-2">
      <Bar className="h-8 w-64" />
      <Bar className="h-4 w-96 max-w-full bg-muted/40" />
    </div>
  );
}

function CardGrid({ count }: { count: number }) {
  return (
    <div className="grid grid-cols-1 md:grid-cols-2 xl:grid-cols-3 gap-space-4">
      {Array.from({ length: count }).map((_, index) => (
        <div
          key={index}
          data-testid="skeleton-card"
          className="space-y-space-3 rounded-lg border border-border/60 p-space-4"
        >
          <Bar className="h-5 w-2/3" />
          <Bar className="h-4 w-full bg-muted/40" />
          <Bar className="h-4 w-1/2 bg-muted/40" />
        </div>
      ))}
    </div>
  );
}

function Tabs() {
  return (
    <div
      data-testid="skeleton-tabs"
      className="mb-space-6 flex items-center gap-space-4 border-b border-border pb-space-2"
    >
      {["w-20", "w-24", "w-16"].map((width) => (
        <Bar key={width} className={cn("h-5", width)} />
      ))}
    </div>
  );
}

function FieldRows({ count }: { count: number }) {
  return (
    <div className="space-y-space-2">
      {Array.from({ length: count }).map((_, index) => (
        <div
          key={index}
          data-testid="skeleton-field-row"
          className="flex items-center gap-space-3 rounded-lg border border-border/60 p-space-3"
        >
          <Bar className="h-4 w-4 shrink-0" />
          <Bar className="h-4 w-40" />
          <Bar className="h-4 flex-1 bg-muted/40" />
          <Bar className="h-5 w-16" />
        </div>
      ))}
    </div>
  );
}

/**
 * Route-level loading placeholder shared by every `loading.tsx` under
 * `/schemas`. It paints instantly on navigation (before the server render
 * resolves) so a sidebar click never looks frozen.
 *
 * - `grid`: header + card grid (domain / product lists)
 * - `workspace`: header + tab strip + card grid (domain, product, Enterprise)
 * - `entity`: header + tab strip + field rows (entity workspace)
 */
export function PageSkeleton({ variant = "workspace" }: { variant?: PageSkeletonVariant }) {
  return (
    <div
      data-testid="page-skeleton"
      data-variant={variant}
      role="status"
      aria-busy="true"
      aria-live="polite"
    >
      <span className="sr-only">Loading…</span>
      <Header />
      {variant !== "grid" && <Tabs />}
      {variant === "entity" ? <FieldRows count={8} /> : <CardGrid count={6} />}
    </div>
  );
}
